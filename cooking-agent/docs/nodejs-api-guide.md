# Node.js 接口开发指南

> 基于 cooking-agent 项目的实战总结，涵盖 Express + TypeScript + SQLite 技术栈的接口开发全流程。
>
> **配套深度文档**：[interactive-dialogue-deep-dive.md §12](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-agent/docs/interactive-dialogue-deep-dive.md) — SSE 三标记守卫的状态机详解（`finished` / `hasStreamed` / `writableEnded` 的精确分工与避坑指南）

---

## 目录

1. [项目结构](#1-项目结构)
2. [技术选型](#2-技术选型)
3. [Express 服务搭建](#3-express-服务搭建)
4. [中间件配置](#4-中间件配置)
5. [路由设计](#5-路由设计)
6. [SSE 流式接口](#6-sse-流式接口)
7. [数据库设计](#7-数据库设计)
8. [Repository 模式](#8-repository-模式)
9. [数据库迁移](#9-数据库迁移)
10. [错误处理](#10-错误处理)
11. [TypeScript 配置](#11-typescript-配置)
12. [环境变量管理](#12-环境变量管理)
13. [构建与部署](#13-构建与部署)
14. [注意事项清单](#14-注意事项清单)

---

## 1. 项目结构

```
cooking-agent/
├── src/
│   ├── index.ts              # 入口文件：Express 服务启动、路由注册
│   ├── agent.ts              # Agent 核心类（业务逻辑）含 chat / chatStream / resumeInteractive
│   ├── types.ts              # 全局类型定义（含 ContinueRequestBody）
│   ├── prompts.ts            # 系统提示词构建
│   ├── loader.ts             # Skill 文件加载器
│   ├── db/
│   │   ├── index.ts          # 数据库连接管理（单例）
│   │   ├── migrate.ts        # 数据库迁移（建表/加列）
│   │   ├── session.repository.ts  # 会话数据访问层
│   │   ├── message.repository.ts  # 消息数据访问层
│   │   └── user-profile.repository.ts # 用户画像
│   └── tools/
│       ├── index.ts          # 工具注册表 + 执行调度（含 INTERACTIVE_TOOL_NAMES）
│       ├── types.ts          # 工具体系类型定义
│       ├── recipe.ts         # 菜谱查询工具
│       ├── nutrition.ts      # 营养计算工具
│       ├── safety.ts         # 食品安全工具
│       ├── technique.ts      # 烹饪技法工具
│       ├── suggest.ts        # 菜品推荐工具
│       ├── substitute.ts     # 食材替换工具
│       ├── diet.ts           # 膳食模式适配工具
│       ├── knowledge.ts      # RAG 知识检索工具
│       └── ask-user.ts       # 交互式工具（人机协作入口）
├── skills/                   # Skill 定义（.md 文件）
│   ├── recipe.md
│   ├── nutrition.md
│   ├── safety.md
│   ├── technique.md
│   └── suggest.md
├── data/                     # SQLite 数据库文件（运行时生成）
├── .env                      # 环境变量（不提交到 Git）
├── package.json
├── tsconfig.json
└── .gitignore
```

**分层原则：**

| 层级 | 目录 | 职责 |
|------|------|------|
| 接口层 | `src/index.ts` | HTTP 路由、请求校验、响应格式化 |
| 业务层 | `src/agent.ts` | Agent 核心逻辑、ReAct 推理循环 |
| 数据层 | `src/db/` | 数据库连接、Repository、迁移 |
| 工具层 | `src/tools/` | Function Calling 工具定义与实现 |
| 知识层 | `skills/` | Skill 定义（Markdown 格式） |

---

## 2. 技术选型

| 技术 | 用途 | 选型理由 |
|------|------|----------|
| **Express** | HTTP 框架 | 轻量、生态成熟、中间件机制完善 |
| **TypeScript** | 类型安全 | 编译期类型检查，减少运行时错误 |
| **better-sqlite3** | 数据库 | 同步 API、零配置、嵌入式、性能优秀 |
| **openai** | LLM SDK | 兼容 DeepSeek API，支持 Function Calling + Streaming |
| **dotenv** | 环境变量 | 从 `.env` 文件加载配置，避免硬编码 |
| **cors** | 跨域 | 允许前端跨域访问 |
| **tsx** | 开发热重载 | `tsx watch` 监听文件变更自动重启 |

---

## 3. Express 服务搭建

### 3.1 基本骨架

```typescript
import express from 'express'
import cors from 'cors'
import 'dotenv/config'

const app = express()
const PORT = Number(process.env.PORT) || 9000

// 中间件
app.use(cors())
app.use(express.json())

// 路由
app.get('/health', (req, res) => { ... })
app.post('/api/chat', async (req, res) => { ... })

// 启动
app.listen(PORT, () => {
  console.log(`服务已启动：http://localhost:${PORT}`)
})
```

### 3.2 关键注意事项

- **`dotenv/config` 必须在最顶部 import**，确保后续代码能读到环境变量
- **端口使用 `process.env.PORT`**，方便容器化部署时动态指定
- **`express.json()` 必须注册**，否则 `req.body` 为 `undefined`

---

## 4. 中间件配置

### 4.1 CORS

```typescript
app.use(cors())
```

- **开发环境**：允许所有来源（`cors()` 无参数）
- **生产环境**：建议限制为具体域名

```typescript
app.use(cors({
  origin: 'https://your-frontend-domain.com',
  methods: ['GET', 'POST', 'DELETE'],
}))
```

### 4.2 JSON 解析

```typescript
app.use(express.json())
```

- 自动将 `Content-Type: application/json` 的请求体解析为 JS 对象
- 默认限制 100kb，大文件上传需调整 `express.json({ limit: '10mb' })`

### 4.3 中间件注册顺序

```
cors() → express.json() → 路由 → 404处理 → 全局错误处理
```

顺序很重要：CORS 必须最先注册，否则预检请求（OPTIONS）可能被拦截。

---

## 5. 路由设计

### 5.1 RESTful 规范

| 方法 | 路径 | 用途 |
|------|------|------|
| `GET` | `/health` | 健康检查 |
| `POST` | `/api/chat` | 普通对话（非流式） |
| `POST` | `/api/chat/stream` | 流式对话（SSE） |
| `POST` | `/api/chat/continue` | 续点：恢复被交互式工具暂停的 SSE 流 |
| `POST` | `/api/vision/chat` | 图片识别对话 |
| `GET` | `/api/sessions` | 获取会话列表 |
| `GET` | `/api/history/:sessionId` | 获取对话历史 |
| `DELETE` | `/api/session/:sessionId` | 清除会话 |
| `GET` | `/api/profile` | 获取用户画像 |
| `PUT` | `/api/profile` | 更新用户画像 |

### 5.2 路由编写规范

```typescript
app.post('/api/chat', async (req, res) => {
  // 1. 参数校验（尽早返回 400）
  const { message } = req.body
  if (!message || typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: '请提供有效的 message 字段' })
    return  // ⚠️ 必须 return，否则继续执行
  }

  try {
    // 2. 调用业务逻辑
    const result = await agent.chat(message, sessionId)

    // 3. 返回成功响应
    res.json(result)
  } catch (err) {
    // 4. 统一错误处理
    res.status(500).json({
      error: '调用失败',
      detail: (err as Error).message,
    })
  }
})
```

### 5.3 关键注意事项

- **参数校验后必须 `return`**，否则代码会继续执行到 `res.json()`
- **TypeScript 泛型约束**：`req: Request<Params, ResBody, ReqBody>` 提供类型安全
- **异步路由必须 try/catch**，Express 4 不会自动捕获 async 函数的异常
- **日志分级**：`console.info` 记录正常请求，`console.warn` 记录参数异常，`console.error` 记录系统错误

---

## 6. SSE 流式接口

### 6.1 SSE 协议要点

SSE（Server-Sent Events）是一种服务端向客户端推送数据的协议，比 WebSocket 更轻量。

**消息格式：**
```
event: chunk
data: {"content": "你好"}

event: done
data: {"content": "完整文本", "sessionId": "xxx"}

event: interactive_request
data: {"interactiveId": "tool_call_xxx", "question": "...", "options": ["A","B"], "multiSelect": false}

event: error
data: {"error": "错误描述"}
```

每条消息以 `\n\n` 结尾作为分隔符。

**事件类型一览：**

| 事件 | data 字段 | 触发时机 |
|------|----------|---------|
| `chunk` | `{ content: string }` | LLM 输出每个 token |
| `done` | `{ content, sessionId, finish_reason? }` | 流正常结束 |
| `interactive_request` | `{ interactiveId, question, options, multiSelect }` | LLM 调用 ask_user_choice |
| `error` | `{ error: string }` | LLM/工具/SSE 异常 |

### 6.2 完整实现

```typescript
app.post('/api/chat/stream', async (req, res) => {
  const { message, sessionId = 'default' } = req.body

  // 参数校验
  if (!message?.trim()) {
    res.status(400).json({ error: '请提供有效的 message 字段' })
    return
  }

  // ═══ 设置 SSE 响应头 ═══
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')  // Nginx 禁用缓冲
  res.flushHeaders()  // 立即发送 HTTP 头

  // 事件发送工具函数
  const sendEvent = (event: string, data: object) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  // 中止信号
  const abortController = new AbortController()
  let finished = false
  let hasStreamed = false

  req.on('close', () => {
    if (!finished && !res.writableEnded && hasStreamed) {
      abortController.abort()
    }
  })

  try {
    await agent.chatStream(
      message,
      sessionId,
      (chunk) => {
        hasStreamed = true
        if (!res.writableEnded) sendEvent('chunk', { content: chunk })
      },
      (full) => {
        finished = true
        if (!res.writableEnded) {
          sendEvent('done', { content: full, sessionId })
          res.end()
        }
      },
      abortController.signal,
      // 交互式工具触发：下发 interactive_request 事件后由路由主动 res.end()
      (interactiveReq) => {
        hasStreamed = true
        if (!res.writableEnded) {
          sendEvent('interactive_request', {
            interactiveId: interactiveReq.id,
            question:     interactiveReq.question,
            options:      interactiveReq.options,
            multiSelect:  interactiveReq.multiSelect,
          })
        }
      },
    )
  } catch (err) {
    finished = true
    if (!res.writableEnded) {
      sendEvent('error', { error: (err as Error).message })
      res.end()
    }
  }

  // 因交互式工具暂停：agent 不调 onDone，路由主动结束 SSE
  if (!finished && !res.writableEnded) {
    res.end()
  }
})
```

### 6.3 关键注意事项

| 要点 | 说明 |
|------|------|
| **`res.flushHeaders()`** | 必须先 flush，否则浏览器收不到 SSE 头 |
| **`X-Accel-Buffering: no`** | Nginx 反向代理时必须设置，否则会缓冲整个响应 |
| **`Cache-Control: no-cache`** | 禁止浏览器缓存 SSE 流 |
| **`res.end()`** | 流结束后必须调用，否则连接不会释放 |
| **错误也要 `res.end()`** | catch 块中发送 error 事件后也要 end，否则连接泄漏 |
| **`\n\n` 分隔符** | 必须严格两个换行，否则客户端解析失败 |
| **交互式暂停要 `res.end()`** | agent 因 `paused=true` 不调 `onDone`，路由必须主动关闭 |
| **三标记防误关闭** | `finished` / `hasStreamed` / `writableEnded` 配合，区分正常完成 / 客户端断开 / 已结束 |

### 6.4 前端接收 SSE

```typescript
const eventSource = new EventSource('/api/chat/stream')

eventSource.addEventListener('chunk', (e) => {
  const { content } = JSON.parse(e.data)
  // 追加文本
})

eventSource.addEventListener('done', (e) => {
  const { content, sessionId } = JSON.parse(e.data)
  eventSource.close()
})

eventSource.addEventListener('interactive_request', (e) => {
  const req = JSON.parse(e.data)
  // 弹出选项卡片 / 渲染单选组件
  // 用户点击后调 POST /api/chat/continue
})

eventSource.addEventListener('error', (e) => {
  eventSource.close()
})
```

### 6.5 续点端点 `/api/chat/continue`

当 SSE 流因 `interactive_request` 事件被关闭后，前端在用户完成选择后调用此端点开新流继续生成。

**请求：**

```http
POST /api/chat/continue
Content-Type: application/json

{
  "sessionId": "abc123",
  "interactiveId": "tool_call_xxx",
  "choice": ["川菜"]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | `string` | ❌ | 会话 ID，默认 `'default'` |
| `interactiveId` | `string` | ✅ | LLM 下发的 tool_call.id，与 interactive_request 事件的 interactiveId 一致 |
| `choice` | `string[]` | ✅ | 用户选择的选项（多选时为多个元素） |

**响应（SSE 流）：**

```
event: chunk
data: {"content":"好，川菜口味偏重…"}

event: done
data: {"content":"完整回答","sessionId":"abc123"}
```

事件类型与 `/api/chat/stream` 完全一致（`chunk` / `done` / `interactive_request` / `error`），**但 `interactive_request` 可能再触发**——一次会话中可连续多次追问。

**完整实现：**

```typescript
interface ContinueRequestBody {
  sessionId?: string
  interactiveId: string
  choice: string[]
}

app.post(
  '/api/chat/continue',
  async (req: Request<object, object, ContinueRequestBody>, res: Response) => {
    const { sessionId = 'default', interactiveId, choice } = req.body

    // 参数校验
    if (!interactiveId || typeof interactiveId !== 'string') {
      res.status(400).json({ error: '请提供有效的 interactiveId' })
      return
    }
    if (!Array.isArray(choice) || choice.length === 0) {
      res.status(400).json({ error: '请提供至少一个 choice' })
      return
    }

    // 同样的 SSE 头
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    const sendEvent = (event: string, data: object) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    const abortController = new AbortController()
    let finished = false

    req.on('close', () => {
      if (!finished && !res.writableEnded) abortController.abort()
    })

    try {
      await agent.resumeInteractive(
        sessionId,
        interactiveId,
        choice,
        (chunk) => { if (!res.writableEnded) sendEvent('chunk', { content: chunk }) },
        (full) => {
          finished = true
          if (!res.writableEnded) {
            sendEvent('done', { content: full, sessionId })
            res.end()
          }
        },
        (interactiveReq) => {
          if (!res.writableEnded) {
            sendEvent('interactive_request', {
              interactiveId: interactiveReq.id,
              question:     interactiveReq.question,
              options:      interactiveReq.options,
              multiSelect:  interactiveReq.multiSelect,
            })
          }
        },
        abortController.signal,
      )
    } catch (err) {
      finished = true
      if (!res.writableEnded) {
        sendEvent('error', { error: (err as Error).message })
        res.end()
      }
    }

    if (!finished && !res.writableEnded) res.end()
  },
)
```

**关键注意事项：**

| 要点 | 说明 |
|------|------|
| **`interactiveId` 必须来自 LLM** | 不允许前端生成；找不到对应 tool_call → 500 + "会话可能已过期" |
| **`choice` 数组保证非空** | 多选模式必须传全部选项；空数组 → 400 拦截 |
| **SSE 头与 chat/stream 一致** | 前端 fetch 解析逻辑可复用 |
| **续点仍可能再触发交互** | 一次会话支持连续多轮人机协作 |
| **不持久化 user 角色消息** | `role=tool` 消息由 agent 内部写入，POST 请求体只传选择 |

### 6.6 端到端时序

```
┌─────────┐                                ┌─────────┐                ┌─────────┐
│ 浏览器  │                                │ Express │                │  Agent  │
└────┬────┘                                └────┬────┘                └────┬────┘
     │  POST /api/chat/stream { message }       │                            │
     │──────────────────────────────────────────>│                            │
     │                                           │  agent.chatStream(        │
     │                                           │     onChunk, onDone,      │
     │                                           │     onInteractive)        │
     │                                           │───────────────────────────>│
     │                                           │                            │
     │  event: chunk { content: "思考" }         │                            │
     │<──────────────────────────────────────────│                            │
     │  event: chunk { content: "中..." }        │                            │
     │<──────────────────────────────────────────│                            │
     │  event: interactive_request              │                            │
     │    { interactiveId, question, options }   │                            │
     │<──────────────────────────────────────────│  onInteractive()           │
     │  (SSE 关闭)                              │──────> res.end()            │
     │                                           │                            │
     │  POST /api/chat/continue                 │                            │
     │    { sessionId, interactiveId, choice }   │                            │
     │──────────────────────────────────────────>│  agent.resumeInteractive(  │
     │                                           │     ...onInteractive)      │
     │                                           │───────────────────────────>│
     │  event: chunk ...                         │                            │
     │<──────────────────────────────────────────│                            │
     │  event: done { content, sessionId }       │                            │
     │<──────────────────────────────────────────│  onDone() → res.end()      │
     │                                           │                            │
```

### 6.7 错误码与提示

| 场景 | 状态码 | 错误信息 |
|------|--------|----------|
| 缺少 `interactiveId` | 400 | 请提供有效的 interactiveId |
| `choice` 数组为空 | 400 | 请提供至少一个 choice |
| 找不到对应 tool_call | 500 | 会话可能已过期，请重新发起对话 |
| 加载会话历史失败 | 500 | 加载历史消息失败（具体错误） |
| 解析 interactive 参数失败 | 500 | 内部参数错误（参数已被 LLM 修改） |
| LLM 持续出错 | 500 | （LLM 错误描述） |

---

## 7. 数据库设计

### 7.1 SQLite 连接管理（单例模式）

```typescript
import Database from 'better-sqlite3'

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) {
    // 确保目录存在
    const dir = path.dirname(DB_PATH)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')     // 写前日志，提升并发性能
    db.pragma('foreign_keys = ON')      // 启用外键约束
  }
  return db
}
```

### 7.2 表结构设计

```sql
-- 会话表
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,        -- 会话唯一标识
  title      TEXT NOT NULL DEFAULT '新对话',
  created_at INTEGER NOT NULL,        -- Unix 时间戳（毫秒）
  updated_at INTEGER NOT NULL
);

-- 消息表
CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,         -- 外键关联 sessions
  role         TEXT NOT NULL CHECK(role IN ('system','user','assistant','tool')),
  content      TEXT NOT NULL,
  tool_call_id TEXT,                  -- tool 消息关联的 tool_call id
  tool_calls   TEXT,                  -- assistant 消息的 tool_calls JSON
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- 索引：加速按会话查询消息
CREATE INDEX IF NOT EXISTS idx_messages_session
  ON messages(session_id, created_at);
```

### 7.3 设计要点

- **时间戳用整数**：`INTEGER` 存 Unix 毫秒时间戳，比字符串更高效
- **外键级联删除**：`ON DELETE CASCADE` 删除会话时自动清理消息
- **CHECK 约束**：限制 role 只能是四种合法值
- **JSON 字段**：`tool_calls` 存 JSON 字符串，读写时序列化/反序列化
- **WAL 模式**：Write-Ahead Logging，读写不互斥，适合并发场景

---

## 8. Repository 模式

### 8.1 设计理念

将数据库操作封装在 Repository 类中，业务层不直接写 SQL。

```
业务层 (agent.ts) → Repository (message.repository.ts) → 数据库 (better-sqlite3)
```

### 8.2 完整示例

```typescript
// message.repository.ts
export class MessageRepository {
  insert(sessionId: string, msg: Message, now: number): MessageRow {
    const db = getDb()
    const toolCallsJson = msg.tool_calls ? JSON.stringify(msg.tool_calls) : null
    const result = db.prepare(
      `INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, msg.role, msg.content, msg.tool_call_id ?? null, toolCallsJson, now)
    return { id: result.lastInsertRowid as number, ... }
  }

  findBySessionId(sessionId: string): MessageRow[] {
    const db = getDb()
    return db.prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC'
    ).all(sessionId) as MessageRow[]
  }

  findHistoryBySessionId(sessionId: string): Message[] {
    const rows = this.findBySessionId(sessionId)
    return rows
      .filter(r => r.role !== 'system')  // 不返回 system prompt
      .map(r => ({
        role: r.role as Message['role'],
        content: r.content,
        tool_call_id: r.tool_call_id ?? undefined,
        tool_calls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined,
      }))
  }

  deleteBySessionId(sessionId: string): number {
    const db = getDb()
    const result = db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId)
    return result.changes  // 返回删除行数
  }

  countBySessionId(sessionId: string): number {
    const db = getDb()
    const row = db.prepare(
      'SELECT COUNT(*) as cnt FROM messages WHERE session_id = ? AND role != ?'
    ).get(sessionId, 'system') as { cnt: number }
    return row.cnt
  }
}

// 导出单例
export const messageRepo = new MessageRepository()
```

### 8.3 关键注意事项

- **导出单例**：`export const xxxRepo = new XxxRepository()`，全局共享一个实例
- **JSON 序列化**：复杂字段（如 `tool_calls`）存 JSON 字符串，读写时转换
- **参数化查询**：使用 `?` 占位符，防止 SQL 注入
- **返回变更数**：DELETE/UPDATE 操作返回 `result.changes`，方便判断是否生效

---

## 9. 数据库迁移

### 9.1 迁移策略

采用**渐进式迁移**：建表用 `CREATE TABLE IF NOT EXISTS`，加列用 `ALTER TABLE ADD COLUMN`。

```typescript
export function runMigrations(): void {
  const db = getDb()

  // 1. 建表（幂等，已存在则跳过）
  db.exec(SCHEMA)

  // 2. 增量迁移：检查列是否存在，不存在则添加
  const cols = db.prepare("PRAGMA table_info('messages')").all() as Array<{ name: string }>
  if (!cols.some(c => c.name === 'tool_calls')) {
    db.exec('ALTER TABLE messages ADD COLUMN tool_calls TEXT')
    console.info('[DB] ✅ 新增 messages.tool_calls 列')
  }
}
```

### 9.2 关键注意事项

- **`CREATE TABLE IF NOT EXISTS`**：幂等建表，重复执行不会报错
- **`PRAGMA table_info`**：查询表结构，判断列是否存在
- **SQLite 限制**：`ALTER TABLE` 只能加列，不能删列或修改列类型
- **迁移在服务启动时执行**：`runMigrations()` 放在 `app.listen()` 之前

---

## 10. 错误处理

### 10.1 分层错误处理

```
路由层 try/catch → 返回 4xx/5xx → 全局错误中间件兜底
```

### 10.2 路由层

```typescript
app.post('/api/chat', async (req, res) => {
  // 参数校验 → 400
  if (!message?.trim()) {
    res.status(400).json({ error: '请提供有效的 message 字段' })
    return
  }

  try {
    const result = await agent.chat(message, sessionId)
    res.json(result)
  } catch (err) {
    // 业务异常 → 500
    res.status(500).json({
      error: '调用失败',
      detail: (err as Error).message,
    })
  }
})
```

### 10.3 全局兜底

```typescript
// 404：路由未匹配
app.use((req, res) => {
  res.status(404).json({ error: '接口不存在' })
})

// 500：未捕获异常
app.use((err, req, res, next) => {
  console.error('[GlobalError]', err)
  res.status(500).json({ error: '服务器内部错误', detail: err.message })
})
```

### 10.4 启动时快速失败

```typescript
try {
  agent = new CookingAgent()
} catch (err) {
  console.error('❌ Agent 初始化失败：', err.message)
  process.exit(1)  // 不让服务以不健康状态启动
}
```

### 10.5 关键注意事项

- **不要暴露内部细节**：生产环境 `detail` 字段应关闭或脱敏
- **快速失败原则**：启动阶段的问题直接 `process.exit(1)`，不让服务带病运行
- **日志分级**：`console.debug`（调试）、`console.info`（正常）、`console.warn`（警告）、`console.error`（错误）

---

## 11. TypeScript 配置

### 11.1 推荐配置

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "CommonJS",
    "moduleResolution": "node",
    "lib": ["ES2020"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

### 11.2 关键配置说明

| 配置项 | 说明 |
|--------|------|
| `strict: true` | 开启所有严格检查，强烈推荐 |
| `noUnusedLocals` | 未使用的局部变量报错，保持代码整洁 |
| `noUnusedParameters` | 未使用的参数报错（Express 中间件可用 `_` 前缀绕过） |
| `sourceMap: true` | 生成 source map，方便生产环境调试 |
| `skipLibCheck: true` | 跳过 `.d.ts` 类型检查，加速编译 |

### 11.3 package.json scripts

```json
{
  "scripts": {
    "build": "tsc",                    // 编译 TypeScript
    "start": "node dist/index.js",     // 启动编译后的 JS
    "dev": "tsx watch src/index.ts",   // 开发模式（热重载）
    "type-check": "tsc --noEmit"       // 仅类型检查，不生成文件
  }
}
```

---

## 12. 环境变量管理

### 12.1 .env 文件

```bash
# .env（不提交到 Git）
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxx
DEEPSEEK_BASE_URL=https://api.deepseek.com
PORT=9000
```

### 12.2 加载方式

```typescript
// 在入口文件最顶部
import 'dotenv/config'

// 使用
const apiKey = process.env.DEEPSEEK_API_KEY
const port = Number(process.env.PORT) || 9000
```

### 12.3 关键注意事项

- **`.env` 加入 `.gitignore`**，防止 API Key 泄露
- **提供 `.env.example`** 模板文件，标注哪些是必填项
- **`dotenv/config` 必须最先 import**，否则后续模块读不到变量
- **启动时校验必填变量**，缺失则 `process.exit(1)` 并给出提示

---

## 13. 构建与部署

### 13.1 构建流程

```bash
# 1. 类型检查
npm run type-check

# 2. 编译
npm run build

# 3. 启动
npm start
```

### 13.2 目录结构（编译后）

```
dist/
├── index.js          # 编译后的入口
├── agent.js
├── types.js
├── prompts.js
├── loader.js
├── db/
│   ├── index.js
│   ├── migrate.js
│   ├── session.repository.js
│   └── message.repository.js
└── tools/
    ├── index.js
    ├── types.js
    └── ...
```

### 13.3 关键注意事项

- **`rootDir: "src"`**：确保编译输出结构与源码一致
- **`outDir: "dist"`**：编译产物统一输出到 dist 目录
- **`skills/` 目录**：`.md` 文件不会被 TypeScript 编译，运行时通过 `fs.readFileSync` 读取
- **`data/` 目录**：数据库文件运行时自动创建，不需要预先存在
- **生产环境建议**：使用 PM2 或 Docker 管理进程，配置自动重启

---

## 14. 注意事项清单

### 启动阶段

- [ ] `.env` 文件存在且包含必填的 `DEEPSEEK_API_KEY`
- [ ] 端口未被占用（`netstat -ano | findstr :9000`）
- [ ] `data/` 目录有写入权限
- [ ] 数据库迁移在 `app.listen()` 之前执行

### 路由设计

- [ ] 参数校验后必须 `return`，防止继续执行
- [ ] 异步路由必须 `try/catch`
- [ ] 404 和全局错误中间件放在所有路由之后
- [ ] RESTful 路径使用复数名词（`/api/sessions` 而非 `/api/session`）

### SSE 接口

- [ ] 设置 `Content-Type: text/event-stream`
- [ ] 调用 `res.flushHeaders()` 立即发送头
- [ ] 设置 `X-Accel-Buffering: no`（Nginx 场景）
- [ ] 错误和正常结束都要调用 `res.end()`
- [ ] 消息以 `\n\n` 结尾
- [ ] 交互式工具触发时下发 `interactive_request` 事件后**主动 `res.end()`**
- [ ] `/api/chat/continue` 端点校验 `interactiveId` 和非空 `choice`
- [ ] 续点 SSE 头与 `chat/stream` 完全一致，前端可复用同一解析器
- [ ] 用 `finished` / `hasStreamed` / `writableEnded` 三标记防 `req.on('close')` 误关闭

### 交互式工具

- [ ] 所有交互式工具在 `INTERACTIVE_TOOL_NAMES` 中登记
- [ ] 工具 `options` 长度 2-4，`description` 强调调用场景
- [ ] `multiSelect` 默认 false，前端多选 UI 需明确勾选
- [ ] 服务端不缓存 `interactive_request`，全部来自 LLM tool_call 解析
- [ ] 用户选择超出 `options` 范围时拒绝（前端校验 + 后端信任 LLM 输出）

### 数据库

- [ ] 使用参数化查询（`?` 占位符），防止 SQL 注入
- [ ] 启用 WAL 模式和 foreign_keys
- [ ] JSON 字段读写时序列化/反序列化
- [ ] 迁移脚本幂等（`IF NOT EXISTS`）

### 安全

- [ ] `.env` 加入 `.gitignore`
- [ ] 生产环境 CORS 限制具体域名
- [ ] 错误响应不暴露堆栈信息
- [ ] API Key 只存在于服务端，不返回给前端

### 日志

- [ ] 使用分级日志（debug/info/warn/error）
- [ ] 关键操作记录 sessionId 便于追踪
- [ ] 生产环境考虑使用结构化日志（JSON 格式）

---

## 15. 请求日志中间件

### 15.1 实现

```typescript
app.use((req: Request, _res: Response, next: express.NextFunction) => {
  const start = Date.now()
  const { method, url } = req

  _res.on('finish', () => {
    const duration = Date.now() - start
    const { statusCode } = _res
    const level = statusCode >= 400 ? '⚠️' : '📥'
    console.info(`[HTTP] ${level} ${method} ${url} → ${statusCode} (${duration}ms)`)
  })

  next()
})
```

### 15.2 输出示例

```
[HTTP] 📥 POST /api/chat → 200 (1234ms)
[HTTP] ⚠️ POST /api/chat → 400 (2ms)
[HTTP] 📥 GET /api/sessions → 200 (5ms)
```

### 15.3 关键注意事项

- **监听 `finish` 事件**：在响应发送完成后记录，确保拿到真实状态码
- **记录耗时**：方便性能分析和慢查询排查
- **状态码分级**：4xx/5xx 用 ⚠️ 标记，方便快速定位问题

---

## 16. 请求限流中间件

### 16.1 为什么需要限流

防止恶意高频调用耗尽 LLM API 配额，保护服务稳定性。

### 16.2 简易实现（基于 IP + 滑动窗口）

```typescript
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_MAX = 10        // 每秒最多 10 次
const RATE_LIMIT_WINDOW_MS = 1000

app.use((req: Request, res: Response, next: express.NextFunction) => {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown'
  const now = Date.now()
  const entry = rateLimitMap.get(ip)

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    next()
    return
  }

  entry.count++
  if (entry.count > RATE_LIMIT_MAX) {
    console.warn(`[RateLimit] ⚠️ IP ${ip} 超过限流阈值`)
    res.status(429).json({ error: '请求过于频繁，请稍后再试' })
    return
  }

  next()
})

// 定期清理过期记录（每 60 秒）
setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip)
  }
}, 60_000)
```

### 16.3 关键注意事项

- **定期清理**：防止 Map 无限增长导致内存泄漏
- **429 状态码**：HTTP 标准限流响应码
- **生产环境建议**：使用 `express-rate-limit` 等成熟库

---

## 17. 请求体大小限制

### 17.1 配置

```typescript
app.use(express.json({ limit: '100kb' }))
```

### 17.2 为什么需要

- 防止恶意大请求耗尽服务器内存
- 对话消息通常不超过几 KB，100KB 足够
- 超过限制时 Express 自动返回 413 Payload Too Large

---

## 18. 用户画像接口

### 18.1 接口定义

| 方法 | 路径 | 用途 |
|------|------|------|
| `GET` | `/api/profile` | 获取用户画像 |
| `PUT` | `/api/profile` | 更新用户画像 |

### 18.2 实现

```typescript
// GET /api/profile
app.get('/api/profile', (_req: Request, res: Response) => {
  const profile = userProfileRepo.getOrCreate()
  res.json(profile)
})

// PUT /api/profile
app.put('/api/profile', (req: Request, res: Response) => {
  const { allergies, diet_type, skill_level, disliked, calorie_goal } = req.body
  const profile = userProfileRepo.update('default', {
    allergies, diet_type, skill_level, disliked, calorie_goal,
  })
  res.json(profile)
})
```

### 18.3 数据存储

用户画像存储在 SQLite 的 `user_profiles` 表中，使用 Repository 模式封装数据访问。

---

## 19. LLM Provider 抽象层

### 19.1 设计理念

将 LLM 调用抽象为统一接口，支持多 Provider 切换（DeepSeek、OpenAI 等），业务层无需关心具体实现。

### 19.2 目录结构

```
src/llm/
├── index.ts        # Provider 注册中心 + 工厂函数
├── types.ts        # 统一接口定义
└── deepseek.ts     # DeepSeek Provider 实现
```

### 19.3 使用方式

```typescript
// 获取默认 Provider
const llm = getProvider()

// 按名称获取
const reasoner = getProvider('deepseek-reasoner')

// 按能力分级获取
const fastLLM = getProviderForTier('fast')
const smartLLM = getProviderForTier('smart')
```

### 19.4 扩展新 Provider

只需实现 `LLMProvider` 接口并在 `initProviders()` 中注册即可：

```typescript
class ClaudeProvider implements LLMProvider {
  readonly name = 'Claude'
  readonly model = 'claude-3-opus'
  async chatCompletion(params) { /* ... */ }
  async chatCompletionStream(params, onChunk, onDone, onError) { /* ... */ }
}

// 注册
providers.set('claude', new ClaudeProvider({ ... }))
```

---

## 20. 前端 Axios 封装

### 20.1 为什么用 Axios

- 统一的请求/响应拦截器（日志、错误处理、Token 注入）
- 自动 JSON 转换
- 请求超时控制
- 比原生 fetch 更简洁的 API

### 20.2 实例创建

```typescript
// api/request.ts
import axios from 'axios'
import { BASE_URL } from '@/constants'

const request = axios.create({
  baseURL: BASE_URL,
  timeout: 30_000,
  headers: { 'Content-Type': 'application/json' },
})
```

### 20.3 请求拦截器

```typescript
request.interceptors.request.use((config) => {
  // 注入请求 ID 用于追踪
  config.headers['X-Request-Id'] = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  // 记录请求日志
  console.info(`[Request] 📤 ${config.method?.toUpperCase()} ${config.url}`)
  return config
})
```

### 20.4 响应拦截器

```typescript
request.interceptors.response.use(
  (response) => {
    // 记录成功日志
    console.info(`[Response] ✅ ${response.config.url} → ${response.status}`)
    return response
  },
  (error: AxiosError) => {
    // 统一错误处理
    const apiError = {
      code: error.response?.status ?? 0,
      message: '请求失败',
      detail: error.message,
    }

    // 按状态码分类处理
    switch (error.response?.status) {
      case 400: ElMessage.warning('参数错误'); break
      case 429: ElMessage.warning('请求过于频繁'); break
      case 500: ElMessage.error('服务器内部错误'); break
    }

    return Promise.reject(apiError)
  },
)
```

### 20.5 关键注意事项

- **SSE 流式请求保留 fetch**：Axios 不支持 ReadableStream，流式对话仍用原生 fetch
- **健康检查保留 fetch**：避免被 Axios 拦截器误报错误
- **错误归一化**：所有 HTTP 错误统一为 `{ code, message, detail }` 格式