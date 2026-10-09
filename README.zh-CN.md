# fast-jev-compaction

Claude Code 插件：用 Jev 的判定结果取代压缩摘要——
每一次工具调用和工具结果都会在一次快速请求中被打分，过期的被丢弃或截断，
所有保留下来的内容都保持原文不变。也可作为 npm 库使用。

## 是什么，以及为什么

大多数上下文压缩都是让 LLM 去总结旧轮次。摘要是有损的：一个文件路径、一段确切的报错、
一条约束或一条命令，即便之后仍然重要，也可能就此消失。本库从不改写任何内容。
它只删除 Jev 认为已不再需要的工具调用和工具结果，并且在询问 Jev 时会把整段对话展示给它。
用户和助手的文本保持原文、保持原有顺序。

本仓库既是一个 npm 包（`src/`），也是一个 Claude Code 插件
（`hooks/`、`.claude-plugin/`）——插件使用该包，以原始消息取代 Claude Code 内置的压缩摘要。

## 项目导览与思维图

想先建立整体心智模型，可阅读 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。其中包含模块关系图、一次压缩的时序图、核心概念和建议阅读顺序。

## 工作原理

1. 每个 `tool_use` 都会通过 `tool_use_id` 与其 `tool_result` 配对。位于第一条消息中、
   或位于最新 `preserveRecentMessages` 条消息中的调用会被固定（pinned），永不改动。
2. 发送给 Jev 的 **state** 是截至目前为止的整段对话，按从旧到新排列，
   其中每个工具结果都被替换为一条简短说明（`ok, 4213 chars (omitted)`）。
   工具输入会被包含，文本会被包含，不做任何摘要。
3. state 会分阶段地塞进 `maxStateTokens`（默认 25k），每个阶段只有在前一阶段仍不够用时才会应用：
   先把工具输入截断到 1000 个字符，然后是 200，再到 60；长文本压缩为头部 + 尾部，
   从最旧的非固定消息开始；旧的、未被固定的消息折叠为一条 `[… N chars omitted …]` 说明；
   旧的工具调用压缩为一行（`t12 Read file_path=src/a.ts → ok 480ch`）；
   旧的、不含调用的消息被略去；连续的、只含调用的旧消息合并为一条记录。
   如果仍然放不下，压缩会抛出异常。token 数在没有分词器的情况下估算
   （每六个字母算一个词，每个数字算半个 token，其他符号约各算一个），
   经过校准，使其略高于 Jev 报告的数量。
4. 对于每个未被固定的调用，Jev 会收到两个 `noul` 问题：**调用**是否应保留
   （知道它被发起过、连同它的输入，是否仍然重要），以及**结果**是否应逐字保留
   （它的内容是否仍然需要，且重跑该工具无法替代）。
5. 问题会被拆分为所需的多个请求，使 state 加问题保持在 `maxRequestTokens`
   （默认 30k，低于 Jev 的 32k 请求上限）以下。每个请求都会重新发送同一份完整 state；
   请求并发执行，答案会被合并。
6. 每个调用的判定，对照 `keepThreshold`：
   - `keepResult ≥ threshold` → 保留调用和结果；
   - 否则 `keepCall ≥ threshold` → 保留调用，把结果截断为其前 `truncateHeadChars`
     个字符加上一行说明；
   - 否则 → 连同其结果一起删除该调用。
7. 消息列表会被重建：内容被全部移除的消息会被删除，未受影响的消息以同一对象返回，
   并且绝不会出现结果失去其调用的情况。

Jev 出错、答案格式错误、缺少密钥，或历史记录无法塞进限制，都会抛出异常；
由调用方（或 Claude Code hook）决定回退到什么方案。

## 安装与使用

```sh
npm install fast-jev-compaction
export TYPESAFE_API_KEY=...
```

```ts
import { compactMessages, reductionRatio, type Message } from 'fast-jev-compaction';

const transcript: Message[] = [
  { role: 'user', text: 'Fix the failing test. Never edit src/generated.', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'toolu_1', tool: 'Read', input: { file_path: 'src/a.ts' } }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_1', text: '…file…' }] },
  // …
];

const result = await compactMessages(transcript, { preserveRecentMessages: 4 });
console.log(result.messages, result.decisions, result.stats);
if (reductionRatio(result) < 0.25) {
  // not worth it: keep the original transcript, or summarize instead
}
```

`Message` 是 Claude Code `SessionMessage` 的子集，因此会话记录可以直接传入。

若要自带传输层，请实现 `JevAsker`（只有一个 `ask(state, questions)` 方法）并调用
`compact(messages, asker, options)`；`buildJevRequest` 和 `parseJevResponse`
为你提供 HTTP 请求体和响应校验。各个构建块（`collectToolCalls`、`fitState`、`batchCalls`、
`decideCall`、`applyDecisions`）也都有导出。

`apiKey` 默认取 `process.env.TYPESAFE_API_KEY`。切勿提交密钥，也不要把它写进源文件。

## 选项

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `apiKey` | `TYPESAFE_API_KEY` | TypeSafe API 密钥（`compactMessages`/`JevClient`） |
| `model` | `jev-latest` | Jev 模型名称 |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | System One 端点 |
| `fetch` | 原生 `fetch` | 可注入的 fetch 实现，便于测试 |
| `goal` | 最后 3 条用户提示 | 包含在 state 中的当前任务描述 |
| `keepThreshold` | `0.5` | 调用或结果得以保留所需的最低保留概率 |
| `preserveRecentMessages` | `6` | 永不改动的最新消息条数（第一条总是保留） |
| `maxStateTokens` | `25000` | state 的估算 token 上限 |
| `maxRequestTokens` | `30000` | state 加一批问题的估算上限 |
| `truncateHeadChars` | `300` | 被丢弃的工具结果在附加说明前保留的字符数 |

`result.stats` 报告压缩前后的消息数与字符数、按原因分类的判定计数、
以估算 token 表示的 state 大小、用到了哪个适配阶段，以及请求数量。

## 局限

- 只有工具调用和结果会被作为候选；文本消息在输出中永远不会被删除或缩短
  （它们只会在 Jev 看到的 state 中被节略）。
- token 大小是根据字符数估算的，而非分词器。
- 校准是在请求层面进行的；一个概率并不证明删除某个结果是安全的。助手总是可以重跑该工具。
- 每个请求都会重复完整的 state，因此当历史接近 state 上限时，每几个问题就要付出一次请求的开销。

## Claude Code 插件

仓库根目录就是一个 Claude Code function-hook 插件：`hooks/fast-jev.ts`
是一个薄适配层，它把 `session.compact` 的会话记录送入 `src/`，并在出错或压缩不足时
回退到 Claude Code 内置的摘要。配置方式与 Claude Code 2.1.274 类型参考见
[`hooks/README.md`](hooks/README.md)。

### 在 Claude Code 中安装

Function hooks 是 Claude Code 的早期访问功能（2.1.274+），因此必须在 Claude Code
运行的环境中设置启用标志，例如在 `~/.claude/settings.json` 中：

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1", "TYPESAFE_API_KEY": "<your key>" } }
```

然后把这个仓库添加为插件市场并安装插件，既可以在 shell 中执行，也可以在会话内用斜杠命令执行：

```sh
claude plugin marketplace add tamaratran/fast-jev-compaction
claude plugin install fast-jev-compaction@fast-jev-compaction
```

安装过程会询问插件选项（API 密钥、阈值、`truncateHeadChars` 等）；
保持默认值即可使用环境变量中的 `TYPESAFE_API_KEY`。
重启 Claude Code 或运行 `/reload-plugins`。此后 `/compact`（以及自动压缩）都会经过 Jev：
当剪枝后的历史取代了内置摘要时，提示会显示
`fast-jev-compaction: kept N/M messages, no summary (…)`；当 Jev 无法删除足够内容
（会话过短，或 Jev 出错）时，则显示 `fallback to built-in summary (…)`。

若想直接从代码检出运行而不安装：在仓库根目录执行
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`。
无需任何发布步骤；插件市场就是仓库里的 `.claude-plugin/marketplace.json`。

## 开发

```sh
npm install
npm run typecheck        # library + hook
npm test
npm run build
npm run validate:plugin  # claude plugin validate
TYPESAFE_API_KEY="$(cat ~/.typesafe_key)" npm run demo
```

单元测试使用假的 Jev，绝不会访问 TypeSafe。demo 才是真实的网络检查。

## 动画演示（macOS）

`demo/JevDemo` 是一个小型原生 SwiftUI 应用，它在 Claude Code 风格的终端里播放一段
编排好的、戏剧化的压缩流程：一段固定会话记录中的工具调用被打分，Jev 决定放手的
结果和调用变红并折叠消失，其余内容保持原文。它从不调用 API，存在只是为了录屏。

```sh
demo/JevDemo/build.sh   # builds demo/JevDemo/build/JevDemo.app and launches it
```

在应用中按空格键可从开头重播。
