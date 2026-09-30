import { noulAnswer } from './request.js';
import { collectToolCalls, estimateTokens, fitState } from './state.js';
import type {
  CallAnswer,
  CallDecision,
  CompactOptions,
  CompactResult,
  CompactionState,
  JevAsker,
  JevQuestions,
  Message,
  ResolvedCompactOptions,
  ToolCall,
  ToolUse,
} from './types.js';

/** 各项默认值，同时作为 `resolveOptions` 的回退来源。 / The defaults, also the fallback source for `resolveOptions`. */
export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  /** 默认空串表示「没有显式目标」，此时改用最后几条用户提示。 / An empty string means "no explicit goal", so the last few user prompts are used. */
  goal: '',
  /** 默认阈值 0.5。 / Default threshold 0.5. */
  keepThreshold: 0.5,
  /** 默认保留最新 6 条消息不做改动。 / The newest 6 messages are preserved by default. */
  preserveRecentMessages: 6,
  /** state 的估算 token 上限。 / Estimated token ceiling for the state. */
  maxStateTokens: 25_000,
  /** 单次请求（state + 一批问题）的估算 token 上限。 / Estimated token ceiling for one request (state + one batch of questions). */
  maxRequestTokens: 30_000,
  /** 结果被丢弃时保留的前缀字符数。 / Characters of the head retained when a result is dropped. */
  truncateHeadChars: 300,
};

/** Tokens the request envelope (`model`, key names) adds around state and questions.
 *  请求外壳（`model` 字段、问题键名）在 state 与问题之外额外占用的 token 数。 */
const REQUEST_OVERHEAD_TOKENS = 20;

/** 只接受有限数值，否则回退；用于过滤 `NaN`、`Infinity` 等非法输入。 / Accepts only finite numbers, else falls back; filters out `NaN`, `Infinity`, etc. */
function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 把用户传入的（可能不完整、可能越界的）选项补全并夹紧为合法值。
 *  Fills in and clamps user-supplied options (possibly missing or out of range).
 *
 *  - 计数类（`preserveRecentMessages`、`truncateHeadChars`）取整且不小于 0；
 *  - token 上限不小于 1，避免出现预算为 0 的请求。
 */
export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  return {
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    keepThreshold: finite(options.keepThreshold, DEFAULT_OPTIONS.keepThreshold),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(
        finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages),
      ),
    ),
    maxStateTokens: Math.max(1, finite(options.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens)),
    maxRequestTokens: Math.max(
      1,
      finite(options.maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens),
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars)),
    ),
  };
}

/** The two `noul` questions asked about one call: keep the call, keep its result.
 *  针对一次调用提出的两个 `noul` 问题：调用本身是否保留、其结果是否逐字保留。
 *
 *  问题名固定为 `call_<id>` 与 `result_<id>`，`<id>` 即 `ToolCall.id`（形如 `t1`）。
 *  注意：提问文本会随 state 一起发给 Jev，因此属于「请求内容」而非纯注释。
 */
export function questionsFor(call: ToolCall): JevQuestions {
  return {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
    },
    [`result_${call.id}`]: {
      type: 'noul',
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
    },
  };
}

/**
 * Splits the candidate calls into batches whose questions, together with the
 * (always complete) state, fit one request.
 *
 * 把候选调用切成若干批次，使每批问题加上（每次都完整的）state 落在一次请求的预算内。
 *
 * 预算是 `maxRequestTokens - stateTokens - 请求外壳开销`。单次调用的问题若本身就超出
 * 预算，会直接抛错——此时无论怎么分批都无法完成请求。
 *
 * @param calls       待提问的调用（不含 pinned）。 / The calls to ask about (pinned ones excluded).
 * @param stateTokens state 的估算 token 数。 / Estimated token count of the state.
 * @returns 批次数组，顺序即调用的原始顺序。 / The batches, in the original call order.
 */
export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  options: Pick<ResolvedCompactOptions, 'maxRequestTokens'>,
): ToolCall[][] {
  const budget = options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentTokens = 0;
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call)));
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`,
      );
    }
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** 依据阈值把一个调用回答转换成最终判定。
 *  Turns one call's answer into a final decision, using the threshold.
 *
 *  优先级：pinned（固定，永远保留）→ `keepResult` 达标（保留调用与结果）→
 *  `keepCall` 达标（保留调用、截断结果）→ 否则调用与结果一起删除。
 */
export function decideCall(
  call: Pick<ToolCall, 'id' | 'tool' | 'pinned'>,
  answer: CallAnswer,
  options: Pick<ResolvedCompactOptions, 'keepThreshold'>,
): CallDecision {
  const base = { id: call.id, tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: 'keep', reason: 'pinned' };
  if (answer.keepResult >= options.keepThreshold) {
    return { ...base, action: 'keep', reason: 'kept' };
  }
  if (answer.keepCall >= options.keepThreshold) {
    return { ...base, action: 'drop_result', reason: 'result_dropped' };
  }
  return { ...base, action: 'drop_call', reason: 'call_dropped' };
}

/** 向 Jev 发送一批问题，并把答案整理成 `调用 id → 两个概率` 的映射。
 *  Sends one batch of questions to Jev and returns a `call id → two probabilities` map.
 *
 *  整批问题合并为一次请求；`noulAnswer` 会在答案缺失或非法时抛错，
 *  由 `compact` 的调用方负责回退。
 */
async function askBatch(
  asker: JevAsker,
  state: CompactionState,
  batch: readonly ToolCall[],
): Promise<Map<string, CallAnswer>> {
  const questions: JevQuestions = Object.assign({}, ...batch.map(questionsFor));
  const { answers } = await asker.ask(state, questions);
  return new Map(
    batch.map((call) => [
      call.id,
      {
        keepCall: noulAnswer(answers, `call_${call.id}`),
        keepResult: noulAnswer(answers, `result_${call.id}`),
      },
    ]),
  );
}

/** 把被丢弃的结果压成「前缀 + 一行说明」；短结果原样返回以避免无谓改动。
 *  Squeezes a dropped result into "head + one-line note"; short results are
 *  returned as is, to avoid pointless rewrites.
 *
 *  说明行会注明被截掉的字符数，以及是否为错误结果，提醒助手必要时重跑工具。
 */
function truncatedResultText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  return `${head}[fast-jev-compaction truncated ${text.length - headChars} chars of this tool result${
    isError ? ' (error)' : ''
  }; re-run the tool if needed]`;
}

/**
 * Rebuilds the conversation from the decisions. A dropped call disappears
 * together with its result; a dropped result keeps a bounded head and note.
 * Messages that lose all their content are removed; untouched messages are
 * returned as the same objects they came in as.
 *
 * 依据判定结果重建会话：被丢弃的调用连同其结果一起消失；结果被丢弃时仅保留
 * 有限长度的前缀与说明。内容被清空的消息会被移除；完全未被触碰的消息
 * 原样（同一对象）返回，保证引用相等，便于调用方做 diff 或缓存。
 *
 * 重建时只会「删减」，不会新增或改写文本：用户与助手的 `text` 始终逐字保留。
 * 并且任何被保留的结果都不会失去它的调用，避免产生孤立的结果块。
 *
 * @param messages  原始会话记录。 / The original transcript.
 * @param decisions 每个调用的判定。 / The decision for every call.
 * @param calls     调用与消息下标的对应关系。 / The call-to-message index mapping.
 * @param headChars 结果被截断时保留的前缀字符数。 / Head characters kept when a result is truncated.
 */
export function applyDecisions(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
): Message[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  // 以 `tool_use_id` 为键记录需要处理的调用；`keep` 不进表，等于「无操作」。
  const actions = new Map<string, CallDecision['action']>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== 'keep') actions.set(call.tool_use_id, decision.action);
  }
  const kept: Message[] = [];
  for (const message of messages) {
    // 快速路径：这条消息里没有任何需要处理的调用，直接原对象返回。
    const touched =
      message.toolUses.some((tool) => actions.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => actions.has(result.tool_use_id));
    if (!touched) {
      kept.push(message);
      continue;
    }
    const toolUses = message.toolUses
      .filter((tool) => actions.get(tool.tool_use_id) !== 'drop_call')
      .map((tool) => {
        if (actions.get(tool.tool_use_id) !== 'drop_result') return tool;
        const text = truncatedResultText(
          tool.text ?? '',
          tool.isError ?? false,
          headChars,
        );
        if ((tool.text ?? '') === text) return tool;
        // 只有内容真的变了才复制对象，尽量保持引用不变。
        const copy: ToolUse = {
          tool_use_id: tool.tool_use_id,
          tool: tool.tool,
          input: tool.input,
          text,
        };
        if (tool.isError) copy.isError = true;
        return copy;
      });
    const toolResults = (message.toolResults ?? [])
      .filter((result) => actions.get(result.tool_use_id) !== 'drop_call')
      .map((result) => {
        if (actions.get(result.tool_use_id) !== 'drop_result') return result;
        const text = truncatedResultText(result.text, result.isError ?? false, headChars);
        return text === result.text
          ? result
          : {
              tool_use_id: result.tool_use_id,
              text,
              isError: result.isError,
            };
      });
    // 没有任何调用被真正删除、且数组元素逐一相同 → 内容没有变化，沿用原对象。
    if (
      !message.toolUses.some(
        (tool) => actions.get(tool.tool_use_id) === 'drop_call',
      ) &&
      !(message.toolResults ?? []).some(
        (result) => actions.get(result.tool_use_id) === 'drop_call',
      ) &&
      toolUses.every((tool, index) => tool === message.toolUses[index]) &&
      toolResults.every(
        (result, index) => result === message.toolResults?.[index],
      )
    ) {
      kept.push(message);
      continue;
    }
    // 文本为空且工具块被清空 → 这条消息已无内容，整条移除。
    if (message.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) {
      continue;
    }
    const rebuilt: Message = { role: message.role, text: message.text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept;
}

/** Characters of text, tool input and tool output a message holds.
 *  统计一条消息包含的字符数：文本 + 工具输入（JSON 序列化后）+ 工具输出。
 *
 *  仅用于统计与收益评估（`reductionRatio`），不参与 Jev 判定。
 *  输入无法序列化时按 20 字符粗略计入。
 */
export function messageChars(message: Message): number {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) total += result.text.length;
  return total;
}

/** 压缩收益比：`(压缩前 - 压缩后) / 压缩前`，取值 0~1；空会话返回 0。
 *  Compaction gain: `(before - after) / before`, in [0, 1]; 0 for an empty transcript.
 *
 *  常用做法是设一个下限（例如 0.25），低于它就不要用压缩结果，
 *  保留原始记录或改用普通摘要。
 */
export function reductionRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

/** 按原因统计判定条数。 / Counts decisions by reason. */
function count(decisions: readonly CallDecision[], reason: CallDecision['reason']): number {
  return decisions.filter((decision) => decision.reason === reason).length;
}

/**
 * 压缩主流程：对于首条和最新消息之外的工具调用，由 Jev 判断调用本身及其结果是否需要保留。
 * 整段历史（工具结果被省略，并适配到 `maxStateTokens`）会作为 state 随每一批问题发送。
 *
 * 这里刻意分离了三个职责：
 * - `fitState`：构造仅供 Jev 使用、受 token 预算约束的历史视图；
 * - Jev：只对调用和结果进行评分，不直接修改会话；
 * - `applyDecisions`：将评分结果应用回原始消息对象。
 *
 * 这种分离保证了压缩只缩短上下文，不会重写用户/助手文本，也不会误把 Jev 的
 * 简化 state 当作真正的会话历史返回。发生错误时抛出异常，由调用方决定如何回退。
 *
 * @param messages 会话记录（不会被就地修改）。 / The transcript (never mutated in place).
 * @param asker    提问实现，通常是 `JevClient`，测试中可替换为假实现。 / The asker, usually `JevClient`; tests can substitute a fake.
 * @param options  压缩选项。 / Compaction options.
 * @returns 压缩后的消息、每个调用的判定与统计信息。 / The compacted messages, per-call decisions and stats.
 */
export async function compact(
  messages: readonly Message[],
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  // 先配对全部调用，再排除 pinned（首条与最新若干条消息内的调用永不改动）。
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned);
  const charsBefore = messages.reduce((sum, message) => sum + messageChars(message), 0);

  // 没有任何候选调用时完全不发请求：不花 API 调用，也不改动会话。
  let fitted: { tokens: number; stage: string } = { tokens: 0, stage: '' };
  let batches: ToolCall[][] = [];
  const answers = new Map<string, CallAnswer>();
  if (candidates.length > 0) {
    // state 只构造一次，并在每一批问题中复用，保证每个 Jev 决策都基于同一份完整会话。
    const state = fitState(messages, calls, resolved);
    fitted = state;
    batches = batchCalls(candidates, state.tokens, resolved);
    // 各批次彼此独立，可以并发请求以降低总耗时；下面仍按原始调用顺序生成决策。
    const answered = await Promise.all(
      batches.map((batch) => askBatch(asker, state.state, batch)),
    );
    for (const map of answered) for (const [id, answer] of map) answers.set(id, answer);
  }

  // 未被查询的调用通常是 pinned，或没有候选答案，因此默认保留。
  // 这是以安全为优先的回退策略，不应该因为缺少答案而删除历史。
  const decisions = calls.map((call) =>
    decideCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, resolved),
  );
  const kept = applyDecisions(
    messages,
    decisions,
    calls,
    resolved.truncateHeadChars,
  );
  return {
    messages: kept,
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: kept.length,
      charsBefore,
      charsAfter: kept.reduce((sum, message) => sum + messageChars(message), 0),
      calls: calls.length,
      kept: count(decisions, 'kept'),
      resultsDropped: count(decisions, 'result_dropped'),
      callsDropped: count(decisions, 'call_dropped'),
      pinned: count(decisions, 'pinned'),
      stateTokens: fitted.tokens,
      // 未发起请求（没有候选调用）时 stateStage 为空串。
      stateStage: fitted.stage,
      requests: batches.length,
      ms: Date.now() - started,
    },
  };
}
