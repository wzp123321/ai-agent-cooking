# SSE 流式回答渲染指南

> 本文档梳理厨神小助智能体中 SSE (Server-Sent Events) 流式回答的完整渲染链路、各环节细节以及常见问题与解决思路。

---

## 一、整体架构总览

```
┌─────────────────────── 后端 (Express + DeepSeek) ───────────────────────────┐
│                                                                             │
│  POST /api/chat/stream     ← 用户消息                                       │
│       │                                                                     │
│       ▼                                                                     │
│  agent.chatStream()        ← ReAct 推理循环                                 │
│       │                                                                     │
│       │  ┌── step 1~N：工具调用（非流式，内部 ReAct loop）                 │
│       │  │   · callLLMWithRetry → OpenAI SDK chat.completions.create        │
│       │  │   · 返回 tool_calls → 拆分为：                                  │
│       │  │       ├── 普通工具 → executeTools → 结果追加到 messages        │
│       │  │       └── 交互式工具（ask_user_choice）→ 触发 onInteractive 事件│
│       │  │                       → paused=true，跳出循环                  │
│       │  └── 直到 LLM 不再返回 tool_calls → 进入 answer 阶段               │
│       │                                                                     │
│       ▼                                                                     │
│  llm.chatCompletionStream() ← 真正的流式阶段                                │
│       │   · stream: true                                                    │
│       │   · for await (const chunk of stream)                               │
│       │   · onChunk(delta.content) 每次推一个 token 片段                   │
│       ▼                                                                     │
│  sendEvent('chunk', { content })  ← SSE 格式化写入 res.write()             │
│       │                                                                     │
│       ▼                                                                     │
│  sendEvent('done', { content, sessionId })  ← 通知前端流结束                │
│  res.end()                                                                  │
│                                                                             │
│  ┌── 续点通道（交互式工具暂停后） ──────────────────────────────────┐      │
│  POST /api/chat/continue  ← { sessionId, interactiveId, choice }   │      │
│       │                                                             │      │
│       ▼                                                             │      │
│  agent.resumeInteractive()  ← 找到上一轮的 tool_call                │      │
│       │   · 追加 role=tool 的消息（content=user_choice）            │      │
│       │   · 继续 ReAct 循环（可能再次碰到 ask_user_choice）        │      │
│       │   · 最终走流式输出                                         │      │
│       └─────────────────────────────────────────────────────────────┘      │
│                                                                             │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │ SSE (text/event-stream)
                                   ▼
┌─────────────────────── 前端 (Vue + Pinia) ──────────────────────────────────┐
│                                                                             │
│  sendChatStream()           ← 原生 fetch() + ReadableStream + TextDecoder   │
│       │   · 逐行解析 SSE："data: {...}"                                    │
│       │   · 按事件类型分派：                                                │
│       │       chunk              → onChunk                                 │
│       │       done               → onDone                                  │
│       │       interactive_request → onInteractiveRequest (渲染选择卡片)    │
│       │       error              → onError                                 │
│       ▼                                                                     │
│  useConversation.sendMessage()  ← 状态编排层                                │
│       │   · 创建 userMsg（存入 store.sessions[x].messages）                │
│       │   · 创建空 aiMsg（streaming: true）                                │
│       │   · onChunk → aiMsg.content += chunk                               │
│       │   · onInteractiveRequest → aiMsg.interactive = { ... }             │
│       │                              → aiMsg.streaming = false            │
│       │   · onDone  → aiMsg.streaming = false                              │
│       ▼                                                                     │
│  MessageBubble.vue          ← 渲染层                                        │
│       │   · marked.parse(content) → v-html                                │
│       │   · streaming === true → 显示闪烁光标                              │
│       │   · message.interactive && !interactiveResolved                    │
│       │       → <InteractiveChoiceCard> 用户点选后调用 continueInteractive │
│       ▼                                                                     │
│  MessageList.vue + useScrollToBottom  ← 滚到底层                            │
│       │   · watch(messages.map(m => m.content).join(''))                   │
│       │   · nextTick → scrollTop = scrollHeight                            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、各环节详细说明

### 2.1 后端：SSE 服务器推送

| 文件 | 位置 | 职责 |
|------|------|------|
| [index.ts](file:///e:/workspace/private/ai-agent-cooking/cooking-agent/src/index.ts#L234-L287) | `POST /api/chat/stream` | 路由入口，设置 SSE 响应头，编排 sendEvent |
| [agent.ts](file:///e:/workspace/private/ai-agent-cooking/cooking-agent/src/agent.ts#L307-L372) | `chatStream()` | ReAct 循环 + 最终流式生成 |
| [deepseek.ts](file:///e:/workspace/private/ai-agent-cooking/cooking-agent/src/llm/deepseek.ts#L55-L106) | `chatCompletionStream()` | OpenAI SDK 流式调用，逐 chunk 回调 |

**SSE 响应头配置：**

```typescript
res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
res.setHeader('Cache-Control', 'no-cache')
res.setHeader('Connection', 'keep-alive')
res.setHeader('X-Accel-Buffering', 'no')    // ← 关键：禁用 Nginx 缓冲
res.flushHeaders()                           // ← 关键：立即发送 HTTP 头
```

**事件格式：**

```
event: chunk
data: {"content":"好"}

event: chunk
data: {"content":"的"}

event: done
data: {"content":"好的，红烧肉的做法如下...","sessionId":"xxx"}

event: interactive_request
data: {"interactiveId":"tool_call_xxx","question":"你今天想吃什么场景的菜？","options":["早餐","午餐","晚餐"],"multiSelect":false}

event: error
data: {"error":"DeepSeek API 超时"}
```

> **注意**：每两个 SSE 事件之间必须有空行 `\n\n`，这是 SSE 协议的消息分隔符。

**事件类型一览：**

| 事件 | data 字段 | 触发时机 | 前端动作 |
|------|----------|---------|---------|
| `chunk` | `{ content: string }` | LLM 输出每个 token | 追加到 aiMsg.content |
| `done` | `{ content, sessionId, finish_reason? }` | 流正常结束 | 关闭 streaming，刷新历史 |
| `interactive_request` | `{ interactiveId, question, options, multiSelect }` | LLM 调用 ask_user_choice | 渲染 InteractiveChoiceCard，等待用户选择 |
| `error` | `{ error: string }` | LLM/工具/SSE 异常 | 显示错误提示，关闭 loading |

**ReAct 与流式的关系：**

```
用户消息 "红烧肉怎么做"
  │
  ├── ReAct Step 1: LLM 返回 tool_calls → executeTools → 结果追加
  ├── ReAct Step 2: LLM 返回 tool_calls → executeTools → 结果追加
  ├── ...
  └── ReAct Step N: LLM 不再返回 tool_calls → 进入 chatCompletionStream
        │
        └── 只有这最后一步是流式的
```

> **关键限制**：工具调用阶段不会向前端推送任何中间状态。前端的 AI 消息气泡会从空内容开始，等流式阶段才出现文字。如果工具调用耗时很长（多次 Retry），用户会看到长时间无响应。
>
> **特殊工具 ask_user_choice**：当 LLM 调起 `ask_user_choice` 时，Agent 不会执行该工具，而是下发 `interactive_request` SSE 事件后暂停，等待用户在前端选择。详见 [六、交互式工具与续点](#六交互式工具与续点)。

---

### 2.2 前端：SSE 接收与解析

| 文件 | 位置 | 职责 |
|------|------|------|
| [chat.ts](file:///e:/workspace/private/ai-agent-cooking/cooking-app/src/api/chat.ts#L81-L147) | `sendChatStream()` | 原生 fetch + ReadableStream + SSE 行解析 |
| [useConversation.ts](file:///e:/workspace/private/ai-agent-cooking/cooking-app/src/hooks/useConversation.ts#L42-L117) | `sendMessage()` | 消息状态编排 + AI 回复增量追加 |

**SSE 解析核心逻辑：**

```typescript
const reader = response.body!.getReader()   // 获取字节流读取器
const decoder = new TextDecoder()            // 字节 → 字符串
let buffer = ''                              // 行缓冲区

while (true) {
  const { done, value } = await reader.read()
  if (done) break                            // 流自然结束

  buffer += decoder.decode(value, { stream: true })  // stream:true 避免截断多字节字符

  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''                 // 最后一行可能不完整，留在 buffer

  for (const line of lines) {
    // 解析 "data: {...}" 行
    if (line.startsWith('data: ')) {
      const data = JSON.parse(line.slice(6).trim())
      // ── chunk 事件 ──
      if (data.content && !data.sessionId) onChunk(data.content)
      // ── done 事件 ──
      if (data.sessionId)                   onDone(data.content)
      // ── interactive_request 事件 ──
      if (data.interactiveId) {
        onInteractiveRequest({
          id: data.interactiveId,
          question: data.question,
          options: data.options,
          multiSelect: data.multiSelect,
        })
      }
      // ── error 事件 ──
      if (data.error)                       onError(new Error(data.error))
    }
  }
}
```

**为什么用原生 fetch 而不是 Axios？**

Axios 基于 XMLHttpRequest，不支持 `ReadableStream`。只有原生 `fetch()` 的 `response.body.getReader()` 可以逐块读取 SSE 数据。

**Vue 响应式更新链路：**

```
onChunk(chunk)
  → aiMsg.content += chunk        // ← reactive 数组元素的属性变更
  → computed: messages             // ← Pinia getter 依赖追踪
  → MessageBubble :message="msg"  // ← Props 传递
  → computed: renderedContent       // ← marked.parse(content)
  → v-html                          // ← DOM 更新
```

---

### 2.3 前端：Markdown 渲染与打字机效果

| 文件 | 组件/函数 | 职责 |
|------|----------|------|
| [MessageBubble.vue](file:///e:/workspace/private/ai-agent-cooking/cooking-app/src/components/MessageBubble.vue) | 气泡组件 | 区分 user/assistant，渲染 Markdown，闪烁光标 |
| [MessageList.vue](file:///e:/workspace/private/ai-agent-cooking/cooking-app/src/components/MessageList.vue) | 消息列表 | `v-for` 渲染所有消息 |
| [useScrollToBottom.ts](file:///e:/workspace/private/ai-agent-cooking/cooking-app/src/hooks/useScrollToBottom.ts) | 自动滚到底 | watch 内容变化 → nextTick → scrollTop |

**打字机光标效果：**

```html
<div class="markdown-body" v-html="renderedContent" />
<span v-if="message.streaming" class="typing-cursor" />
```

```css
.typing-cursor {
  display: inline-block;
  width: 2px;
  height: 1.1em;
  background: var(--accent);
  margin-left: 2px;
  animation: blink 0.8s step-end infinite;
}
```

**自动滚动：**

```typescript
watch(
  () => chatStore.messages.map(m => m.content).join(''),  // 将所有消息内容拼接为依赖源
  async () => {
    await nextTick()
    container.scrollTop = container.scrollHeight
  }
)
```

---

## 三、常见问题与解决思路

### 3.1 SSE 解析层面

| 问题 | 现象 | 原因 | 解决思路 |
|------|------|------|----------|
| **多字节字符截断** | 中文乱码、 字符 | `TextDecoder.decode(value)` 不带 `{ stream: true }` 时，跨 chunk 的多字节字符被切断 | 使用 `decode(value, { stream: true })`，TextDecoder 会缓存不完整的多字节序列 |
| **行被截断** | JSON 解析失败、部分事件丢失 | SSE 数据行可能被 chunk 边界切断 | 使用 `buffer` 缓存不完整行，`lines.pop()` 保留最后一行待下次拼接 |
| **JSON 解析失败** | 控制台警告，某条 chunk 被跳过 | 上游发送了非 JSON 格式的数据或 data 字段格式不标准 | `try/catch` 包裹 `JSON.parse`，失败时跳过而非中断 |
| **空白行干扰** | 重复触发空事件 | 上游多发送了空行 | `if (!line.trim()) continue` 过滤空白行 |
| **SSE 注释行** | 注释被当作数据处理 | SSE 协议规定 `:` 开头的行是注释 | 当前代码未处理，如果上游发注释需加过滤 |

### 3.2 连接与网络层面

| 问题 | 现象 | 原因 | 解决思路 |
|------|------|------|----------|
| **Nginx 缓冲导致延迟** | 用户消息发出后等很久才一次性看到完整回复 | Nginx 默认会缓冲上游响应（`proxy_buffering on`），等整个响应体完整后才发给客户端 | ① 后端已设置 `X-Accel-Buffering: no` 请求头 ② Nginx 配置 `proxy_buffering off` ③ 或设置 `proxy_buf_size`/`proxy_buffer_size` |
| **SSE 连接超时断开** | 长回复中途断掉，前端报错 | Express 默认 2 分钟超时，Nginx 默认 `proxy_read_timeout` 60s | ① `req.socket.setTimeout(0)` ② Nginx `proxy_read_timeout 300s` ③ 前端实现自动重连 |
| **前端无自动重连** | 断连后用户需手动刷新 | 当前 `sendChatStream` 没有重连机制 | 可在 `onError` 中提示用户并自动重试（需注意幂等性） |
| **fetch 被 AbortController 取消** | 用户切换会话后旧请求被取消 | `AbortError` 是预期行为，当前已捕获 | 确保 `AbortError.name` 判断在 `catch` 最前面，避免误判为网络错误 |
| **CORS 预检请求** | OPTIONS 请求 401 | 开发环境跨域时浏览器先发 OPTIONS（preflight），express cors 中间件已处理 | 配置 `credentials: 'include'` 时的 cookie 跨域策略 |

### 3.3 渲染性能层面

| 问题 | 现象 | 原因 | 解决思路 |
|------|------|------|----------|
| **Markdown 重复解析** | 长回复时界面卡顿、掉帧 | 每次 `aiMsg.content += chunk` 触发 Vue 响应式更新 → `computed` 重新计算 → `marked.parse()` 重新解析整个文本 | ① 使用 `shallowRef` + 手动触发更新 ② 节流：每 50ms 批量更新 content ③ 虚拟滚动（长历史）④ 考虑按 token 粒度累积到一定数量再渲染 |
| **滚动卡顿** | 流式过程中滚动不丝滑 | `scrollTop = scrollHeight` 每次 content 变化都执行，高频触发 | ① 使用 `requestAnimationFrame` 包装 ② 检测用户是否手动滚动（暂停自动滚底）③ 使用 `scroll-behavior: smooth` |
| **v-html 安全风险** | XSS 潜在威胁 | `marked.parse()` 输出的 HTML 直接通过 `v-html` 注入 DOM | ① marked 已默认不做 HTML 转义？配置 `sanitize: true` ② 或使用 DOMPurify 过滤 ③ 当前 LLM 输出可控，风险较低 |
| **Vue Devtools 性能下降** | 流式时 Devtools 卡死 | 每条消息的 content 频繁变化，Pinia 的 devtools 追踪导致 | 开发环境正常，生产环境不会开启 Devtools。可配置 `__VUE_PROD_DEVTOOLS__: false` |

### 3.4 Markdown 渲染完整性

| 问题 | 现象 | 原因 | 解决思路 |
|------|------|------|----------|
| **代码块闪烁** | 代码块一开始不完整，突然变成完整格式 | ` ``` ` 还未闭合时，marked 将其解析为普通段落；` ``` ` 闭合后重新解析为代码块 | 此为 markdown 流式渲染的固有问题，可接受。优化方案：延迟渲染不完整代码块 |
| **列表/表格格式错乱** | 表格行数不够时出现残缺表格 | 表格需要完整行和分隔符才能正确解析 | 同上，固有问题。可等 `streaming` 变为 `false` 后做一次最终完整渲染 |
| **链接/图片不完整** | 出现 `[text](partial` 或被解析为纯文本 | 语法未闭合 | 同上 |

### 3.5 状态管理层面

| 问题 | 现象 | 原因 | 解决思路 |
|------|------|------|----------|
| **重复发送** | 用户快速点击发送，出现多条 AI 回复 | `store.loading` 守卫存在但存在竞态窗口 | 已有 `if (store.loading) return` 守卫，但需确保 Vite 代理/后端也做幂等处理 |
| **切换会话时旧流未清理** | 切换到新会话后，旧会话的 AI 回复内容还在更新 | `abortController.abort()` 在 `sendMessage` 开头调用，但 store 的 loading/messages 未完全隔离 | 当前实现下，`sendMessage` 中 `abort()` 会取消旧 fetch，但如果 `onChunk` 已经注册到 store 回调中，需确保 abort 后不再操作 store |
| **abort 后的 store 状态残留** | `loading` 一直为 true | ⚠️ **已修复** — AbortError 分支中也设置 `store.loading = false`（v3.2.1） |
| **会话历史与当前消息冲突** | 加载历史后消息列表监听异常 | `useScrollToBottom` 的 watch source 是 `messages.map(m => m.content).join('')`，历史加载完成后不会触发 | 需额外监听 `messages.length` 或用 `deep: true` |

### 3.6 后端特有

| 问题 | 现象 | 原因 | 解决思路 |
|------|------|------|----------|
| **ReAct 工具调用阶段无反馈** | 用户看到"..."很久但没有文字输出 | `chatStream` 中 ReAct 循环使用非流式 `callLLMWithRetry`，只有最终回答才是流式 | 可在此阶段发送 SSE progress 事件（如 `event: tool_call\ndata: {"tool":"search_recipe"}\n\n`）告知用户正在进行中 |
| **DeepSeek API 限流** | 请求返回 429 Too Many Requests | DeepSeek 有 RPM/TPM 限制 | ① rateLimit middleware 已做客户端限流 ② 可增加重试的退避策略 ③ 考虑多 API Key 轮转 |
| **res.end() 未调用** | 前端永远连接中 | 异常路径没有调用 `res.end()` | 当前 `catch` 中有 `res.end()`，但需确保所有 code path 都覆盖 |
| **并发 SSE 连接过多** | 服务器文件描述符耗尽 | 每个 SSE 占一个连接 | 设置最大并发 SSE 连接数限制 |

### 3.7 移动端/低网速

| 问题 | 现象 | 原因 | 解决思路 |
|------|------|------|----------|
| **弱网下慢** | 每个 token 都要很久才显示 | 网络延迟高 | SSE 本身已是最优方案（比 WebSocket 更轻量），可降低每个 chunk 的粒度 |
| **移动端切后台后断连** | iOS/Android 切后台一段时间后 SSE 断开 | 移动端浏览器会暂停后台连接 | ① 前端检测断连后自动重连 ② 切回前台时重新建立 SSE |

---

## 四、数据流时序图

### 4.1 普通流式对话

```
 用户点击发送
      │
      ▼
 InputBar.handleSend()
      │
      ├─ inputText = ""                          // 清空输入框
      ├─ useConversation.sendMessage(content)
      │     │
      │     ├─ store.loading = true               // 按钮立刻 disabled + loading
      │     ├─ session.messages.push(userMsg)     // 用户消息立刻可见
      │     ├─ session.messages.push(aiMsg)       // 空 AI 气泡立刻可见（streaming: true）
      │     │
      │     ├─ sendChatStream(content, ..., {onChunk, onDone, onError})
      │     │     │
      │     │     ├─ fetch POST /api/chat/stream
      │     │     │     │
      │     │     │     └── 后端 ReAct 循环（无前端可见输出）
      │     │     │           │
      │     │     │           └── 开始流式输出
      │     │     │                 │
      │     │     │   chunk① ──────▶ aiMsg.content = "红"    → 气泡显示"红"
      │     │     │   chunk② ──────▶ aiMsg.content = "红烧"   → 气泡显示"红烧"
      │     │     │   chunk③ ──────▶ aiMsg.content = "红烧肉"  → 气泡显示"红烧肉"
      │     │     │   ...                                 → 逐字打印...
      │     │     │   done   ──────▶ aiMsg.streaming = false    → 光标消失
      │     │     │                 store.loading = false       → 按钮恢复
      │     │     │
      │     │     └─ onError ────▶ ElMessage.error('Agent 离线')
      │     │                      store.loading = false
```

### 4.2 交互式工具（ask_user_choice）流程

```
 用户发送 "今天吃什么"
      │
      ▼
 useConversation.sendMessage()
      │
      ├─ store.loading = true
      ├─ sendChatStream(..., {onChunk, onDone, onError, onInteractiveRequest})
      │     │
      │     ├─ fetch POST /api/chat/stream
      │     │     │
      │     │     └── 后端 ReAct 循环
      │     │           │
      │     │           └── LLM 返回 ask_user_choice tool_call
      │     │                 │
      │     │                 ▼
      │     │           onInteractive 回调触发
      │     │                 │
      │     │                 ▼
      │     │     sendEvent('interactive_request', {
      │     │       interactiveId: 'tool_call_xxx',
      │     │       question:     '你今天想吃什么场景的菜？',
      │     │       options:      ['早餐','午餐','晚餐'],
      │     │       multiSelect:  false
      │     │     })
      │     │
      │     │     └─ onInteractiveRequest ─▶ aiMsg.interactive = { ... }
      │     │                              ▶ aiMsg.streaming = false
      │     │                              ▶ store.loading = false
      │     │
      │     │   <InteractiveChoiceCard :options="..." @select="submitInteractiveChoice" />
      │     │                  │
      │     │                  │ 用户点击"午餐"
      │     │                  ▼
      │     │     submitInteractiveChoice(['午餐'])
      │     │                  │
      │     │                  ├─ aiMsg.interactiveResolved = true
      │     │                  ├─ 追加用户回答气泡
      │     │                  ├─ sendChatStream 闭包变量 cleanup
      │     │                  │
      │     │                  ├─ continueInteractive(sessionId, interactiveId, ['午餐'])
      │     │                  │     │
      │     │                  │     ├─ fetch POST /api/chat/continue
      │     │                  │     │     │
      │     │                  │     │     └── agent.resumeInteractive()
      │     │                  │     │           │
      │     │                  │     │           ├── 追加 role=tool 消息（content=user_choice）
      │     │                  │     │           ├── 继续 ReAct 循环
      │     │                  │     │           └── 进入流式回答阶段
      │     │                  │     │
      │     │                  │     │   chunk① ────▶ 新增 aiMsg.content += "好的"
      │     │                  │     │   chunk② ────▶ aiMsg.content += "好的,午餐"
      │     │                  │     │   ...
      │     │                  │     │   done   ────▶ aiMsg.streaming = false
      │     │                  │     │
      │     │                  │     └─ onError ───▶ ElMessage.error
      │     │
      │     └─ 旧 SSE 连接 res.end() 收尾（agent 因 paused=true 不调 onDone）
      │
      ▼
 流程结束
```

> **关键点**：交互卡片渲染在同一气泡中，提交后**新建一条 AI 气泡**承载后续回答。这是经过验证的 UX：避免长 bubble 内嵌表单造成视觉混乱，也便于按消息单元 abort / 删除。

---

## 五、当前已知问题清单（含已修复）

| 优先级 | 问题 | 状态 | 修复方案 |
|--------|------|------|----------|
| 🔴 P0 | **AbortError 未重置 loading** | ✅ 已修复 | [useConversation.ts](file:///e:/workspace/private/ai-agent-cooking/cooking-app/src/hooks/useConversation.ts#L94-L99) — onError 回调和外层 catch 两处 AbortError 分支增加 `store.loading = false` / `aiMsg.streaming = false` / `abortController = null` |
| 🔴 P0 | **req.on('close') 误触发中断** | ✅ 已修复 | [index.ts](file:///e:/workspace/private/ai-agent-cooking/cooking-agent/src/index.ts#L285-L296) — 增加 `finished` 标记区分正常完成与异常断开，避免正常结束时被当作中断 |
| 🔴 P0 | **回答为空、对话中断** | ✅ 已修复 | [agent.ts](file:///e:/workspace/private/ai-agent-cooking/cooking-agent/src/agent.ts#L400-L410) — 增加 `hasStreamed` 标记，仅在已开始流式传输后才响应 close 事件；中止时空内容返回提示语 |
| 🟡 P1 | **后端卡死前端无限 loading** | ✅ 已修复 | [useConversation.ts](file:///e:/workspace/private/ai-agent-cooking/cooking-app/src/hooks/useConversation.ts#L126-L138) — 增加 60 秒超时计时器，超时后自动中止请求并显示超时提示 |
| 🟡 P1 | **SSE 连接中断无友好提示** | ✅ 已修复 | [chat.ts](file:///e:/workspace/private/ai-agent-cooking/cooking-app/src/api/chat.ts#L122-L130) — try-catch 包裹 while(true) 读取循环，捕获 TCP RST 异常并调用 onError |
| 🟡 P1 | **Markdown 重复解析全量文本** | ✅ 已修复 | [MessageBubble.vue](file:///e:/workspace/private/ai-agent-cooking/cooking-app/src/components/MessageBubble.vue#L21-L63) — `computed → ref + watch`，流式过程中 60ms 节流批量解析 |
| 🟢 P2 | **滚动不跟随手动暂停** | ✅ 已修复 | [useScrollToBottom.ts](file:///e:/workspace/private/ai-agent-cooking/cooking-app/src/hooks/useScrollToBottom.ts) — 离底部 ≥ 80px 时暂停自动滚底，3 秒冷却期后恢复 |
| 🎨 UI | **头像/思考过程/按钮过于简陋** | ✅ 已修复 | [MessageBubble.vue](file:///e:/workspace/private/ai-agent-cooking/cooking-app/src/components/MessageBubble.vue) — 见 §6.4 UI 重构详情 |
| 🆕 Feature | **交互式工具（ask_user_choice）** | ✅ 已实现 | 详见 §9。新增 `interactive_request` SSE 事件 + `/api/chat/continue` 续点端点 + 前端状态机 |
| 🟡 P1 | **ReAct 阶段无反馈** | 📋 待实现 | 见 §7.1 |
| 🟡 P1 | **SSE 断连无自动重连** | 📋 待实现 | 见 §7.2 |
| 🟡 P1 | **客户端心跳超时** | 📋 待实现 | 见 §7.3 |
| 🟢 P2 | **移动端切后台断连** | 📋 待实现 | 见 §7.4 |
| 🟢 P2 | **代码块流式闪烁** | 📋 待实现 | 见 §7.5 |
| ⚪ P3 | **v-html 安全策略** | 📋 评估中 | marked 默认不转义 HTML 标签，建议加 DOMPurify |

---

## 六、已实施的优化详情

### 6.1 AbortError 状态清理

**问题**：`useConversation.sendMessage()` 中有两条 AbortError 处理路径——`sendChatStream` 的 `onError` 回调内和外层 `try/catch`——之前仅打印日志后 `return`，导致 `store.loading` 永久为 `true`。

**修复**：两处 AbortError 分支均增加：
```typescript
aiMsg.streaming = false
store.loading = false
abortController = null
```

**修复文件**：[useConversation.ts](file:///e:/workspace/private/ai-agent-cooking/cooking-app/src/hooks/useConversation.ts)

### 6.2 Markdown 节流解析

**问题**：`renderedContent` 原为 `computed(() => marked.parse(message.content))`。每个 token chunk（1-3 字符）到达时触发全量 re-parse。2000 字回复 ≈ 500-1000 次 O(n) 调用。

**修复**：改为 `ref` + `watch`，流式阶段 60ms 节流批量解析 + 长度去重：
```typescript
watch(() => props.message.content, () => {
  if (props.message.streaming) {
    if (!parseTimer) {
      parseTimer = setTimeout(() => {
        parseTimer = null
        parseMarkdown()
      }, 60)  // 每秒约 16 次解析，视觉上流畅
    }
  } else {
    parseMarkdown()  // 流结束立即全量解析
  }
})
```

**修复文件**：[MessageBubble.vue](file:///e:/workspace/private/ai-agent-cooking/cooking-app/src/components/MessageBubble.vue)

### 6.3 智能滚动

**问题**：用户向上翻阅历史时，新的流式 chunk 到达会强制将滚动条拉回底部。

**修复**：
- 监听 `scroll` 事件，判断距底部是否 ≥ 80px
- 若用户已上滚，3 秒冷却期内不自动滚底
- 冷却期结束或用户滚回底部，恢复自动滚底

```typescript
function onScroll() {
  userScrolledUp = !isNearBottom()  // 距离底部 < 80px → 视为"在底部"
  clearTimeout(scrollCooldownTimer)
  scrollCooldownTimer = setTimeout(() => { userScrolledUp = false }, 3000)
}
```

**修复文件**：[useScrollToBottom.ts](file:///e:/workspace/private/ai-agent-cooking/cooking-app/src/hooks/useScrollToBottom.ts) + [MessageList.vue](file:///e:/workspace/private/ai-agent-cooking/cooking-app/src/components/MessageList.vue)

### 6.4 中止机制全链路

**架构**：用户手动中止或超时 → 前端 AbortController.abort() → fetch 抛出 AbortError → 后端 signal.aborted 置位 → 逐层传播。

```
前端点击"停止生成"
  → useConversation.stopGeneration()
    → abortController.abort()
      → fetch() 抛出 AbortError → onError 回调 → 清理 loading
      → 后端 req.on('close') → abortController.abort()
        → signal.aborted = true
          → agent.chatStream() 每轮 ReAct 前检查 signal?.aborted → break
          → llm.chatCompletionStream() 每个 chunk 检查 signal?.aborted → break
            → agent 保存部分结果 → onDone('[已中止]')
```

**关键设计：三标记守卫**

后端 SSE 端点的 `req.on('close')` 极易误触发（Vite 代理的瞬时 close、正常完成的 socket 回收等）。通过三个标记精确判断：

| 标记 | 作用 | 设置时机 |
|------|------|----------|
| `finished` | 正常完成标记，防止完成后的 close 误触发 | `onDone` 回调中置 `true` |
| `hasStreamed` | 是否已开始流式传输，防止连接建立初期的 close 误触发 | 第一个 `chunk` 通过 `onChunk` 回调时置 `true` |
| `writableEnded` | Express 响应是否已结束 | `res.end()` 后自动置 `true` |

触发条件：`!finished && !res.writableEnded && hasStreamed` — 三者同时满足才认定为"用户主动断开"。

### 6.5 流式请求超时保护

**问题**：后端 Agent 卡死或 LLM API 无响应时，前端 `fetch()` 会无限等待。

**方案**：在 `useConversation.sendMessage()` 中设置 60 秒 `setTimeout` 定时器：

```typescript
streamTimer = setTimeout(() => {
  if (!abortController) return
  console.warn('[Conversation] ⏰ 流式请求超时')
  abortController.abort()           // 中止 fetch
  abortController = null
  store.loading = false
  if (aiMsg.streaming) {
    aiMsg.streaming = false
    if (!aiMsg.content) {
      aiMsg.content = '回答超时，请稍后重试。'   // 无内容 → 完整提示
    } else {
      aiMsg.content += '\n\n[回答超时]'         // 有部分内容 → 追加标记
    }
  }
}, STREAM_TIMEOUT_MS)
```

**定时器清理时机**（所有出口都需清理，防止内存泄漏）：
- `onDone` 回调中 → 正常完成
- `onError` 回调中 → 错误
- `stopGeneration()` → 用户手动中止
- 外层 `catch` → 异常

### 6.6 SSE 连接中断捕获

**问题**：当 Express 进程崩溃（kill/kill -9），已建立的 TCP 连接被操作系统强制 RST。前端的 `reader.read()` 抛出 `TypeError` 而非正常的 `done: true`。

**方案**：用 `try-catch` 包裹整个 `while(true)` 读取循环：

```typescript
try {
  while (true) {
    const { done, value } = await reader.read()
    // ... SSE 解析 ...
  }
} catch (err) {
  console.error('[API] ❌ SSE 连接中断（Agent 可能已崩溃）：', err)
  onError(new Error('Agent 连接中断，请检查后端服务是否正常运行'))
}
```

### 6.7 UI 视觉重构

**头像设计**：从 emoji 字符替换为 SVG 矢量图标
- 用户：圆形人物剪影，琥珀渐变背景 (#f0a030 → #e88a1a)
- 助手：星形剪影（厨师帽隐喻），暖灰白渐变 + 蓝紫图标色
- 助手生成中：外围叠加 `avatarPulse` 呼吸光晕（2s 循环）

**思考中指示器**：替代空白的闪烁气泡
- 显示 "思考中" 文字标签
- 三颗圆点弹跳动画（`dotBounce`，每颗错开 0.2s delay）
- 气泡边框在 `thinking` 状态下变为琥珀色

**停止按钮**：从 Element Plus `type="danger"` 大红按钮改为深色胶囊钮
- 深暖棕渐变 (#3d3530 → #2a2420)，融入暖白主题
- SVG 方块图标 + "停止生成" 文字
- 阴影呼吸动画（`stopPulse`，2.6s 循环）
- hover → 背景变亮、上浮 1px

**相关文件**：
- [MessageBubble.vue](file:///e:/workspace/private/ai-agent-cooking/cooking-app/src/components/MessageBubble.vue)
- [InputBar.vue](file:///e:/workspace/private/ai-agent-cooking/cooking-app/src/components/InputBar.vue)

---

## 七、待提升项详解

### 7.1 ReAct 推理中间状态反馈 🟡 P1

**现状**：`agent.chatStream()` 中的 ReAct 循环使用非流式 `callLLMWithRetry`，工具调用阶段完全黑盒。用户只看到空 AI 气泡 + 闪烁光标，不知道 Agent 在做什么。

**影响**：工具调用（如搜索菜谱 API）可能耗时 2-5 秒，加上 LLM 重试可达 10 秒以上。用户会以为卡死了。

**实现思路**：

在 `sendEvent` 工具函数中新增一个 `status` 事件类型，在 ReAct 循环的各阶段发送进度：

```typescript
// index.ts — 后端 SSE 端点新增状态事件
const sendStatus = (phase: string, detail: string) => {
  sendEvent('status', { phase, detail })
}

await agent.chatStream(
  message, sessionId,
  // 新增 onStatus 回调
  (phase, detail) => { sendStatus(phase, detail) },
  (chunk) => { sendEvent('chunk', { content: chunk }) },
  (full) => { sendEvent('done', { content: full, sessionId }) },
)
```

```typescript
// agent.ts — chatStream 中注入状态回调
async chatStream(
  userMessage: string,
  sessionId: string,
  onStatus: (phase: string, detail: string) => void,  // ← 新增
  onChunk: (delta: string) => void,
  onDone: (fullContent: string) => void,
) {
  for (let step = 1; step <= MAX_REACT_STEPS; step++) {
    onStatus('reasoning', `正在思考第 ${step} 步…`)
    const response = await this.callLLMWithRetry(messages)

    if (response.tool_calls?.length) {
      onStatus('tool_call', `正在查询：${response.tool_calls.map(c => c.function.name).join('、')}`)
      // ... 执行工具 ...
      onStatus('tool_done', `查询完成`)
    } else {
      onStatus('answering', '正在组织回答…')
      // ... 流式输出 ...
    }
  }
}
```

前端接收 `status` 事件后，在 AI 气泡中展示一个小的状态指示器（如"🔍 正在搜索菜谱…"），替代空白的闪烁光标。

### 7.2 SSE 断连自动重连 🟡 P1

**现状**：SSE 连接断开后，前端直接展示错误提示，已传输的内容丢失（虽然后端已持久化，但前端消息列表中的部分内容不会恢复）。

**设计要点**：

```
连接断开
    │
    ├── 网络错误（fetch 抛出 TypeError）
    │     → 指数退避重试：1s → 2s → 4s → 最多 3 次
    │
    ├── HTTP 非 200（Nginx 超时返回 504）
    │     → 同网络错误处理
    │
    └── SSE error 事件（后端显式发送）
          → 如果是业务错误（如 API Key 无效）→ 不重试，展示错误
          → 如果是临时错误（如 API 限流 429）→ 退避重试
```

**核心实现**：

```typescript
// useConversation.ts — sendMessage 增强版
async function sendMessage(content: string) {
  const MAX_RETRIES = 3
  const BASE_DELAY = 1000

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = BASE_DELAY * Math.pow(2, attempt - 1)
      console.info(`[Conversation] 🔄 第 ${attempt} 次重试，等待 ${delay}ms…`)
      await new Promise(r => setTimeout(r, delay))
    }

    try {
      await sendChatStream(content, session.id, onChunk, onDone, onError, signal)
      return  // 成功
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err  // 最后一次失败，向上抛
    }
  }
}
```

**重试时的注意事项**：
- **幂等性**：用同一个 sessionId 重连，后端加载历史消息后继续推理。但 LLM 本身非幂等——可能生成不同的回答。需要在 UI 上告知用户"正在重新连接…"，且之前的 token 内容不清空。
- **AbortSignal**：用户主动取消时不应重试，需传递取消信号。
- **部分内容保留**：重试前不清空 `aiMsg.content`，保留已收到的部分内容。

### 7.3 客户端心跳超时 🟡 P1

**现状**：客户端 `fetch` 没有设置超时。如果 LLM 长时间思考（如 DeepSeek Reasoner 可能需要 30-60 秒思考时间），连接可能在静默期被中间代理断开。

**实现**：在 `sendChatStream` 中增加可重置的定时器：

```typescript
// chat.ts — sendChatStream 增强版
export async function sendChatStream(...) {
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  const HEARTBEAT_TIMEOUT = 120_000  // 2 分钟无数据 → 超时

  function resetHeartbeat() {
    if (heartbeatTimer) clearTimeout(heartbeatTimer)
    heartbeatTimer = setTimeout(() => {
      console.warn('[API] ⏰ SSE 心跳超时，120s 无数据')
      reader?.cancel()
      onError(new Error('连接超时：长时间未收到数据'))
    }, HEARTBEAT_TIMEOUT)
  }

  resetHeartbeat()  // 建立连接后启动

  // ... 原有 while(true) 循环中 ...
  for (const line of lines) {
    // 每收到有效数据行就重置计时器
    if (line.startsWith('data: ') && line.includes('"content"')) {
      resetHeartbeat()
    }
    // ... 原有解析逻辑
  }
}
```

**关键**：每次收到 `chunk` 事件就重置计时器，区分"LLM 思考中（无 token 输出）"和"连接已死（连 TCP 都断了）"。

### 7.4 移动端切后台断连 🟢 P2

**问题**：iOS Safari 和 Android Chrome 在 App 切后台约 30 秒后会暂停 JavaScript 执行和网络活动，SSE 连接可能被中断。

**实现**：

```typescript
// 监听页面可见性变化
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    // 切回前台 → 检查 SSE 连接是否还活着
    if (store.loading && !aiMsg.streaming) {
      // 连接已断但 loading 仍为 true → 触发重连
      console.info('[SSE] 📱 页面恢复前台，检测到连接中断，尝试重连…')
      retryConnection()
    }
  }
})

// 监听网络状态变化
window.addEventListener('online', () => {
  if (store.loading) {
    console.info('[SSE] 🌐 网络恢复，尝试重连…')
    retryConnection()
  }
})
```

### 7.5 代码块流式闪烁 🟢 P2

**问题**：LLM 输出代码时，`` ``` `` 标记未闭合前，marked 将代码块内容解析为普通段落。闭合瞬间重新解析为代码块，视觉上闪烁。

**方案 A：延迟渲染不完整代码块**（推荐，改动小）

```typescript
function parseMarkdown() {
  const text = props.message.content

  // 检测未闭合的代码块标记
  const openFences = (text.match(/```/g) || []).length
  if (props.message.streaming && openFences % 2 !== 0) {
    // 代码块未闭合 → 截断到最后一个闭合的 ``` 之后
    const lastCloseIdx = text.lastIndexOf('```\n')
    if (lastCloseIdx > 0) {
      renderedContent.value = marked.parse(text.slice(0, lastCloseIdx + 4)) as string
        + '<p><em>代码生成中…</em></p>'
      return
    }
  }

  renderedContent.value = marked.parse(text) as string
}
```

**方案 B：CSS 平滑过渡**

为避免闪烁，给代码块加 CSS 过渡：
```css
.markdown-body pre {
  transition: background 0.2s ease, border 0.2s ease;
}
```

这不能消除结构变化造成的闪烁，但能减轻视觉冲击。

### 7.6 v-html XSS 防护 ⚪ P3

**风险**：`marked` 默认配置不会对 HTML 标签做转义。如果用户通过某种方式让 LLM 输出 `<script>alert('xss')</script>`，会被 `v-html` 直接注入 DOM。

**方案**：使用 DOMPurify 过滤 marked 输出：

```typescript
import DOMPurify from 'dompurify'

function parseMarkdown() {
  const raw = marked.parse(text) as string
  renderedContent.value = DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: ['h1','h2','h3','h4','h5','h6','p','br','ul','ol','li','strong',
      'em','code','pre','blockquote','table','thead','tbody','tr','th','td','a','img','hr'],
    ALLOWED_ATTR: ['href','src','alt','title','class'],
  })
}
```

> **评估**：当前风险较低。LLM（DeepSeek）的 system prompt 和工具返回都是可控的。但如果将来引入网页搜索工具（返回用户可控的 HTML），或支持用户上传包含 HTML 的文档，必须加此防护。

---

## 八、综合提升路线图

| 阶段 | 内容 | 工作量 | 收益 |
|------|------|--------|------|
| ✅ 已完成 | AbortError 修复 + Markdown 节流 + 智能滚动 | 一小时代码 | 消除 P0 bug，明显性能提升 |
| 🔜 下一批 | ReAct 中间状态反馈 + 客户端心跳超时 | 半天 | 用户感知大幅提升，消除"卡住"焦虑 |
| 📅 后续 | SSE 断连重试 + 移动端切后台恢复 | 半天 | 弱网和移动端体验明显改善 |
| 🔮 远期 | 增量 Markdown 解析 + Web Worker 渲染 + 虚拟滚动 | 1-2 天 | 极限场景（超长回复、超长历史）性能保障 |

---

## 九、交互式工具与续点

> 厨神小助已支持"人机协作"工具调用：LLM 主动把决策权交还用户，本节介绍完整实现。

### 9.1 设计目标

LLM 工具调用有 2 种范式：

| 范式 | 含义 | 工具举例 |
|------|------|---------|
| **A. 自主执行** | LLM 决策后自动调用工具，工具返回结构化结果 | `search_recipe`、`calculate_nutrition` |
| **B. 人机协作** | LLM 决策后暂停，把问题交由用户回答 | `ask_user_choice` |

`ask_user_choice` 是范式 B 的入口：让 LLM 在不确定场景时主动向用户提问（如"早餐/午餐/晚餐？"），前端用按钮呈现选项，用户点击后 LLM 继续推理。

### 9.2 协议设计

复用 SSE 通道，加 2 个事件 + 1 个新端点：

| 新增 | 类型 | 说明 |
|------|------|------|
| `interactive_request` 事件 | 后端 → 前端 | LLM 调起 ask_user_choice 时下发 `{ interactiveId, question, options, multiSelect }` |
| `POST /api/chat/continue` 端点 | 前端 → 后端 | 用户提交选项后调用，请求体 `{ sessionId, interactiveId, choice: string[] }`，响应是另一条 SSE 流 |

> **不复用旧 SSE 流的原因**：浏览器侧的 `EventSource` / `fetch` 一旦 `done` 事件触发，连接就被关闭，无法 attach 回去。改为"开新流"，前端 `onChunk / onDone / onInteractiveRequest` 全部复用。

### 9.3 后端：ReAct 中的拦截与续点

#### 工具调用拆分流

`agent.handleToolCalls()` 是 `chat()` / `chatStream()` / `resumeInteractive()` 三者共用的私有方法。它把 LLM 返回的 `tool_calls` 拆成两类：

```
                   LLM 返回 tool_calls
                            │
            ┌───────────────┴───────────────┐
            ▼                                ▼
   INTERACTIVE_TOOL_NAMES              其他工具
   （含 ask_user_choice）            （含 search_recipe 等）
            │                                │
            ▼                                ▼
   parseInteractiveArgs()           executeTools()
   生成 InteractiveRequest          → 追加 tool 消息
   触发 onInteractive 回调           → 累积到 reactLog
   标记 paused=true                 → 不暂停，继续循环
            │
            ▼
   agent.chatStream() 跳出循环
   index.ts 主动 res.end()
```

#### 续点：resumeInteractive

用户提交选项后，前端调用 `POST /api/chat/continue` → `agent.resumeInteractive()`：

```typescript
async resumeInteractive(
  sessionId, interactiveId, choice,
  onChunk, onDone, onInteractive, signal,
): Promise<void> {
  const messages = await this.loadMessages(sessionId)         // ① 加载历史

  // ② 找到上一轮 assistant 消息里 interactiveId 对应的 tool_call
  const targetCall = findCallById(messages, interactiveId)

  // ③ 追加 role=tool 消息（这是 LLM 期待的工具结果）
  messages.push({
    role: 'tool',
    tool_call_id: interactiveId,
    content: JSON.stringify({ user_choice: choice }),
  })
  await this.persistMessage(sessionId, toolResultMsg)

  // ④ 继续 ReAct 循环（与 chatStream 内层循环完全相同）
  for (let step = 1; step <= MAX_REACT_STEPS; step++) { ... }
}
```

### 9.4 前端：交互状态机

`useConversation.ts` 用模块级单例持有"当前 SSE 请求"对象，避免用户在等待时切换会话造成状态错乱。

**状态机：**

```
                  sendMessage()
                       │
                       ▼
              ┌─────────────────┐
              │   streaming     │◀──────────┐
              │ (chunk 事件中)  │           │
              └──────┬──────────┘           │
                     │                      │
       interactive_request                  │
                     │                      │
                     ▼                      │
              ┌─────────────────┐           │
              │  interactive    │           │
              │  (等待用户选择)  │           │
              └──────┬──────────┘           │
                     │                      │
            submitInteractiveChoice()       │
                     │                      │
                     ▼                      │
              ┌─────────────────┐           │
              │   continuing    │           │
              │ (continue SSE)  │           │
              └──────┬──────────┘           │
                     │                      │
                done │                      │
                     ▼                      │
              ┌─────────────────┐           │
              │     idle        │           │
              └─────────────────┘           │
                                            │
   又收到 interactive_request ──────────────┘
```

**关键代码片段（[useConversation.ts](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-app/src/hooks/useConversation.ts)）：**

```typescript
// 模块级单例 — 同一时刻只允许一条 SSE 请求
let currentRequest: ChatRequest | null = null

async function sendMessage(content: string) {
  // 若有进行中的请求，先 abort
  currentRequest?.abort()

  // 创建新请求
  const req = createRequest(content)
  currentRequest = req

  await sendChatStream(content, ..., {
    onChunk: (chunk) => { aiMsg.content += chunk },
    onDone: (full) => { aiMsg.streaming = false },
    onInteractiveRequest: (interactive) => {
      aiMsg.interactive = interactive
      aiMsg.streaming = false
      store.loading = false  // 用户可继续操作
    },
    onError: (err) => { ... },
  })
}

async function submitInteractiveChoice(interactiveId: string, choice: string[]) {
  const req = currentRequest
  req?.abort()  // 关闭旧 SSE（agent 已因 paused=true 自然结束）

  // 标记交互已解决（卡片变成"已选"态）
  const aiMsg = findMessageByInteractiveId(interactiveId)
  aiMsg.interactiveResolved = true
  aiMsg.interactiveChoice = choice

  // 追加用户回答气泡
  const userMsg = { role: 'user', content: formatChoice(choice) }
  aiMsg.session.messages.push(userMsg)

  // 新建 AI 气泡承载后续回答
  const newAiMsg = createEmptyAiMsg()
  newAiMsg.streaming = true
  aiMsg.session.messages.push(newAiMsg)

  // 调起 continue
  currentRequest = createRequestForContinue()
  await continueInteractive(req.sessionId, interactiveId, choice, {
    onChunk: (chunk) => { newAiMsg.content += chunk },
    onDone: (full) => { newAiMsg.streaming = false },
    onInteractiveRequest: (interactive) => { ... },  // 仍可能再次触发
    onError: (err) => { ... },
  })
}
```

### 9.5 关键注意事项

| 要点 | 说明 |
|------|------|
| **`interactiveId` 是 `tool_call.id`** | 同一 LLM 响应中 id 唯一，跨轮可能重复（用最新一条） |
| **`choice` 始终是数组** | 单选/多选统一用 `string[]` 表示，前端不需区分语义 |
| **暂停时**不调 `onDone`** | `agent.chatStream` 因 `paused=true` 跳出循环后直接 return，调用方应主动 `res.end()` |
| **续点端点参数校验** | `interactiveId` 必须能在历史 messages 中找到对应 `tool_call`，否则 400 + 详细错误 |
| **续点可能再触发交互** | 一次会话中可多次出现 `interactive_request`（多轮澄清），后端 `resumeInteractive` 内层 ReAct 循环也会调用 `handleToolCalls`，行为一致 |
| **前端 UI 状态机** | 用模块级单例 `currentRequest` 持有进行中请求，切会话时主动 abort，避免脏数据 |
| **PII 隔离** | `InteractiveRequest` 不含 sessionId 等敏感字段，由后端通过 `tool_call.id` ↔ 会话历史反查 |
| **非流式 `chat()` 暂不支持** | 检测到 `paused=true` 时走兜底文案，引导用户用 `/chat/stream` 重新提问 |