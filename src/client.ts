import { buildJevRequest, parseJevResponse } from './request.js';
import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.js';

/** JevClient 的连接选项。 / Connection options for `JevClient`. */
export interface JevClientOptions {
  /** Defaults to `process.env.TYPESAFE_API_KEY`.
   *  默认取 `process.env.TYPESAFE_API_KEY`。 */
  apiKey?: string;
  /** Defaults to `jev-latest`.
   *  默认 `jev-latest`。 */
  model?: string;
  /** Defaults to the System One endpoint.
   *  默认使用 System One 端点（`https://api.typesafe.ai/v1/systemone`）。 */
  baseUrl?: string;
  /** Defaults to the global `fetch`.
   *  默认使用全局 `fetch`。 */
  fetch?: typeof fetch;
}

/** Asks Jev over HTTP with the global `fetch` (or an injected one).
 *  使用全局 `fetch`（或注入的 fetch 实现）通过 HTTP 向 Jev 提问。
 *
 *  本类实现 `JevAsker`，是库默认的传输层：
 *  它只负责拼请求、发请求和校验响应，具体的压缩逻辑在 `compact` 中。
 *  测试时注入 `fetch` 即可完全离线运行。
 */
export class JevClient implements JevAsker {
  private readonly apiKey: string;
  private readonly model: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly fetcher: typeof fetch;

  /** 读取选项并回退到默认值；密钥缺失时先留空串，等到真正请求时再报错。
   *  Reads the options and falls back to defaults; a missing key stays an empty
   *  string here and is reported when a request is actually made. */
  constructor(options: JevClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY ?? '';
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.fetcher = options.fetch ?? fetch;
  }

  /** 发送一批问题并返回 Jev 响应；无密钥时立即抛错，避免带着空 `Authorization` 发请求。
   *  Sends one batch of questions and returns Jev's response; throws right away
   *  without a key, instead of sending an empty `Authorization` header.
   *
   *  响应由 `parseJevResponse` 校验，格式错误会转成普通异常，由调用方决定回退策略。
   */
  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    if (!this.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
    const request = buildJevRequest(
      { apiKey: this.apiKey, model: this.model, baseUrl: this.baseUrl },
      state,
      questions,
    );
    // 使用 fetch 发送请求
    const response = await this.fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    return parseJevResponse(response.status, response.ok, await response.text());
  }
}
