# 交互式对话深度剖析

> 本文是 [agent-dev-guide.md](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-agent/docs/agent-dev-guide.md) §4.5/§4.6/§8.5、 [streaming-guide.md](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-app/src/views/streaming-guide.md) §9、 [nodejs-api-guide.md](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-agent/docs/nodejs-api-guide.md) §6.5-6.7 的"原理深挖版"，聚焦协议约束、顺序敏感性、边界场景等"实现层细节"。
>
> 阅读本文前请先理解上面三份文档的整体设计。
>
> 📌 **P1 性能优化相关补充**（2026-06）：本文涉及的 `chatStream` / `resumeInteractive` 在 P1 优化中新增了 `onProgress` 回调参数（4 种类型：`thinking` / `tool_call` / `tool_result` / `streaming`），但**不改变本文讨论的协议与顺序**。详见 [streaming-guide.md §7.1](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-app/src/views/streaming-guide.md) 与 [streaming-guide.md §9](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-app/src/views/streaming-guide.md) 的 P1 总结。

---

## 目录

1. [OpenAI 协议强约束：消息顺序不可破](#1-openai-协议强约束消息顺序不可破)
2. [续点的"语义转换"：用户选择怎么变成 tool 消息](#2-续点的语义转换用户选择怎么变成-tool-消息)
3. [为什么 `chat()`（非流式）不支持交互式](#3-为什么-chat非流式不支持交互式)
4. [`INTERACTIVE_TOOL_NAMES` 集合为什么是 `ReadonlySet`](#4-interactive_tool_names-集合为什么是-readonlyset)
5. [`targetCall` 展平的细节](#5-targetcall-展平的细节)
6. [上下文截断（`MAX_CONTEXT_MESSAGES = 40`）对续点的影响](#6-上下文截断max_context_messages--40对续点的影响)
7. [AbortSignal 在交互式暂停期间的语义](#7-abortsignal-在交互式暂停期间的语义)
8. [一个 LLM 响应中多交互式工具的并发情况](#8-一个-llm-响应中多交互式工具的并发情况)
9. [`handleToolCalls` 顺序敏感性](#9-handletoolcalls-顺序敏感性)
10. [`parseInteractiveArgs` 的"零选项跳过"机制](#10-parseinteractiveargs-的零选项跳过机制)
11. [续点后 LLM 的"记忆错觉"](#11-续点后-llm-的记忆错觉)
12. [SSE 三标记守卫的完整状态机](#12-sse-三标记守卫的完整状态机)

---

## 1. OpenAI 协议强约束：消息顺序不可破

LLM 接收的 `messages` 数组必须满足：

```
system → user → assistant(tool_calls) → tool → tool → … → assistant(tool_calls) → tool → … → assistant(纯文本)
```

只要出现 `tool_calls` 的 assistant 消息，**紧跟其后**必须为每个 tool_call 都有一条 `role:tool` 消息（`tool_call_id` 一一对应），否则 DeepSeek / OpenAI 立刻返回：

```
400 Invalid parameter: messages with role 'tool' must be a response to a preceeding message with 'tool_calls'
```

这就是为什么 `resumeInteractive()` 第 3 步**先把 `role=tool` 消息写入 history，再调 LLM**——如果反着来，LLM 直接拒绝。

**对应代码**（[agent.ts:700-712](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-agent/src/agent.ts#L700-L712)）：

```typescript
// 3. 追加 tool 消息（这是 LLM 期待的工具结果）
const toolResultMsg: Message = {
  role: 'tool',
  tool_call_id: interactiveId,
  content: JSON.stringify({ user_choice: choice }),
}
messages.push(toolResultMsg)
await this.persistMessage(sessionId, toolResultMsg)  // ← 先持久化

// 4. 继续 ReAct 循环 —— 复用 chatStream 主体逻辑
for (let step = 1; step <= MAX_REACT_STEPS; step++) {  // ← 后调 LLM
  ...
}
```

**架构含义：** 续点是"消息补偿 + 续推"两步动作，顺序硬性约束，文档化可避免后续维护者写出"先调 LLM 再补 tool 消息"的反向逻辑。

---

## 2. 续点的"语义转换"：用户选择怎么变成 tool 消息

```typescript
const toolResultMsg: Message = {
  role: 'tool',
  tool_call_id: interactiveId,
  content: JSON.stringify({ user_choice: choice }),  // ← 不是字符串
}
```

**为什么用 `JSON.stringify({ user_choice: choice })` 而不是直接 `choice.join(',')`？**

| 方案 | 优点 | 缺点 |
|------|------|------|
| `JSON.stringify({ user_choice: choice })` ✅ | 结构化、字段名清晰、LLM 训练过读 JSON | 多 2 字节 |
| `choice.join(',')` | 简短 | LLM 不知道是 1 个选项还是 2 个；多选时无分隔语义 |
| `choice` 直接当字符串 | 极简 | 单选多选表现不一致 |

实际选 JSON 是因为：
- 工具返回值默认是结构化数据，LLM 在 system prompt 里训练过"读 JSON"
- `user_choice` 是命名清晰的字段名，LLM 知道这是用户的选择
- 多选时 `choice = ["川菜","重辣"]` 转 JSON 后是 `["川菜","重辣"]`，LLM 能直接看到数组语义
- LLM 拿到这条 tool 消息后的下一轮生成会自然用上"用户选了 X"的上下文（用 prompt 引导）

---

## 3. 为什么 `chat()`（非流式）不支持交互式

非流式 `POST /api/chat` 没有 SSE 通道，无法向实时推送 `interactive_request` 事件。当 LLM 调起 `ask_user_choice` 时，Agent 的兜底策略是（[agent.ts:391-402](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-agent/src/agent.ts#L391-L402)）：

```typescript
const { toolCount, paused } = await this.handleToolCalls(...)
if (paused) {
  console.warn('[Agent] ⚠️ 非流式 chat() 检测到交互式工具，回退到兜底文案')
  const fallback = '我需要先了解你的偏好才能给出准确答案，请在流式对话中重新提问'
  return { success: true, message: fallback, sessionId, paused: true }
}
```

**为什么不改造 `chat()` 也支持？** 因为 `ask_user_choice` 必然要求用户主动点击，HTTP 一次性响应根本等不到用户——所以让 `chat()` 返回 `paused: true` + 引导文案，前端看到这个字段就提示"请在流式模式重新提问"。

**架构权衡：**
- ✅ 实现简单，前端无需为非流式单独处理交互卡片
- ✅ 强制引导用户走流式，享受完整体验
- ❌ 偶尔会出现"非流式回复看起来答非所问"的体验

---

## 4. `INTERACTIVE_TOOL_NAMES` 集合为什么是 `ReadonlySet`

```typescript
export const INTERACTIVE_TOOL_NAMES: ReadonlySet<string> = new Set([ask_user_tool.name])
```

**3 个设计选择：**

1. **`ReadonlySet` 类型**：防止任何模块在运行时 `.add()` / `.delete()`，集合内容只在启动期确定
2. **`Set` 而非 `Array`**：查找是 O(1)，比 `Array.includes` 快；ReAct 循环每步都查一次，多轮累计差异明显
3. **必须改源文件才能新增交互式工具**："显式优于隐式"——`agent.handleToolCalls` 的逻辑可静态分析

**典型反例（如果用 `Array`）：**

```typescript
// 危险：运行期动态注册会破坏协议约束
if (someCondition) {
  INTERACTIVE_TOOL_NAMES.push('some_runtime_tool')  // 编译通过，运行时崩
}
```

---

## 5. `targetCall` 展平的细节

`tool_calls` 元素在 OpenAI 协议里是嵌套结构：

```typescript
{ id: 'call_xxx', type: 'function', function: { name: 'ask_user_choice', arguments: '...' } }
```

`resumeInteractive` 第 2 步反查时展平为：

```typescript
targetCall = { id: tc.id, name: tc.function.name, arguments: tc.function.arguments }
```

**为什么要展平？** 后续所有代码都用 `{ id, name, arguments }` 这种扁平结构（与 `Message.tool_calls` 兼容），不再嵌套 `.function.xxx`，可读性大幅提升。

**这是历史 bug 修复**——之前漏了 `.function.` 前缀导致续点时找不到 tool_call：

```typescript
// ❌ 错误写法：直接用嵌套结构
for (const tc of m.tool_calls) {
  if (tc.id === interactiveId) {
    targetCall = tc  // 仍是嵌套结构
    break
  }
}
// 后续使用 targetCall.name → undefined（实际是 tc.function.name）

// ✅ 修复后：展平为扁平对象
targetCall = { id: tc.id, name: tc.function.name, arguments: tc.function.arguments }
```

详见 [agent.ts:666-680](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-agent/src/agent.ts#L666-L680)。

---

## 6. 上下文截断（`MAX_CONTEXT_MESSAGES = 40`）对续点的影响

```typescript
// agent.ts:120-138
if (messages.length > MAX_CONTEXT_MESSAGES + 1) {
  const numTruncated = messages.length - MAX_CONTEXT_MESSAGES - 1
  const recent = messages.slice(-MAX_CONTEXT_MESSAGES)
  const truncationNote: Message = {
    role: 'system',
    content: `[注意] 对话历史过长，已省略最早的 ${numTruncated} 条消息…`,
  }
  const truncated = [systemMsg, truncationNote, ...recent]
  return truncated
}
```

**续点时的风险场景：**

1. 用户问 A → 追问 B → 调起交互 → 等 10 分钟
2. 期间对话历史被 `loadMessages` 截断，原来的 `interactiveId` 对应的 assistant 消息被省略
3. `/api/chat/continue` 反查 `targetCall = null` → 500 + "会话可能已过期"

**为什么 `loadMessages` 每次重读？** 截断可能发生在任何时刻，且 `MAX_REACT_STEPS=5` × 每步都调 LLM，截断后 LLM 上下文要保持一致。

**生产环境缓解措施（未实施）：**

```typescript
// 方案 A：续点时检查 interactiveId 是否在截断前
const targetIndex = messages.findIndex(m =>
  m.role === 'assistant' &&
  m.tool_calls?.some(tc => tc.id === interactiveId)
)
if (targetIndex === -1) {
  // 该轮已被截断，提示用户重开对话
  throw new Error('该交互已超出上下文窗口，请重新发起对话')
}

// 方案 B：把 interactiveId 存到 session 级别，避免被截断
session.pendingInteractiveId = interactiveId
// 截断时排除这一条
```

---

## 7. AbortSignal 在交互式暂停期间的语义

```
时间线：
  T1: 用户点发送 → chatStream 启动，AbortController 关联 req.on('close')
  T2: LLM 输出 chunk × 3
  T3: LLM 调起 ask_user_choice → 触发 onInteractive → agent paused=true → res.end()
  T4: 浏览器收到 interactive_request 事件 + 连接关闭
  T5: 用户思考 5 秒
  T6: 用户点击"川菜" → POST /api/chat/continue
  T7: 这是**新** HTTP 请求，**新**的 AbortController，**与 T1 那个无关**
  T8: resumeInteractive 内部检查 signal?.aborted
```

**关键点：** 旧 `AbortSignal` 在 T3 后随 `res.end()` 而失效。新 `/api/chat/continue` 的信号独立运作。用户在 T5-T6 期间想"中止"，实际只能关闭旧 SSE 标签，但旧流已因 paused 自然结束。

**生产环境观察：** 前端如果在 interactive 卡片上提供"取消"按钮，应该发"清空 pendingInteractiveId"的请求，而不是触发 abort。

---

## 8. 一个 LLM 响应中多交互式工具的并发情况

如果 LLM 在一轮同时调：

- `ask_user_choice(question="哪种菜系", options=["川菜","粤菜"])`
- `ask_user_choice(question="什么场合", options=["家宴","聚会"])`

`handleToolCalls` 会（[agent.ts:418-426](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-agent/src/agent.ts#L418-L426)）：

```typescript
for (const c of assistantToolCalls) {
  if (INTERACTIVE_TOOL_NAMES.has(c.function.name)) {
    const req = this.parseInteractiveArgs(c.id, c.function.arguments)
    if (req) interactiveRequests.push(req)  // 两个都被收集
  } else { ... }
}
```

**两个 `interactive_request` 事件会同时下发到前端**，前端需要为每个 `interactiveId` 渲染一个独立的 `InteractiveChoiceCard`。这种"批问"是 LLM 优化体验的常见模式（一次问清多个偏好）。

**已知限制（未优化）：** 续点时 `POST /api/chat/continue` 一次只接受一个 `interactiveId`——意味着多交互场景下用户要按顺序回答（不是并行），这是一个**未优化点**。

**未来改造方向：**

```typescript
// 当前（顺序回答）
interface ContinueRequestBody {
  sessionId?: string
  interactiveId: string
  choice: string[]
}

// 未来（并行回答）
interface ContinueRequestBody {
  sessionId?: string
  choices: Record<interactiveId: string, string[]>  // 每个交互式工具独立答案
}
```

实现要点：续点时循环 `choices` 里的每对，依次追加 `role=tool` 消息再调 LLM。

---

## 9. `handleToolCalls` 顺序敏感性

```typescript
// agent.ts:228-280（handleToolCalls 简化版）
// 1. 持久化 assistant(tool_calls) 消息
// 2. 拆分交互式 vs 非交互式
// 3. 执行非交互式工具（并行） + 追加 tool 消息
// 4. 处理交互式工具 → 触发 onInteractive
// 5. 返回 { paused, toolCount, interactiveRequests }
```

**为什么普通工具先执行再触发交互回调？** 假设 LLM 同时调 `search_recipe("红烧肉")` + `ask_user_choice(["川菜","粤菜"])`，顺序是：

1. 先 `search_recipe` 执行完 → tool 消息入库
2. 再触发 `onInteractive`，前端拿到的 `ask_user_choice` 选项**已经基于红烧肉的搜索结果**生成，更精准

**反例（如果反过来）：** 交互式工具触发时机过早，LLM 还没看到菜谱详情，选项可能不准。

**调换的代价：** LLM 拿到 tool 消息是异步的，但回调触发是同步的。强制同步处理能保证前端看到的 `options` 是基于当前 tool 结果的。

---

## 10. `parseInteractiveArgs` 的"零选项跳过"机制

```typescript
// agent.ts:354-364
if (options.length === 0) {
  console.warn(`[Agent] ⚠️ 交互式工具 ${id} 选项为空，跳过`)
  return null
}
```

**为什么空选项要跳过？** 如果 LLM 偶发输出 `options: []`（schema 不严格），弹给前端一个空选项卡片毫无意义。Agent 选择"放弃这次交互"而不是"中断流程"——这也是"宽容解析"哲学。

**已知边界情况：**

- LLM 以为调用成功了（消息已持久化），但用户没收到选项
- 前端 SSE 流已结束但没 `interactive_request` 事件也没 `done` 事件
- 出现"对话卡住"

**生产环境缓解措施（已实施）：** 双计时器 + 深度卡住检测

[P0-1 已实现 ✅](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-app/src/hooks/useConversation.ts)，通过 3 个并行计时器处理"对话卡住"：

| 计时器 | 时长 | 触发场景 | 行为 |
|--------|------|----------|------|
| **hardTimer**（硬上限） | `STREAM_HARD_TIMEOUT_MS` = 120s | 流总时长超 120s | 中止请求 + 追加 `[回答超时]` |
| **inactivityTimer**（静默超时） | `STREAM_INACTIVITY_MS` = 30s | 上次事件（chunk/tool/interactive）后 30s 无新事件 | 中止请求 + 追加 `[AI 似乎卡住了]` |
| **stuckHintTimer**（卡住提示） | `STUCK_AFTER_TOOL_HINT_MS` = 15s | 静默 + 上次事件是 `tool_calls` | 仅追加 `[对话可能卡住，可点击停止]`，不杀流 |

```typescript
// 关键实现：useConversation.ts
const onStreamEvent = (event: LastEvent): void => {
  lastEvent = event
  if (event === 'done') { clearAllTimers(); currentAIMsg = null; return }
  resetInactivityTimer()  // 任何"流进行中"事件都重置静默计时器
  if (event === 'tool') resetStuckHintTimer()  // tool 事件才启动卡住提示
  else clearStuckHintTimer()
}

// 在 sendChatStream 的 4 个回调中各调一次：
(chunk)        => { aiMsg.content += chunk; onStreamEvent('chunk') }
(_full, fr)    => { onStreamEvent('done') /* 自动清空所有计时器 */ }
(calls)        => { ...; onStreamEvent('tool') /* 启动卡住检测 */ }
(req)          => { ...; onStreamEvent('interactive') /* 等待用户，禁用计时 */ }
```

**三场景对比：**

| 场景 | 旧行为（单计时器 60s） | 新行为（双计时器 + 卡住检测） |
|------|------------------------|--------------------------------|
| 流正常输出 5 分钟（chunk 不断） | ❌ 60s 后被误杀 | ✅ 硬上限 120s + 静默 30s 都通过 |
| 静默 25s 后继续 chunk | ❌ 已超时被中止 | ✅ 静默计时器被重置，10s 后又收到 chunk |
| LLM 调起 ask_user_choice 但 options=[] 被跳过 | ❌ 卡死直到 60s | ✅ 15s 显示"对话可能卡住"，30s 中止 |
| 用户主动点"停止" | ✅ 立即中止 | ✅ 立即中止（不变） |

**替代方案（未实施）：** 严格 schema 校验，空选项就报错让 LLM 重试：

```typescript
// 在 ask-user.ts 加 additionalProperties: false + minItems: 2
options: {
  type: 'array',
  items: { type: 'string' },
  minItems: 2,
  maxItems: 4,
}
```

但这会牺牲 LLM 的灵活性（有时它想给单选 + "其他"），需权衡。**当前选择"宽容解析 + 前端超时"组合**，比"严格 schema 引发 LLM 重试"更稳健。

**详细配置：**

```typescript
// cooking-app/src/constants/index.ts
export const STREAM_HARD_TIMEOUT_MS = 120_000       // 硬上限 2 分钟
export const STREAM_INACTIVITY_MS = 30_000           // 静默超时 30 秒
export const STREAM_INACTIVITY_MESSAGE = 'AI 似乎卡住了，请稍后重试或重新提问。'
export const STUCK_AFTER_TOOL_HINT_MS = 15_000       // 卡住检测 15 秒
```

---

## 11. 续点后 LLM 的"记忆错觉"

LLM 在续点后的下一轮 `messages` 数组会看到：

```typescript
[
  ...,                                            // 历史
  { role: 'assistant', tool_calls: [...] },       // 上轮 assistant（已持久化）
  { role: 'tool', tool_call_id: '...', content: '{"user_choice":["川菜"]}' },  // ← 续点追加
]
```

LLM 看到 `tool` 消息后，会自然生成"好，那我们就做川菜……"的回答，仿佛它真的"听到了"用户的声音。这正是 `ask_user_choice` 的核心设计：

**把"用户主动输入"伪装成"工具调用结果"，让 LLM 的对话流不被打破。**

**为什么不让用户直接发 `user` 消息？**

```typescript
// 方案 A：直接发 user 消息（不推荐）
messages.push({ role: 'user', content: '川菜' })
// → LLM 会问"川菜怎么了？"或者直接开始聊天，丢失"提问上下文"

// 方案 B：伪装成 tool 消息（当前实现 ✅）
messages.push({ role: 'tool', tool_call_id: interactiveId, content: '{"user_choice":["川菜"]}' })
// → LLM 知道这是"对 ask_user_choice 的回答"，自然衔接
```

**深层原理：** OpenAI 协议下，tool 消息是"对 LLM 主动行为的回应"，user 消息是"新话题"。`ask_user_choice` 主动提问，必须用 tool 消息回应才语义正确。

---

## 12. SSE 三标记守卫的完整状态机

`index.ts` 中 `req.on('close')` 极易误触发（前端 `fetch` 取消、网络抖动），三个标记的精确分工：

| 标记 | 含义 | 谁会动它 |
|------|------|---------|
| `finished` | `onDone` 已调用（流正常完成） | agent |
| `hasStreamed` | 至少发过 1 个 chunk 事件 | agent 回调 |
| `writableEnded` | `res.end()` 已调用 | Express 内部 |

**判定逻辑：**

```typescript
// 仅当流已建立、已发送过内容、未正常完成时，关闭才算"中断"
req.on('close', () => {
  if (!finished && writableEnded && hasStreamed) {
    abortController.abort()
  }
})
```

**避坑指南：**

| 场景 | 三个标记状态 | 行为 | 是否正确 |
|------|--------------|------|---------|
| 正常 `onDone` | `finished=true` | 忽略 close | ✅ |
| 流开始就关闭（用户取消） | `hasStreamed=false` | 忽略 close | ✅（节省 abort 开销） |
| 流中 chunk 后客户端断开 | `hasStreamed=true, finished=false` | abort | ✅ |
| `res.end()` 后同步 close | `writableEnded=true` | 忽略 close | ✅（避免重复 abort） |
| 中间被 `[已中止]` 标记 | `finished=true` | 忽略 close | ✅（已被持久化） |

**反例（如果只用 `finished` 一个标记）：**

```typescript
// ❌ 危险：流开始时的关闭也会被当成"中断"
req.on('close', () => {
  if (!finished) abortController.abort()  // 用户切页面就触发 abort
})
// 结果：每个"页面切到后台再切回来"都会中断 LLM 生成

// ✅ 修复：加 hasStreamed 守卫
req.on('close', () => {
  if (!finished && hasStreamed) abortController.abort()
})
```

**为什么需要 `writableEnded`？** 防止 `res.end()` 之后浏览器同步发的 close 事件被误判。`writableEnded` 是 Express 内部状态，比 `finished` 更可靠（因为 `finished` 由 agent 控制，可能因异常没设上）。

具体代码见 [nodejs-api-guide.md §6.2](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-agent/docs/nodejs-api-guide.md#L283-L300)。

---

## 附录 A：消息流转时序图（含所有边界）

```
chatStream 启动
  │
  ├─ loadMessages → 上下文截断（若超 MAX_CONTEXT_MESSAGES）
  │
  ├─ 循环（最多 5 步）：
  │   │
  │   ├─ 检查 signal?.aborted → 中断
  │   │
  │   ├─ callLLMWithRetry → 返回 assistant 消息
  │   │
  │   ├─ 有 tool_calls？
  │   │   │
  │   │   └─ 是 → handleToolCalls
  │   │         │
  │   │         ├─ 持久化 assistant(tool_calls)
  │   │         ├─ 拆分交互式 / 非交互式
  │   │         ├─ 执行非交互式工具（并行） + 追加 tool 消息
  │   │         └─ 触发 onInteractive（若交互式）
  │   │
  │   │       返回 { paused, toolCount }
  │   │       │
  │   │       └─ paused=true → break
  │   │
  │   └─ 无 tool_calls → 流式输出
  │         │
  │         └─ signal.aborted → 中断
  │
  ├─ 4 个后处理分支：
  │   │
  │   ├─ cancelled → 追加 [已中止] 或兜底文案
  │   ├─ paused → 不调 onDone，由路由 res.end()
  │   ├─ 空内容 → 兜底文案
  │   └─ 正常 → 持久化 + onDone
  │
  └─ 路由层：req.on('close') 守卫 + sendEvent
```

---

## 附录 B：相关代码位置速查

| 主题 | 文件:行 |
|------|---------|
| `INTERACTIVE_TOOL_NAMES` 定义 | [tools/index.ts](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-agent/src/tools/index.ts) |
| `ask_user_choice` 工具元信息 | [tools/ask-user.ts](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-agent/src/tools/ask-user.ts) |
| `handleToolCalls` 主体逻辑 | [agent.ts:226-280](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-agent/src/agent.ts#L226-L280) |
| `parseInteractiveArgs` 容错 | [agent.ts:337-372](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-agent/src/agent.ts#L337-L372) |
| `chatStream` 7 参数签名 (含 onProgress) | [agent.ts:478-595](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-agent/src/agent.ts#L478-L595) |
| `resumeInteractive` 4 步续点 | [agent.ts:645-790](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-agent/src/agent.ts#L645-L790) |
| `loadMessages` 截断逻辑 | [agent.ts:93-138](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-agent/src/agent.ts#L93-L138) |
| `/api/chat/continue` 端点 | [index.ts](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-agent/src/index.ts) |
| SSE 端点三标记守卫 | [index.ts](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-agent/src/index.ts) |
| 前端状态机 | [useConversation.ts](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-app/src/hooks/useConversation.ts) |
| `<InteractiveChoiceCard>` 组件 | [cooking-app/src/components](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-app/src/components) |

---

## 附录 C：与上层文档的引用关系

本文是以下 3 份文档的"实现细节扩展"：

- 📘 [agent-dev-guide.md §4.5-4.6 / §8.5](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-agent/docs/agent-dev-guide.md) — Agent 实现视角
- 📗 [streaming-guide.md §9](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-app/src/views/streaming-guide.md) — 前端交互视角
- 📙 [nodejs-api-guide.md §6.5-6.7](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-agent/docs/nodejs-api-guide.md) — 路由 & 协议视角

阅读建议：先读上层文档理解整体设计，再读本文深挖原理。
