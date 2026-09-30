import type {
  CompactionState,
  FittedState,
  HistoryEntry,
  Message,
  ResolvedCompactOptions,
  ToolCall,
  ToolResult,
} from './types.js';

/** 随请求发给 Jev 的 `context` 字段，说明 state 的结构与语义（英文原文，属于请求内容，不要翻译）。 / The `context` field sent to Jev, explaining the state's shape and semantics (kept in English: it is request content). */
export const STATE_CONTEXT =
  'A coding assistant conversation is being compacted to free context. `history` is the whole conversation so far, oldest first; tool outputs are replaced by a short `result` note and long texts may be abridged. Each question asks whether one tool call, or the full output of that call, still needs to stay in the history verbatim. Whatever is not kept is deleted permanently, but the assistant can always re-run a tool or re-read a file.';

/** Successive caps on the serialised tool input included per call.
 *  工具输入序列化后允许保留的字符上限，按阶段依次收紧。 */
const INPUT_CHARS = [1000, 200, 60] as const;
/** 长文本节略后保留的头部字符数。 / Head characters kept when abridging a long text. */
const TEXT_HEAD = 400;
/** 长文本节略后保留的尾部字符数。 / Tail characters kept when abridging a long text. */
const TEXT_TAIL = 150;

/** 分词用的正则：连续字母、连续数字、或单个其他符号。 / Tokenising pattern: runs of letters, runs of digits, or one other symbol. */
const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g;

/**
 * Estimates tokens without a tokenizer: a word costs one token per six
 * letters, a digit half a token, any other symbol nine tenths. Calibrated
 * against the usage Jev reports for real transcripts, where it lands 2–18%
 * above the true count; a plain characters-per-token ratio undercounts the
 * JSON-heavy states by up to 40%.
 *
 * 不依赖分词器的 token 估算：每六个字母算 1 个 token，每个数字算 0.5 个，
 * 其他符号各算 0.9 个。该系数是拿真实会话与 Jev 上报的用量校准出来的，
 * 结果比真实值高 2%~18%；而单纯用「字符数 / 每 token 字符数」的比值，
 * 在 JSON 密集的 state 上会低估最多 40%。
 *
 * 估算只用于预算控制，宁可略高估也不要低估（低估会导致请求超限被拒）。
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const [piece] of text.matchAll(TOKEN_PIECES)) {
    const first = piece.charCodeAt(0);
    if (first >= 48 && first <= 57) tokens += piece.length / 2;
    else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
      tokens += 1 + Math.floor((piece.length - 1) / 6);
    } else tokens += 0.9;
  }
  return Math.ceil(tokens);
}

/** 按字符数硬截断，超出时以 `…` 结尾；截断后的总长度不超过 `limit`。 / Hard-truncates by characters, ending with `…`; the result never exceeds `limit`. */
export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/** 长文本节略为「头部 + 省略说明 + 尾部」；只比阈值长一点点时原样返回，避免得不偿失。 / Abridges a long text to "head + omitted note + tail"; returns it as is when barely over the threshold. */
function abridge(text: string, head: number, tail: number): string {
  if (text.length <= head + tail + 40) return text;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n[… ${omitted} chars omitted …]\n${text.slice(-tail)}`;
}

/** 判断消息下标是否被「固定」：首条消息，或最新 `preserveRecentMessages` 条之一。 / Whether a message index is pinned: the first message, or one of the newest `preserveRecentMessages`. */
export function isPinned(
  index: number,
  total: number,
  preserveRecentMessages: number,
): boolean {
  return index === 0 || index >= total - preserveRecentMessages;
}

/**
 * Pairs every tool_use with its tool_result by `tool_use_id`. Calls without a
 * result are not candidates (there is nothing to drop yet).
 *
 * 通过 `tool_use_id` 把每个 tool_use 与其 tool_result 配对。没有结果的调用
 * 不会成为候选（此时还没有可丢弃的内容）。
 *
 * 调用 id 按出现顺序生成为 `t1`、`t2`……该 id 会出现在发给 Jev 的问题名里。
 * 只要调用侧或结果侧任一落在固定范围内，整条调用即视为固定。
 */
export function collectToolCalls(
  messages: readonly Message[],
  preserveRecentMessages: number,
): ToolCall[] {
  // 工具结果可能出现在晚于 assistant 调用的 user 消息中。
  // 先建立结果索引，再通过稳定的 tool_use_id 配对，不能依赖消息是否相邻。
  const results = new Map<string, { index: number; result: ToolResult }>();
  messages.forEach((message, index) => {
    for (const result of message.toolResults ?? []) {
      results.set(result.tool_use_id, { index, result });
    }
  });
  const calls: ToolCall[] = [];
  messages.forEach((message, callIndex) => {
    for (const tool of message.toolUses) {
      const found = results.get(tool.tool_use_id);
      if (!found) continue;
      calls.push({
        id: `t${calls.length + 1}`,
        tool_use_id: tool.tool_use_id,
        tool: tool.tool,
        input: tool.input,
        callIndex,
        resultIndex: found.index,
        resultChars: found.result.text.length,
        isError: found.result.isError ?? false,
        pinned:
          isPinned(callIndex, messages.length, preserveRecentMessages) ||
          isPinned(found.index, messages.length, preserveRecentMessages),
      });
    }
  });
  return calls;
}

/** 序列化工具输入并按上限截断；无法序列化时退化为占位文本。 / Serialises tool input and truncates it to the limit; falls back to a placeholder when it cannot be serialised. */
function inputText(input: Record<string, unknown>, limit: number): string {
  let json = '';
  try {
    json = JSON.stringify(input);
  } catch {
    json = '[unserializable input]';
  }
  return truncate(json, limit);
}

/** state 中替代工具结果的短说明，例如 `ok, 4213 chars (omitted)`。 / The short note that replaces a tool result inside the state, e.g. `ok, 4213 chars (omitted)`. */
function resultNote(call: ToolCall): string {
  return `${call.isError ? 'error' : 'ok'}, ${call.resultChars} chars (omitted)`;
}

/** One call as a single line, for when the structured form is too costly.
 *  把一次调用压成一行文本，用于结构化形式开销过大的阶段。
 *
 *  形如 `t12 Read file_path=src/a.ts → ok 480ch`：保留 id 与工具名，
 *  输入按 60 字符上限截断（`INPUT_CHARS[2]`），结果只留状态与字符数。
 */
function compactCall(call: ToolCall): string {
  const input = Object.entries(call.input)
    .map(([key, value]) => {
      const text = typeof value === 'string' ? value : inputText({ [key]: value }, 200);
      return `${key}=${text.replace(/\s+/g, ' ')}`;
    })
    .join(' ');
  return `${call.id} ${call.tool} ${truncate(input, INPUT_CHARS[2])} → ${
    call.isError ? 'error' : 'ok'
  } ${call.resultChars}ch`;
}

/**
 * Folds runs of adjacent call-only entries into one entry each, so the
 * per-entry envelope is paid once per run; the call lines keep their ids.
 *
 * 把相邻的「纯调用」条目合并成一条，让每条目的固定开销（角色、下标、JSON 包裹）
 * 每段只付一次；各调用行仍保留自己的 id。仅合并未被固定、且已处于
 * 单行文本形式的条目（合并发生在上一个阶段之后）。
 */
function mergeCallRuns(history: readonly HistoryEntry[], pinned: (e: HistoryEntry) => boolean): HistoryEntry[] {
  const merged: HistoryEntry[] = [];
  for (const entry of history) {
    const previous = merged[merged.length - 1];
    const foldable = (e: HistoryEntry): boolean =>
      !pinned(e) && e.text.length === 0 && typeof e.tool_calls?.[0] === 'string';
    if (previous && foldable(previous) && foldable(entry) && previous.role === entry.role) {
      previous.tool_calls = [...(previous.tool_calls as string[]), ...(entry.tool_calls as string[])];
      continue;
    }
    merged.push({ ...entry });
  }
  return merged;
}

/** 建立「消息下标 → 该消息中的调用列表」的索引。 / Builds the "message index → calls in that message" index. */
function callsByMessage(calls: readonly ToolCall[]): Map<number, ToolCall[]> {
  const byMessage = new Map<number, ToolCall[]>();
  for (const call of calls) {
    const list = byMessage.get(call.callIndex) ?? [];
    list.push(call);
    byMessage.set(call.callIndex, list);
  }
  return byMessage;
}

/** 把消息转成 state 的 `history`；跳过既无文本又无调用的消息。 / Turns messages into the state's `history`; skips messages with neither text nor calls. */
function historyEntries(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  inputChars: number,
): HistoryEntry[] {
  const byMessage = callsByMessage(calls);
  const entries: HistoryEntry[] = [];
  messages.forEach((message, i) => {
    const toolCalls = (byMessage.get(i) ?? []).map((call) => ({
      id: call.id,
      tool: call.tool,
      input: inputText(call.input, inputChars),
      result: resultNote(call),
    }));
    if (message.text.trim().length === 0 && toolCalls.length === 0) return;
    const entry: HistoryEntry = { i, role: message.role, text: message.text };
    if (toolCalls.length > 0) entry.tool_calls = toolCalls;
    entries.push(entry);
  });
  return entries;
}

/** The last three user prompts, as the default `goal`.
 *  取最后三条用户提示作为默认 `goal`（这是 `options.goal` 为空时的兜底）。
 *
 *  只考虑「有文本、且不带工具结果」的 user 消息——带工具结果的消息是工具回传，
 *  不是人的指令。每条最多保留 500 字符。
 */
export function goalFromMessages(messages: readonly Message[]): string {
  return messages
    .filter(
      (message) =>
        message.role === 'user' &&
        message.text.trim().length > 0 &&
        (message.toolResults ?? []).length === 0,
    )
    .slice(-3)
    .map((message) => truncate(message.text, 500))
    .join('\n');
}

/**
 * Builds the Jev state from the whole conversation and shrinks it in stages
 * until it fits `maxStateTokens`: tool inputs are truncated, then long texts
 * are abridged oldest-first (pinned messages last), then old messages collapse
 * to a one-line note, then old tool calls shrink to one line each, then old
 * messages that carry no call are left out, then runs of old call-only
 * messages are folded into one entry. Throws when even that is too big.
 *
 * 由整段会话构造 Jev 所需的 state，并分阶段收缩直到不超过 `maxStateTokens`：
 * 先截断工具输入（1000 → 200 → 60 字符），再把长文本节略为头+尾（从最旧的
 * 非固定消息开始，固定消息最后处理），然后把旧消息折叠成一行说明，接着把旧工具
 * 调用各压成一行，随后略去不含调用的旧消息，最后把连续的纯调用旧消息并为一条。
 * 若连这样都放不下，则抛错。
 *
 * 关键点：
 * - state 是「只给 Jev 看的视图」，与真正返回给调用方的会话完全分离；
 * - 每个阶段的都会重新校验预算，一旦满足就立刻返回，并记录是哪一阶段（`stage`）达成的。
 *
 * @returns 适配后的 state、其估算 token 数以及所用阶段名。 / The fitted state, its estimated tokens, and the stage that produced it.
 */
export function fitState(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  options: Pick<ResolvedCompactOptions, 'maxStateTokens' | 'preserveRecentMessages' | 'goal'>,
): FittedState {
  const goal = options.goal || goalFromMessages(messages);
  const stateOf = (history: HistoryEntry[]): CompactionState => ({
    context: STATE_CONTEXT,
    goal,
    history,
  });
  const entryTokens = (entry: HistoryEntry): number => estimateTokens(JSON.stringify(entry)) + 1;
  // context 与 goal 的开销是固定的，只算一次，后续按增量的方式维护总 token 数。
  const baseTokens = estimateTokens(JSON.stringify(stateOf([])));
  const fitted = (history: HistoryEntry[], tokens: number, stage: string): FittedState => ({
    state: stateOf(history),
    tokens,
    stage,
  });

  let history: HistoryEntry[] = [];
  let perEntry: number[] = [];
  let tokens = 0;
  const rebuild = (inputChars: number): void => {
    history = historyEntries(messages, calls, inputChars);
    perEntry = history.map(entryTokens);
    tokens = baseTokens + perEntry.reduce((sum, n) => sum + n, 0);
  };
  const fits = (): boolean => tokens <= options.maxStateTokens;
  /** 修改单个条目并增量更新 token 统计，避免每次都重算整份 state。 / Mutates one entry and updates the token total incrementally, instead of recomputing the whole state. */
  const shrink = (index: number, change: (entry: HistoryEntry) => void): void => {
    const entry = history[index];
    if (!entry) return;
    change(entry);
    const now = entryTokens(entry);
    tokens += now - (perEntry[index] ?? 0);
    perEntry[index] = now;
  };

  // state 拟合过程是单向收缩的：先尽可能保留结构，只有在超出预算时才逐步丢弃细节。
  rebuild(INPUT_CHARS[0]);
  if (fits()) return fitted(history, tokens, 'full');

  for (const limit of INPUT_CHARS.slice(1)) {
    rebuild(limit);
    if (fits()) return fitted(history, tokens, `inputs<=${limit}`);
  }

  const pinned = (entry: HistoryEntry): boolean =>
    isPinned(entry.i, messages.length, options.preserveRecentMessages);
  const indices = history.map((_, index) => index);
  // 优先压缩旧的非 pinned 条目，再处理最近消息和首条消息。
  // 后两类消息只有在最后仍会参与检查，这样才能准确报告受保护上下文也无法适配预算的情况。
  const order = [
    ...indices.filter((index) => !pinned(history[index]!)),
    ...indices.filter((index) => pinned(history[index]!)),
  ];

  for (const index of order) {
    const entry = history[index]!;
    if (entry.text.length <= TEXT_HEAD + TEXT_TAIL + 40) continue;
    shrink(index, (e) => {
      e.text = abridge(e.text, TEXT_HEAD, TEXT_TAIL);
    });
    if (fits()) return fitted(history, tokens, 'texts abridged');
  }

  for (const index of order) {
    const entry = history[index]!;
    // 固定条目与空文本条目不参与折叠；折叠用原文长度做说明，而不是当前（可能已节略的）长度。
    if (pinned(entry) || entry.text.length === 0) continue;
    const original = messages[entry.i]?.text.length ?? entry.text.length;
    shrink(index, (e) => {
      e.text = `[… ${original} chars omitted …]`;
    });
    if (fits()) return fitted(history, tokens, 'old messages collapsed');
  }

  const byMessage = callsByMessage(calls);
  for (const index of order) {
    const entry = history[index]!;
    const own = byMessage.get(entry.i);
    if (pinned(entry) || !own) continue;
    shrink(index, (e) => {
      e.tool_calls = own.map(compactCall);
    });
    if (fits()) return fitted(history, tokens, 'old calls compacted');
  }

  // 略去不含调用的旧消息：先累计要移除的条目，边移除边检查是否已满足预算。
  const left = new Set<number>();
  for (const index of order) {
    const entry = history[index]!;
    if (pinned(entry) || entry.tool_calls) continue;
    left.add(index);
    tokens -= perEntry[index] ?? 0;
    if (fits()) {
      return fitted(
        history.filter((_, i) => !left.has(i)),
        tokens,
        'old messages left out',
      );
    }
  }

  // 最后一招：把连续的纯调用旧条目并为一条，重新统计 token。
  history = mergeCallRuns(
    history.filter((_, i) => !left.has(i)),
    pinned,
  );
  perEntry = history.map(entryTokens);
  tokens = baseTokens + perEntry.reduce((sum, n) => sum + n, 0);
  if (fits()) return fitted(history, tokens, 'old calls merged');

  // 连最激进的收缩都无法满足预算（通常是把 maxStateTokens 调得过小）：交给调用方回退。
  throw new Error(
    `history too large for Jev (~${tokens} tokens after truncation, limit ${options.maxStateTokens})`,
  );
}
