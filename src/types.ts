/**
 * 本文件定义 fast-jev-compaction 的全部公共类型：
 * - 会话记录（Message / ToolUse / ToolResult）
 * - 工具调用配对与 Jev 判定结果（ToolCall / CallAnswer / CallDecision）
 * - 发送给 Jev 的 state（CompactionState / FittedState）
 * - 压缩选项与结果（CompactOptions / CompactResult）
 * - Jev 请求/响应协议（JevQuestion / JevAnswer / JevResponse / JevAsker）
 *
 * 注释为中英双语：英文为上游原文，中文为对应翻译。
 */

/** 会话消息的角色。 / Role of a transcript message. */
export type Role = 'user' | 'assistant';

/**
 * A tool_use block of an assistant message. `text` and `isError` mirror the
 * outcome once the transcript holds it (Claude Code attaches them).
 *
 * 助手消息中的一个 tool_use 块。`text` 与 `isError` 反映会话记录中已有的结果
 *（由 Claude Code 附加）。
 */
export interface ToolUse {
  /** tool_use 块的唯一 id，用于与对应的 tool_result 配对。 / Unique id of the tool_use block, used to pair with its tool_result. */
  tool_use_id: string;
  /** 工具名（如 `Read`、`Bash`）。 / Tool name (e.g. `Read`, `Bash`). */
  tool: string;
  /** 工具的输入参数。 / The tool's input arguments. */
  input: Record<string, unknown>;
  /** 可选的结果文本。 / Optional result text. */
  text?: string;
  /** 该次调用是否以错误结束。 / Whether the call ended in an error. */
  isError?: boolean;
}

/** A tool_result block of a user message.
 *  用户消息中的一个 tool_result 块。 */
export interface ToolResult {
  /** 与之配对的 tool_use id。 / The tool_use id this result pairs with. */
  tool_use_id: string;
  /** 结果的完整文本。 / Full text of the result. */
  text: string;
  /** 该结果是否为错误。 / Whether this result is an error. */
  isError?: boolean;
}

/**
 * One transcript message. The shape is a subset of Claude Code's
 * `SessionMessage`, so a session transcript can be passed in as is.
 *
 * 一条会话消息。其结构是 Claude Code `SessionMessage` 的子集，
 * 因此会话记录可以直接传入。
 */
export interface Message {
  /** 消息角色。 / Message role. */
  role: Role;
  /** 消息中的纯文本内容。 / Plain text content of the message. */
  text: string;
  /** 该消息包含的工具调用（可为空数组）。 / Tool calls contained in the message (may be an empty array). */
  toolUses: ToolUse[];
  /** 该消息包含的工具结果（仅 user 消息会有）。 / Tool results contained in the message (only user messages have them). */
  toolResults?: ToolResult[];
}

/** A tool call paired with its result by `tool_use_id`.
 *  通过 `tool_use_id` 与其结果配对起来的一次工具调用。 */
export interface ToolCall {
  /** Short id used in the Jev state and question names (`t1`, `t2`, ...).
   *  在 Jev state 与问题名中使用的短 id（`t1`、`t2`……）。 */
  id: string;
  /** 对应的 tool_use id。 / The underlying tool_use id. */
  tool_use_id: string;
  /** 工具名。 / Tool name. */
  tool: string;
  /** 工具输入参数。 / Tool input arguments. */
  input: Record<string, unknown>;
  /** Index of the message holding the tool_use block.
   *  持有 tool_use 块的消息下标。 */
  callIndex: number;
  /** Index of the message holding the tool_result block.
   *  持有 tool_result 块的消息下标。 */
  resultIndex: number;
  /** 结果文本的字符数（不加载全文，仅用于估算）。 / Character count of the result text (used for estimation without loading it). */
  resultChars: number;
  /** 结果是否为错误。 / Whether the result is an error. */
  isError: boolean;
  /** In the first or the newest preserved messages; never a candidate.
   *  位于第一条消息或最新的保留消息中；永远不会成为候选。 */
  pinned: boolean;
}

/** Jev 对一次调用给出的两个概率。 / Jev's two probabilities for one call. */
export interface CallAnswer {
  /** Jev's probability that the call itself still matters.
   *  Jev 给出的「调用本身仍然重要」的概率。 */
  keepCall: number;
  /** Jev's probability that the full result still needs to stay verbatim.
   *  Jev 给出的「完整结果仍需逐字保留」的概率。 */
  keepResult: number;
}

/** 依据阈值得出的最终动作。 / Final action derived from the thresholds.
 *  - `keep`：调用与结果都保留
 *  - `drop_result`：保留调用，截断/丢弃结果
 *  - `drop_call`：调用与结果一起删除 */
export type CallAction = 'keep' | 'drop_result' | 'drop_call';

/** 一次调用的完整判定记录（概率 + 动作 + 原因）。 / Full decision record for one call (probabilities + action + reason). */
export interface CallDecision extends CallAnswer {
  /** 调用短 id。 / Short call id. */
  id: string;
  /** 工具名。 / Tool name. */
  tool: string;
  /** 最终执行的动作。 / The action finally applied. */
  action: CallAction;
  /** 动作原因：固定、保留、结果被丢弃、调用被删除。 / Why: pinned, kept, result dropped, or call dropped. */
  reason: 'pinned' | 'kept' | 'result_dropped' | 'call_dropped';
}

/** 发往 Jev 的 state 中，一次工具调用的精简表示。 / Condensed representation of one tool call inside the state sent to Jev. */
export interface HistoryToolCall {
  /** 调用短 id。 / Short call id. */
  id: string;
  /** 工具名。 / Tool name. */
  tool: string;
  /** 已截断/节略的输入表示。 / Truncated/abridged rendering of the input. */
  input: string;
  /** 已截断/节略的结果表示。 / Truncated/abridged rendering of the result. */
  result: string;
}

/** state 中的一条历史记录。 / One entry of the history inside the state. */
export interface HistoryEntry {
  /** 原会话中的消息下标。 / Index of the message in the original transcript. */
  i: number;
  /** 消息角色。 / Message role. */
  role: Role;
  /** 文本内容（可能被节略）。 / Text content (possibly abridged). */
  text: string;
  /** Structured per call, or one compact line per call once the state has to shrink.
   *  按调用给出的结构化表示；当 state 需要收缩时，改为每个调用一行紧凑文本。 */
  tool_calls?: HistoryToolCall[] | string[];
}

/** The state sent with every Jev request: the whole history, results omitted.
 *  每次 Jev 请求都会携带的 state：完整历史，工具结果被省略。 */
export interface CompactionState {
  /** 会话/项目上下文说明。 / Context description of the session/project. */
  context: string;
  /** 当前任务目标。 / The ongoing task goal. */
  goal: string;
  /** 从旧到新的历史记录。 / History entries, oldest first. */
  history: HistoryEntry[];
}

/** state 经过分阶段适配后的结果。 / Result of fitting the state through the staged shrink process. */
export interface FittedState {
  /** 适配后的 state。 / The fitted state. */
  state: CompactionState;
  /** 估算出的 token 数。 / Estimated token count. */
  tokens: number;
  /** Which fitting stage produced the state, for diagnostics.
   *  产出该 state 的适配阶段，用于诊断。 */
  stage: string;
}

/** 压缩可调选项。 / Tunable compaction options. */
export interface CompactOptions {
  /** Ongoing task description; defaults to the last few user prompts.
   *  当前任务描述；默认取最后几条用户提示。 */
  goal?: string;
  /** Minimum keep probability for a call or result to stay. Default 0.5.
   *  调用或结果得以保留所需的最低保留概率。默认 0.5。 */
  keepThreshold?: number;
  /** Newest messages never touched (the first message is always kept). Default 6.
   *  永不改动的最新消息条数（第一条消息总是保留）。默认 6。 */
  preserveRecentMessages?: number;
  /** Estimated token ceiling for the state. Default 25000.
   *  state 的估算 token 上限。默认 25000。 */
  maxStateTokens?: number;
  /** Estimated token ceiling for state plus one batch of questions. Default 30000.
   *  state 加一批问题的估算 token 上限。默认 30000。 */
  maxRequestTokens?: number;
  /** Characters of a dropped tool result to retain. Default 300.
   *  被丢弃的工具结果中保留的字符数。默认 300。 */
  truncateHeadChars?: number;
}

/** 已填好默认值的选项，内部使用。 / Options with defaults resolved, used internally. */
export interface ResolvedCompactOptions {
  goal: string;
  keepThreshold: number;
  preserveRecentMessages: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  truncateHeadChars: number;
}

/** 一次压缩的完整结果。 / Full result of one compaction run. */
export interface CompactResult {
  /** The compacted transcript; untouched messages are the input objects.
   *  压缩后的会话记录；未被改动的消息就是传入的原始对象。 */
  messages: Message[];
  /** 每个（非固定）调用的判定。 / Decisions for every non-pinned call. */
  decisions: CallDecision[];
  /** 统计信息，用于观测与决定是否值得压缩。 / Statistics for observability and for deciding whether compaction was worthwhile. */
  stats: {
    /** 压缩前的消息数。 / Message count before. */
    messagesBefore: number;
    /** 压缩后的消息数。 / Message count after. */
    messagesAfter: number;
    /** 压缩前的字符数。 / Character count before. */
    charsBefore: number;
    /** 压缩后的字符数。 / Character count after. */
    charsAfter: number;
    /** 参与判定的调用总数。 / Total number of calls considered. */
    calls: number;
    /** 被保留的调用数。 / Number of calls kept. */
    kept: number;
    /** 结果被丢弃（截断）的调用数。 / Number of calls whose results were dropped/truncated. */
    resultsDropped: number;
    /** 调用与结果一起被删除的数量。 / Number of calls dropped together with their results. */
    callsDropped: number;
    /** 被固定的调用数。 / Number of pinned calls. */
    pinned: number;
    /** state 的估算 token 数。 / Estimated token count of the state. */
    stateTokens: number;
    /** Which fitting stage the state needed, '' when no request was made.
     *  state 所需的适配阶段；未发起任何请求时为空字符串。 */
    stateStage: string;
    /** 发起的 Jev 请求数。 / Number of Jev requests made. */
    requests: number;
    /** 总耗时（毫秒）。 / Total elapsed time in milliseconds. */
    ms: number;
  };
}

/** The `state` of a Jev request: a string or any JSON-serialisable object.
 *  Jev 请求中的 `state`：字符串或任意可 JSON 序列化的对象。 */
export type JevState = string | object;

/** 二值（是/否）问题：Jev 返回 0~1 的概率。 / Binary (yes/no) question: Jev returns a probability in [0, 1]. */
export interface NoulQuestion {
  type: 'noul';
  /** 提问指令，描述要判断什么。 / Instruction describing what to judge. */
  instructions: string;
  /** 可选的判定标准说明。 / Optional explanation of the criteria. */
  criteria?: {
    true?: string;
    false?: string;
  };
}

/** 多选一问题。 / Single-choice question. */
export interface ChoiceQuestion {
  type: 'choice';
  /** 提问指令。 / The instruction. */
  instructions: string;
  /** 选项名到选项说明的映射；值为 null 表示无额外说明。 / Map of option name to its description; null means no extra description. */
  criteria: Record<string, string | null>;
}

/** 打分问题（0~1 的评分）。 / Scoring question (a score in [0, 1]). */
export interface ScoreQuestion {
  type: 'score';
  /** 提问指令。 / The instruction. */
  instructions: string;
  /** 打分维度说明。 / Description of the scoring criteria. */
  criteria: string[];
}

/** 任意一种 Jev 问题。 / Any kind of Jev question. */
export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
/** 问题名 → 问题 的映射，一次请求可包含多个问题。 / Map of question name to question; one request may contain many questions. */
export type JevQuestions = Record<string, JevQuestion>;

/** noul 问题的答案：`noul` 为 0~1 的概率。 / Answer to a noul question: `noul` is a probability in [0, 1]. */
export interface NoulAnswer {
  type?: 'noul';
  noul: number;
}

/** choice 问题的答案。 / Answer to a choice question. */
export interface ChoiceAnswer {
  type?: 'choice';
  /** 被选中的选项名。 / The chosen option name. */
  choice: string;
  /** 该选项的置信度。 / Confidence in that choice. */
  confidence: number;
  /** 各选项的概率分布。 / Probability distribution over the options. */
  probabilities: Record<string, number>;
}

/** score 问题的答案。 / Answer to a score question. */
export interface ScoreAnswer {
  type?: 'score';
  /** 评分，0~1。 / The score, in [0, 1]. */
  score: number;
  /** 评分的置信度。 / Confidence in the score. */
  confidence: number;
  /** 各档位的概率分布。 / Probability distribution over the buckets. */
  probabilities: Record<string, number>;
}

/** 任意一种 Jev 答案（按问题类型区分）。 / Any kind of Jev answer (discriminated by question type). */
export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** Jev 的一次完整响应。 / One complete Jev response. */
export interface JevResponse {
  /** 实际使用的模型名。 / The model actually used. */
  model?: string;
  /** 问题名 → 答案。 / Map of question name to answer. */
  answers: Record<string, JevAnswer>;
  /** token 用量统计。 / Token usage statistics. */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  /** 允许携带其他未声明的字段。 / Allows other, undeclared fields. */
  [key: string]: unknown;
}

/** Anything that can answer Jev questions: `JevClient`, or a host-provided adapter.
 *  任何能回答 Jev 问题的实现：`JevClient`，或由宿主提供的适配器。 */
export interface JevAsker {
  /** 提交 state 与问题，返回 Jev 的响应。 / Submit the state and questions, and return Jev's response. */
  ask(state: JevState, questions: JevQuestions): Promise<JevResponse>;
}
