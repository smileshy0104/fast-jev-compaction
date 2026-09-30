import type { JevAnswer, JevQuestions, JevResponse, JevState } from './types.js';

/** System One（Jev）服务的默认端点。 / Default endpoint of the System One (Jev) service. */
export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
/** 默认模型名。 / Default model name. */
export const DEFAULT_MODEL = 'jev-latest';

/** 一次 Jev 调用的完整 HTTP 请求描述，可交给任何 fetch 风格的传输层。 / Full description of one Jev HTTP request, usable with any fetch-like transport. */
export interface JevRequest {
  /** 请求地址。 / Request URL. */
  url: string;
  /** 固定为 POST。 / Always POST. */
  method: 'POST';
  /** 请求头（含鉴权与 content-type）。 / Request headers (authorization and content-type). */
  headers: Record<string, string>;
  /** 已序列化的请求体（JSON 字符串）。 / The serialised request body (a JSON string). */
  body: string;
}

/** The HTTP request for one Jev call, for any fetch-like transport.
 *  构造一次 Jev 调用的 HTTP 请求，可交给任意 fetch 风格的传输层。
 *
 *  只做纯粹的请求组装，不发起网络调用，因此便于在测试中断言请求内容。
 *  `model` 与 `baseUrl` 省略时分别回退到 `DEFAULT_MODEL` 和 `SYSTEM_ONE_URL`。
 */
export function buildJevRequest(
  params: {
    /** TypeSafe API 密钥，放入 `Authorization: Bearer`。 / TypeSafe API key, sent as `Authorization: Bearer`. */
    apiKey: string;
    /** 模型名，默认 `jev-latest`。 / Model name, defaults to `jev-latest`. */
    model?: string;
    /** 服务端点，默认 System One。 / Service endpoint, defaults to System One. */
    baseUrl?: string;
  },
  state: JevState,
  questions: JevQuestions,
): JevRequest {
  return {
    url: params.baseUrl ?? SYSTEM_ONE_URL,
    method: 'POST',
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: params.model ?? DEFAULT_MODEL,
      state,
      questions,
    }),
  };
}

/**
 * 在响应进入压缩逻辑前校验不可信的 HTTP 返回值。
 * 严格校验可以将格式错误或不完整的模型输出转换为普通异常，
 * 从而让 Claude Code hook 使用安全的回退方案。
 *
 * Validates the untrusted HTTP response before it reaches the compaction logic.
 * Strict validation turns malformed or incomplete model output into a plain
 * exception, so the Claude Code hook can fall back safely.
 *
 * @param status HTTP 状态码，仅用于错误信息。 / HTTP status code, used in the error message only.
 * @param ok     响应是否成功（HTTP 2xx）。 / Whether the response succeeded (HTTP 2xx).
 * @param text   原始响应体文本。 / Raw response body text.
 */
export function parseJevResponse(
  status: number,
  ok: boolean,
  text: string,
): JevResponse {
  if (!ok) {
    throw new Error(`Jev request failed (${status}): ${text.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Jev returned malformed JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('answers' in parsed) ||
    parsed.answers === null ||
    typeof parsed.answers !== 'object'
  ) {
    throw new Error('Jev response is missing answers');
  }
  return parsed as JevResponse;
}

/**
 * 提取一个数值类型的 `noul` 答案。
 * 缺失答案或非有限数值都必须视为异常；如果静默当成 0，可能误删有价值的历史。
 *
 * Extracts one numeric `noul` answer. A missing answer or a non-finite number is
 * an error: quietly treating it as 0 could delete valuable history.
 *
 * @param answers 问题名到答案的映射。 / Map of question name to answer.
 * @param name    问题名（如 `call_t1`、`result_t1`）。 / Question name (e.g. `call_t1`, `result_t1`).
 * @returns 0~1 之间的保留概率。 / The keep probability in [0, 1].
 */
export function noulAnswer(
  answers: Record<string, JevAnswer>,
  name: string,
): number {
  const answer = answers[name];
  if (
    !answer ||
    !('noul' in answer) ||
    typeof answer.noul !== 'number' ||
    !Number.isFinite(answer.noul)
  ) {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  return answer.noul;
}
