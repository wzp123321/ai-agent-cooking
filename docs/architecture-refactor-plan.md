# 厨神小助 — 架构重构设计稿

> **状态**：设计稿（待评审）
> **范围**：cooking-agent（后端） + cooking-app（前端）
> **目标**：提高可复用性 + 降低耦合度，不改变对外行为
> **评审者**：架构师 → 开发团队

---

## 0. 设计原则

| 原则 | 落地方式 |
|---|---|
| **单一职责** | agent.ts 拆分为 5 个职责明确的模块 |
| **DRY** | ReAct 循环、SSE 解析、计时器管理 三处重复全部消除 |
| **依赖倒置** | 引入 `StreamController` / `SSEResponse` 抽象，组件不再关心底层实现 |
| **类型即文档** | 前端 `InteractiveRequest` 与后端 schema 强一致（共享 union） |
| **防御性收敛** | 白名单/正则/类型断言集中到 `interactive/constants.ts` |

---

## 1. 后端重构方案（cooking-agent）

### 1.1 目录结构改造

```
src/
├── agent.ts                        # 瘦身后 < 200 行（只暴露对外 API）
├── agent/
│   ├── react-loop.ts               # 提取 ReAct 主循环
│   ├── stream-finalizer.ts         # 提取 cancelled/empty/done/paused 收尾逻辑
│   ├── interactive/
│   │   ├── parser.ts               # parseInteractiveArgs
│   │   ├── validator.ts            # validateChoice
│   │   ├── constants.ts            # 类别/类型白名单
│   │   └── schema.ts               # InteractiveRequest / PendingInteractive 类型
│   ├── preferences/
│   │   ├── prompt.ts               # buildPreferencesPrompt
│   │   └── categories.ts           # categories 元数据
│   ├── messages/
│   │   ├── loader.ts               # loadMessages + 截断
│   │   └── persister.ts            # persistMessage
│   └── timeout-watcher.ts          # startInteractiveTimeoutWatcher
├── routes/
│   ├── chat.routes.ts              # /api/chat, /api/chat/stream, /api/chat/continue
│   ├── interactive.routes.ts       # /api/chat/cancel-interactive, /api/chat/undo-interactive
│   ├── session.routes.ts           # /api/sessions, /api/history, /api/session/:id
│   ├── profile.routes.ts           # /api/profile
│   ├── vision.routes.ts            # /api/vision/chat
│   └── health.routes.ts            # /health
├── http/
│   ├── sse.ts                      # createSSEResponse(req, res) 抽象
│   ├── error-handler.ts            # AppError + 统一中间件
│   └── rate-limiter.ts             # 提取限流中间件
├── db/
│   ├── index.ts                    # getPool / closePool
│   ├── migrate.ts                  # 不变
│   ├── session.repository.ts
│   ├── message.repository.ts
│   ├── choice-history.repository.ts
│   └── user-profile.repository.ts
├── llm/                            # 不变
├── tools/                          # 不变
├── knowledge/                      # 不变
├── prompts.ts                      # 不变
├── loader.ts                       # 不变
├── vision.ts                       # 不变
├── types.ts                        # 合并所有 message 变体
└── index.ts                        # app + start() 入口（< 50 行）
```

### 1.2 关键模块契约

#### `agent/react-loop.ts`

```ts
export interface ReActLoopCallbacks {
  onChunk: (delta: string) => void
  onInteractive: (req: InteractiveRequest) => void
  onDone: (full: string) => void
}

export interface ReActLoopOptions {
  messages: Message[]
  sessionId: string
  signal?: AbortSignal
  onStreamEvent?: (event: 'llm-call' | 'tool-call' | 'pause' | 'stream-start' | 'stream-end') => void
}

export interface ReActLoopResult {
  finalContent: string
  toolCalls: number
  cancelled: boolean
  paused: boolean
  reactLog: ReActStep[]
}

/**
 * 通用 ReAct 循环，被 chatStream 和 resumeInteractive 共用。
 * - 任何时刻检查 signal.aborted
 * - 命中交互式工具时调 onInteractive 并返回 paused=true
 * - 完成/中止/暂停三类结束由调用方处理
 */
export async function runReActLoop(
  options: ReActLoopOptions,
  callbacks: ReActLoopCallbacks,
): Promise<ReActLoopResult>
```

#### `agent/stream-finalizer.ts`

```ts
/**
 * 收尾逻辑统一入口。被 chatStream 和 resumeInteractive 共用。
 *
 * 处理四类场景：
 *   1) cancelled + 有内容   → 追加 [已中止]
 *   2) cancelled + 无内容   → 友好提示
 *   3) paused              → 不调 onDone（调用方自己 res.end）
 *   4) empty               → 兜底文案
 *   5) normal              → 持久化 + onDone
 */
export async function finalizeStream(args: {
  messages: Message[]
  sessionId: string
  fullContent: string
  cancelled: boolean
  paused: boolean
  reactLog: ReActStep[]
  totalToolCalls: number
  callbacks: ReActLoopCallbacks
}): Promise<void>
```

#### `agent/interactive/parser.ts`

```ts
import { ALLOWED_CATEGORIES, ALLOWED_TYPES } from './constants'

export function parseInteractiveArgs(id: string, argsStr: string): InteractiveRequest | null
```

#### `agent/interactive/validator.ts`

```ts
export function validateChoice(choice: string[], request: InteractiveRequest): void
// 抛 AppError('choice_invalid', '...') 表示失败
```

#### `agent/interactive/constants.ts`

```ts
export const ALLOWED_CATEGORIES = new Set(['', 'diet', 'cuisine', 'taste', 'skill', 'scene', 'allergy'] as const)
export const ALLOWED_TYPES = ['choice', 'text', 'confirm', 'slider'] as const
export const INTERACTIVE_TOOL_NAMES = new Set(['ask_user_choice'] as const)
```

#### `http/sse.ts`

```ts
export interface SSEResponse {
  send: (event: string, data: object) => void
  abort: () => void
  on: {
    onClientClose: (handler: () => void) => void
    onFirstChunk: (handler: () => void) => void
  }
  isWritable: () => boolean
  end: () => void
}

export function createSSEResponse(req: Request, res: Response): SSEResponse
```

#### `http/error-handler.ts`

```ts
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400,
  ) { super(message) }
}

export class NotFoundError extends AppError { constructor(what: string) { super('not_found', `${what} 不存在`, 404) } }
export class ValidationError extends AppError { constructor(msg: string) { super('validation', msg, 400) } }
export class StaleInteractiveError extends AppError { constructor(msg: string) { super('stale_interactive', msg, 410) } }

// Express error-handling middleware
export function errorMiddleware(err: Error, _req, res, _next): void
```

### 1.3 `agent.ts` 改造后结构

```ts
export class CookingAgent {
  // ── Public API（对外契约保持不变） ──
  chat(userMessage: string, sessionId?: string): Promise<ChatResult>
  chatStream(...): Promise<void>
  resumeInteractive(...): Promise<void>
  cancelInteractive(sessionId: string, interactiveId: string): Promise<...>
  undoLastInteractive(sessionId: string): Promise<...>
  listSessions(): Promise<SessionRow[]>
  clearSession(sessionId: string): Promise<void>
  getHistory(sessionId: string): Promise<Message[]>

  // ── Static（保持原状） ──
  static startInteractiveTimeoutWatcher(): void
  static stopInteractiveTimeoutWatcher(): void
  static cleanupStaleInteractives(): Promise<{ cleaned: number }>
}
```

**实现内部**：私有方法改为调用 `runReActLoop` / `finalizeStream` / `parseInteractiveArgs` / `validateChoice` 等。

### 1.4 `index.ts` 改造后结构

```ts
import { mountChatRoutes } from './routes/chat.routes'
import { mountInteractiveRoutes } from './routes/interactive.routes'
import { mountSessionRoutes } from './routes/session.routes'
import { mountProfileRoutes } from './routes/profile.routes'
import { mountVisionRoutes } from './routes/vision.routes'
import { mountHealthRoutes } from './routes/health.routes'
import { errorMiddleware } from './http/error-handler'
import { rateLimiterMiddleware } from './http/rate-limiter'

async function start(): Promise<void> {
  await runMigrations()
  const agent = new CookingAgent()
  CookingAgent.startInteractiveTimeoutWatcher()

  const app = express()
  app.use(cors(), express.json({ limit: '20mb' }), rateLimiterMiddleware, requestLogMiddleware)

  mountHealthRoutes(app)
  mountChatRoutes(app, agent)
  mountInteractiveRoutes(app, agent)
  mountSessionRoutes(app, agent)
  mountProfileRoutes(app)
  mountVisionRoutes(app)

  app.use(notFoundHandler, errorMiddleware)
  app.listen(PORT, ...)
}
```

**预期行数**：`agent.ts` 1562 → ~150；`index.ts` 784 → ~50。

---

## 2. 前端重构方案（cooking-app）

### 2.1 目录结构改造

```
src/
├── api/
│   ├── client.ts                   # Axios 实例 + 拦截器
│   ├── sse.ts                      # consumeSSEStream + startSSE 通用方法
│   ├── chat.ts                     # 现有方法（去掉内联 SSE 解析）
│   ├── session.ts                  # 会话管理
│   ├── profile.ts                  # 用户画像
│   └── vision.ts                   # 图片识别
├── types/
│   ├── shared.ts                   # InteractiveRequest / ToolCall / Message 等（与后端 schema 对齐）
│   ├── chat.ts                     # ChatMessage / ChatSession
│   └── api.ts                      # ChatResponse / SSEEvent
├── lib/
│   ├── stream-controller.ts        # 计时器 + AbortController 抽象类
│   ├── interactive-registry.ts     # 类型 → 组件映射
│   └── markdown.ts                 # marked 封装 + debounce
├── hooks/
│   ├── useChatStream.ts            # 单一职责：消费 SSE 流
│   ├── useConversation.ts          # 改造后 < 200 行
│   ├── useHealthCheck.ts           # 不变
│   └── useScrollToBottom.ts        # 不变
├── components/
│   ├── interactive/
│   │   ├── InteractiveCard.vue     # 按 type 分发
│   │   ├── ChoiceButtons.vue       # 单选/多选按钮组
│   │   ├── TextInput.vue           # 自由文本
│   │   ├── ConfirmDialog.vue       # 确认弹窗
│   │   ├── SliderInput.vue         # 数值滑块
│   │   └── ImageChoice.vue         # 配图选项
│   ├── MessageBubble.vue
│   ├── MessageList.vue
│   ├── InputBar.vue
│   ├── SidebarPanel.vue
│   ├── ProfileSettings.vue
│   └── WelcomeScreen.vue
└── stores/
    └── chat.ts                     # 调整：useChatStream 写在 actions 里
```

### 2.2 关键模块契约

#### `api/sse.ts`

```ts
export interface SSEHandlers {
  onChunk?: (data: { content: string }) => void
  onToolCallDelta?: (data: { tool_calls: ToolCallDelta[] }) => void
  onToolCalls?: (data: { content: string; tool_calls: ToolCall[]; sessionId: string }) => void
  onInteractiveRequest?: (data: InteractiveRequestEvent) => void
  onDone?: (data: { content: string; sessionId: string; finish_reason: FinishReason }) => void
  onError?: (data: { error: string }) => void
}

export async function consumeSSEStream(
  response: Response,
  handlers: SSEHandlers,
  signal?: AbortSignal,
): Promise<void>
```

#### `lib/stream-controller.ts`

```ts
export type StreamEvent = 'start' | 'chunk' | 'tool' | 'interactive' | 'done'

export interface StreamControllerOptions {
  hardTimeoutMs: number
  inactivityTimeoutMs: number
  stuckHintMs?: number
  onHardTimeout: () => void
  onInactivityTimeout: () => void
  onStuckHint: () => void
  onEvent: (event: StreamEvent) => void
}

export class StreamController {
  constructor(opts: StreamControllerOptions)
  start(): AbortSignal
  stop(): void
  notify(event: Exclude<StreamEvent, 'start' | 'done'>): void
  complete(): void
}
```

**收益**：`useConversation` 不再持有 13 个模块级变量；可被 `useChatStream` 复用。

#### `api/chat.ts` 改造

```ts
export function sendChatStream(
  message: string,
  sessionId: string,
  handlers: SSEHandlers,
  signal?: AbortSignal,
): AbortSignal

export function continueInteractive(
  sessionId: string,
  interactiveId: string,
  choice: string[],
  handlers: SSEHandlers,
  signal?: AbortSignal,
): AbortSignal
```

**注意**：函数体只负责 `fetch` + 调用 `consumeSSEStream`。所有 SSE 解析逻辑在 `api/sse.ts` 单一定义。

#### `types/shared.ts`

```ts
// 与后端 src/types.ts + agent/interactive/schema.ts 严格对齐
export const INTERACTIVE_CATEGORIES = ['', 'diet', 'cuisine', 'taste', 'skill', 'scene', 'allergy'] as const
export const INTERACTIVE_TYPES = ['choice', 'text', 'confirm', 'slider'] as const

export interface InteractiveRequest {
  id: string
  question: string
  options: string[]
  multiSelect: boolean
  category: typeof INTERACTIVE_CATEGORIES[number]
  type: typeof INTERACTIVE_TYPES[number]
  meta: Record<string, unknown>
  optionImages: (string | null)[]
  validation: {
    regex?: string
    minLength?: number
    maxLength?: number
  }
}

export interface InteractiveRequestEvent extends InteractiveRequest {
  isReinteractive: boolean
  round: number
}
```

#### `components/interactive/InteractiveCard.vue`

```vue
<template>
  <component
    :is="componentFor(request.type)"
    :request="request"
    :resolved="resolved"
    :choice="choice"
    :submitting="submitting"
    @select="emit('select', $event)"
  />
</template>

<script setup lang="ts">
import { componentFor } from '@/lib/interactive-registry'
defineProps<{ request: InteractiveRequest; resolved: boolean; choice?: string[]; submitting: boolean }>()
const emit = defineEmits<{ (e: 'select', choice: string[]): void }>()
</script>
```

#### `lib/interactive-registry.ts`

```ts
import ChoiceButtons from '@/components/interactive/ChoiceButtons.vue'
import TextInput from '@/components/interactive/TextInput.vue'
import ConfirmDialog from '@/components/interactive/ConfirmDialog.vue'
import SliderInput from '@/components/interactive/SliderInput.vue'
import type { InteractiveType } from '@/types/shared'

const REGISTRY: Record<InteractiveType, Component> = {
  choice: ChoiceButtons,
  text: TextInput,
  confirm: ConfirmDialog,
  slider: SliderInput,
}

export function componentFor(type: InteractiveType): Component {
  return REGISTRY[type] ?? ChoiceButtons
}
```

### 2.3 `useConversation.ts` 改造后结构

```ts
export function useConversation() {
  const store = useChatStore()
  const controller = new StreamController({
    hardTimeoutMs: STREAM_HARD_TIMEOUT_MS,
    inactivityTimeoutMs: STREAM_INACTIVITY_MS,
    onHardTimeout: () => { ... },
    onInactivityTimeout: () => { ... },
    onEvent: (e) => { /* 不再需要模块级 lastEvent */ },
  })

  async function sendMessage(content: string): Promise<void> { ... }
  async function sendVisionMessage(imageBase64: string, text?: string): Promise<void> { ... }
  async function submitInteractiveChoice(interactiveId: string, choice: string[]): Promise<void> { ... }

  return { sendMessage, sendVisionMessage, submitInteractiveChoice, stopGeneration: () => controller.stop() }
}
```

**预期行数**：631 → ~200。`sendMessage` 和 `submitInteractiveChoice` 抽 `streamAssistantMessage({ payload, hooks })` 工厂消除重复。

---

## 3. 前后端共享契约

### 3.1 类型同步策略

短期：手工同步 + CI 检查类型一致性（用 `tsc --noEmit` + 注释标记）

长期：方案 A — 把后端 `types.ts` 编译为 `dist/types.d.ts`，前端用 `paths` 引用

```jsonc
// cooking-app/tsconfig.json
{
  "compilerOptions": {
    "paths": {
      "@shared/*": ["../cooking-agent/src/*"]
    }
  }
}
```

方案 B — 用 `zod` 定义 schema，前后端各自动推导 TypeScript 类型：

```ts
// shared/interactive.schema.ts
export const InteractiveRequestSchema = z.object({
  id: z.string(),
  question: z.string(),
  options: z.array(z.string()),
  multiSelect: z.boolean(),
  category: z.enum(INTERACTIVE_CATEGORIES),
  type: z.enum(INTERACTIVE_TYPES),
  meta: z.record(z.unknown()),
  optionImages: z.array(z.string().nullable()),
  validation: z.object({
    regex: z.string().optional(),
    minLength: z.number().optional(),
    maxLength: z.number().optional(),
  }),
})

export type InteractiveRequest = z.infer<typeof InteractiveRequestSchema>
```

**推荐方案 B**（zod）— 同时获得 runtime 校验能力。

### 3.2 交互式工具协议对齐

| 字段 | 后端 `agent.ts` | 前端 `types/index.ts` | 一致？ |
|---|---|---|---|
| id | ✅ | ✅ | ✅ |
| question | ✅ | ✅ | ✅ |
| options | ✅ | ✅ | ✅ |
| multiSelect | ✅ | ✅ | ✅ |
| category | ✅ | ❌ | ❌ |
| type | ✅ | ❌ | ❌ |
| meta | ✅ | ❌ | ❌ |
| optionImages | ✅ | ❌ | ❌ |
| validation | ✅ | ❌ | ❌ |
| isReinteractive | ✅ | ❌ | ❌ |
| round | ✅ | ❌ | ❌ |

**结论**：10 个字段不一致，重构后必须 100% 对齐。

---

## 4. 风险评估

| 风险 | 等级 | 缓解措施 |
|---|---|---|
| 重构期间行为偏差 | 中 | 每步重构后跑端到端：① 健康检查 ② 流式问答 ③ 交互式问答 ④ 取消/撤销 ⑤ 用户偏好回显 |
| 前端 InteractiveRequest 字段补齐会改变 `InteractiveChoiceCard` props 签名 | 低 | 用 `withDefaults` + `as InteractiveRequest` 做渐进迁移 |
| StreamController 抽象与原模块级状态行为差异 | 中 | 保留 `currentAIMsg` 引用语义；保留 `lastEvent` 状态机 |
| `runReActLoop` 抽象使 `agent.ts` 调试栈变深 | 低 | 在调试日志中标注 `phase=react-loop` 标签 |
| 跨模块循环依赖 | 低 | `interactive/parser.ts` 不依赖 agent.ts；`react-loop.ts` 只依赖 parser + persister |

---

## 5. 实施步骤

| 步骤 | 内容 | 验收标准 | 估时 |
|---|---|---|---|
| **Step 1** | 删除 `useSSEStream.ts` 死代码；新增 `api/sse.ts` 抽 `consumeSSEStream`；改造 `api/chat.ts` 两个流共用 | `tsc --noEmit` 通过；3 个核心 E2E 通过 | 0.5d |
| **Step 2** | 新建 `http/sse.ts` + `http/error-handler.ts`；三个 SSE 端点壳化；`index.ts` 引入路由分层 | 端到端 SSE 行为不变；错误返回 4xx/5xx 区分 | 0.5d |
| **Step 3** | 抽 `agent/react-loop.ts` + `agent/stream-finalizer.ts`；`chatStream` / `resumeInteractive` 改写 | agent.ts < 800 行；所有 P0~P3 行为不变 | 1d |
| **Step 4** | 抽 `agent/interactive/{parser,validator,constants,schema}.ts`；删除 `parseInteractiveArgs` 在 `resumeInteractive` 内的重复实现 | 单元测试覆盖各类型分支 | 0.5d |
| **Step 5** | 抽 `agent/preferences/{prompt,categories}.ts`；清理 `agent.ts` 中的 `buildPreferencesPrompt` | — | 0.3d |
| **Step 6** | 同步前端 `types/shared.ts` 完整 InteractiveRequest 字段；改造 `api/chat.ts` SSE 解析保留全部字段 | tsc 通过；可视化检查 SSE 数据 | 0.3d |
| **Step 7** | 拆分 `InteractiveChoiceCard.vue` → `interactive/{InteractiveCard,ChoiceButtons,TextInput,ConfirmDialog,SliderInput,ImageChoice}.vue` | 4 种 type 全部可渲染 | 1d |
| **Step 8** | 抽 `lib/stream-controller.ts` + `hooks/useChatStream.ts`；重写 `useConversation.ts` < 200 行 | useConversation.ts < 250 行；所有 hook 行为不变 | 0.5d |
| **Step 9** | 引入 zod 共享 schema（`shared/*.schema.ts`） | 后端启动时 zod 校验 .env；前端路由守卫校验 body | 1d |
| **Step 10** | 加 vitest 单测覆盖：parseInteractiveArgs / validateChoice / buildPreferencesPrompt / runReActLoop | 覆盖率 > 70% | 1d |

**总估时**：约 6.5 人天（单人顺序执行）

---

## 6. 重构前后对比

| 指标 | 重构前 | 重构后 |
|---|---|---|
| `agent.ts` 行数 | 1562 | ~150 |
| `index.ts` 行数 | 784 | ~50 |
| `useConversation.ts` 行数 | 631 | ~200 |
| `InteractiveChoiceCard.vue` 行数 | 167 | 30（壳） + 4×30 子组件 |
| `api/chat.ts` 行数 | 626 | ~200 |
| `useSSEStream.ts` 死代码 | 189 | 0（删除） |
| 重复 SSE 解析 | 2 份 | 1 份 |
| 重复 ReAct 循环 | 2 份 | 1 份 |
| 重复计时器管理 | 2 份 | 1 份 |
| 重复参数白名单 | 2 份 | 1 份 |
| 前端 `InteractiveRequest` 字段 | 4 | 10 |
| 单元测试 | 0 | 70% 覆盖 |

---

## 7. 待确认问题

1. **共享类型方案** — 手工同步 vs zod schema 自动推导，团队倾向？
2. **重构顺序** — 建议 Step 1→10 顺序执行；是否需要拆分多个 PR？
3. **行为保持期** — 重构期间对外 API（含 SSE 事件）是否需要 100% 保持不变？
4. **测试基线** — 是否有可参照的 E2E 测试脚本？还是本次需要补？
5. **InteractiveChoiceCard 的 P2-9/10/11 扩展** — 是在 Step 7 一起做，还是单独排期？

---

**评审通过后**，按 Step 1→10 顺序执行，每步独立提交 + 跑回归。
