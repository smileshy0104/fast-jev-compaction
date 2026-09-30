import { JevClient, type JevClientOptions } from './client.js';
import { compact } from './compact.js';
import type { CompactOptions, CompactResult, Message } from './types.js';

/**
 * `compactMessages` 的选项：压缩选项与 Jev 客户端选项的合体。
 *
 * 其中 `JevClientOptions` 提供 `apiKey` / `model` / `baseUrl` / `fetch`，
 * `CompactOptions` 提供 `goal` / `keepThreshold` / `preserveRecentMessages` /
 * `maxStateTokens` / `maxRequestTokens` / `truncateHeadChars`。
 */
export type CompactMessagesOptions = CompactOptions & JevClientOptions;

/**
 * `compact` with a `JevClient` built from the options (key from `TYPESAFE_API_KEY` by default).
 *
 * 使用由选项构建的 `JevClient` 调用 `compact`（密钥默认取自 `TYPESAFE_API_KEY`
 * 环境变量）。
 *
 * 这是本库最常用的入口：传入会话记录，返回压缩结果。
 * `JevClient` 负责通过 HTTP 访问 Jev，`compact` 负责配对工具调用、
 * 构造 state、提问、按阈值应用判定并重建消息列表。
 *
 * @param messages 会话记录（`Message` 是 Claude Code `SessionMessage` 的子集，可直接传入）。
 * @param options  压缩选项与 Jev 客户端选项；可全部省略，使用默认值。
 * @returns 压缩结果，含压缩后的消息、每个调用的判定与统计信息。
 */
export function compactMessages(
  messages: readonly Message[],
  options: CompactMessagesOptions = {},
): Promise<CompactResult> {
  return compact(messages, new JevClient(options), options);
}
