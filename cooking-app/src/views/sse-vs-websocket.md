# SSE vs WebSocket — 选型分析与实践建议

> 本文档梳理 SSE (Server-Sent Events) 与 WebSocket 的技术差异、优劣势对比以及不同场景下的选型建议，结合厨神小助项目的实际架构给出理由。

---

## 一、协议层面

### 1.1 SSE（Server-Sent Events）

```
┌─────────┐                         ┌──────────────┐
│  浏览器  │ ── HTTP GET ──────────→ │  HTTP Server  │
│         │ ←── text/event-stream ── │               │
│ (客户端) │ ←── data: {...}\n\n ─── │  (服务端)      │
│         │ ←── data: {...}\n\n ─── │               │
│         │ ←── ...                │               │
│         │ ←── res.end()          │               │
└─────────┘                         └──────────────┘

基于协议：HTTP/1.1 或 HTTP/2
内容类型：text/event-stream
消息格式：event: <type>\ndata: <json>\n\n
方向：    服务端 → 客户端（单向推送）
本地连接：EventSource API
连接复用：HTTP/2 下同一 TCP 连接可承载多个 SSE 流
```

SSE 本质上是**一个永不结束的 HTTP 响应**。服务端保持响应流开启，持续写入事件数据，直到 `res.end()` 或连接断开。

**消息格式示例（本项目实际使用）：**

```
event: chunk
data: {"content":"好的"}

event: chunk
data: {"content":"，"}

event: done
data: {"content":"好的，红烧肉的做法如下...","sessionId":"1715xxx_abc"}
```

### 1.2 WebSocket

```
┌─────────┐                         ┌──────────────┐
│  浏览器  │ ── HTTP Upgrade ──────→ │  HTTP Server  │
│         │ ←── 101 Switching ───── │               │
│ (客户端) │ ═══ ws:// 全双工 ══════ │  (服务端)      │
│         │ ←── text/binary frame ─ │               │
│         │ ── text/binary frame ─→ │               │
│         │ ←── ping frame ──────── │               │
│         │ ── pong frame ────────→ │               │
└─────────┘                         └──────────────┘

基于协议：独立协议（ws:// / wss://），通过 HTTP Upgrade 握手建立
数据格式：文本帧（UTF-8）或二进制帧（Blob/ArrayBuffer）
方向：    客户端 ↔ 服务端（全双工）
本地连接：WebSocket API
连接复用：每个 WebSocket 独占一个 TCP 连接
```

WebSocket 是**独立的双向通信协议**。通过一次 HTTP Upgrade 握手后，协议从 HTTP 切换为 WebSocket，两端可以随时主动发送数据帧。

---

## 二、核心差异对比

| 维度 | SSE | WebSocket |
|------|-----|-----------|
| **通信方向** | 单向：Server → Client | 全双工：Client ↔ Server |
| **底层协议** | HTTP/1.1 或 HTTP/2 | 独立协议 (ws:// / wss://) |
| **数据格式** | 纯文本 (UTF-8) | 文本帧 + 二进制帧 |
| **自动重连** | EventSource API 原生支持，可配置 `retry` 字段 | 需手动实现 |
| **二进制支持** | ❌ 不支持（仅 UTF-8 文本） | ✅ 原生支持 Blob/ArrayBuffer |
| **Nginx 兼容** | 完全透明（仅需禁用缓冲） | 需配置 `Upgrade` / `Connection` 头 |
| **HTTP/2 多路复用** | ✅ 可复用同一 TCP 连接 | ❌ 每个 WS 独占连接 |
| **浏览器 DevTools** | Network 面板可直接查看事件流 | 需专门 WS 帧查看器 |
| **cookie 认证** | 跟随 HTTP 请求自动携带 | 首次握手自动携带，后续需自行处理 |
| **中间件兼容** | ✅ CORS / 限流 / 日志 完全兼容 | ⚠️ 握手后中间件不再介入 |
| **自定义事件** | ✅ `event:` 字段原生支持事件分类 | 需在应用层自行定义消息类型 |
| **防火墙友好** | ✅ 标准 HTTP，极少被拦截 | ⚠️ 部分企业防火墙拦截 ws:// |
| **最大连接数** | HTTP/2 下可共享连接 | 浏览器限制 ~6 个/tab，~255 个/全局 |
| **浏览器兼容** | IE 不支持，其余全兼容 | 所有现代浏览器 |
| **Polyfill** | 可用 fetch + ReadableStream 实现 | 通常不需要（但依赖库如 socket.io 提供降级） |
| **连接恢复** | EventSource 原生 Last-Event-ID | 需手动实现消息确认 |
| **依赖体积** | 零依赖（本项目仅用 fetch） | socket.io 客户端 ~15KB gzip |

---

## 三、优劣势分析

### 3.1 SSE 的优势

**① 部署零摩擦**
Nginx、CDN、API 网关对 SSE 完全透明。不需要像 WebSocket 那样在反向代理层配置 `Upgrade` 头。本项目的 Docker Compose 方案中，Nginx 只需要一行 `proxy_buffering off`。

**② 浏览器原生事件分类**
SSE 的 `event:` 字段可以直接区分消息类型。看本项目实际应用：

```typescript
// 后端发送不同事件（index.ts）
sendEvent('chunk', { content: partialToken })   // 流式文本片段
sendEvent('done',  { content: fullText, sessionId })  // 传输完成
sendEvent('error', { error: message })          // 错误通知
```

前端只需要检查 `data.content` 是否带 `sessionId` 就能区分事件类型，不需要像 WebSocket 那样在消息体里自己塞一个 `type: "chunk"` 字段。

**③ 自动重连 + 断点续传**
`EventSource` API 原生支持 Last-Event-ID 机制：

```
服务端 → event: done\ndata: {"content":"...","sessionId":"xxx"}\n\n
           ↑
    客户端断开后重连时，会在新 HTTP 请求中带：
    Last-Event-ID: <上一次最后收到的事件 ID>
```

本项目使用 `fetch + ReadableStream` 而非 `EventSource`（因为需要 POST 方法、自定义请求头），所以这个能力需要自己实现，但它本身是 SSE 协议自带的能力。

**④ HTTP/2 多路复用**
在 HTTP/2 下，多个 SSE 流可以复用同一个 TCP 连接，不会像 WebSocket 那样每个连接独占一个 TCP 连接。对于需要同时监听多个推送通道的场景（虽然本项目不需要），这是显著优势。

### 3.2 SSE 的劣势

**① 单向通信限制**
客户端发消息必须通过另一个 HTTP 请求。本项目正是这么做的——客户端发消息用 `fetch POST /api/chat/stream` 建立 SSE 连接，AI 回复通过这个连接返回。这恰好匹配"一问一答"的交互模型，但对"需要在一个连接上反复通信"的场景不适用。

**② 不支持二进制数据**
SSE 只能传输 UTF-8 文本。如果要传输图片、音频等二进制数据，需要 Base64 编码（增大 33% 体积）。本项目图片识别功能中，图片上传走另一个 `POST /api/vision/chat` 接口，不经过 SSE 流，避开了这个限制。

**③ 浏览器并发连接限制**
HTTP/1.1 下浏览器限制同域名 6 个并发 HTTP 连接，如果有多个 SSE 流可能被阻塞。但 HTTP/2 下不存在此问题，现代浏览器和服务器基本都支持 HTTP/2。

**④ 只能 GET（EventSource API 限制）**
EventSource API 只支持 GET 请求，无法自定义请求头或发送请求体。本项目因此放弃了 EventSource，改用 `fetch + ReadableStream` 手动解析 SSE 流，从而支持 POST 方法和 JSON 请求体。

### 3.3 WebSocket 的优势

**① 全双工通信**
适用于需要服务端主动推送 + 客户端频繁发送的场景（如实时协作编辑、游戏）。

**② 二进制帧**
原生支持二进制数据传输，低延迟低开销。

**③ 更低的每消息开销**
WebSocket 帧头仅 2-10 字节（SSE 每消息需要 `event: xxx\ndata: {...}\n\n` 的文本开销）。

**④ 成熟的生态**
`socket.io` 提供自动重连、房间/命名空间、心跳检测、降级轮询（long polling fallback）等开箱即用的能力。

### 3.4 WebSocket 的劣势

**① 部署复杂**
Nginx 需要额外配置：
```nginx
location /ws {
    proxy_pass http://backend;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
}
```

部分 CDN / API Gateway（如 AWS API Gateway 的 HTTP API 模式）不支持 WebSocket，需要切换到 WebSocket API 类型，增加架构复杂度。

**② 连接状态管理**
WebSocket 断开后不会自动重连，需要应用层手动管理：心跳检测、断线重连、消息重发、状态同步等。`socket.io` 封装了这些，但引入了一个 15KB 的依赖。

**③ 中间件不透明**
HTTP Upgrade 握手成功后，协议从 HTTP 切换为 WebSocket，Express/Koa 中间件（日志、限流、认证）不再介入后续消息帧。需要在 WebSocket 层重新实现这些逻辑。

**④ HTTP/2 下无多路复用优势**
每个 WebSocket 连接独占一个 TCP 连接，多个 WebSocket 不能像 SSE 那样共享。

---

## 四、场景选型决策树

```
                        需要双向实时通信？
                       /                \
                     是                  否
                     │                   │
                     ▼                   ▼
            需要极低延迟？          只需要服务端推送？
           /          \             /             \
         是            否         是               否
         │             │          │                │
         ▼             ▼          ▼                ▼
      游戏        在线协作       SSE             普通 HTTP
      WebSocket   WebSocket    （本项目）        （轮询/REST）
                                 │              /         \
                                 │          老浏览器？    现代浏览器？
                                 │              │            │
                                 │           ❌ 不行      ✅ 完全可行
                                 │         （需要 polyfill）
                                 │
                            有二进制数据要推送？
                           /                    \
                         是                      否
                         │                       │
                         ▼                       ▼
                  可以单独 HTTP              纯文本
                  接口传二进制？                │
                 /           \               SSE ✅
               是             否
               │              │
               ▼              ▼
          SSE ✅          WebSocket
    （本项目做法：       （或 SSE +
    图片走 /vision          文本用 SSE）
    接口）
```

---

## 五、为什么本项目选 SSE

### 5.1 业务模型天然匹配

厨神小助的交互模型是**严格的一问一答**：

```
用户 → "红烧肉怎么做"  ──────────→  服务端
                                        │
                                   ReAct 推理循环
                                   （搜索菜谱 / 查询营养 / 查食品安全）
                                        │
用户 ←── "好的，红烧肉的做法如下…" ←── 流式输出
```

不存在"用户在 AI 回复过程中持续发送消息"的需求，也不存在"服务端在用户没发消息时主动推送"的需求。**单向推送足够，全双工能力完全浪费。**

### 5.2 部署简单

项目目标之一是"本地 ```docker-compose up``` 就能跑"。如果用 WebSocket 还需要配置 Nginx 的 Upgrade 头、处理 WS 断线重连、引入 socket.io 依赖。SSE 只需要在 Nginx 中关掉缓冲，其余完全透明。

### 5.3 调试友好

开发阶段可以通过浏览器 Network 面板直接看到每个 SSE 事件的内容，不需要额外的 WS 调试工具。后端日志中 SSE 连接的建立、chunk 发送、done 结束都有清晰日志，排查问题直观。

### 5.4 与现有架构无缝集成

- Express 的 CORS / 限流 / 日志中间件对 SSE 路由完全有效
- 前端已有的 `fetch` 封装和 `AbortController` 取消机制直接复用
- `/api/chat`（非流式）和 `/api/chat/stream`（流式）共用同一个 Agent，只是结果推送方式不同

---

## 六、什么情况下应该换成 WebSocket？

| 条件 | 说明 |
|------|------|
| 新增"多轮澄清对话"功能 | 用户在 AI 回复到一半时打断、追问 → 需要双向通信 |
| 新增"实时协作菜谱编辑" | 多用户同时编辑同一份菜谱 → 需要双向广播 |
| 新增"语音对话" | 语音数据是二进制，需要 WebSocket 原生二进制帧支持 |
| 新增"IoT 设备集成" | 如智能厨具实时推送温度数据 + 接收控制指令 |
| 需要服务端主动推送通知 | 如"您订阅的菜品有了新的做法"（不过 SSE + 单独 POST 也能实现） |

如果将来需要以上功能，推荐的切换方案：

```
当前架构                        切换后
────────────────────────      ────────────────────────
聊天消息 → SSE                 聊天消息 → WebSocket（主通道）
图片上传 → HTTP POST           图片上传 → WebSocket 二进制帧
会话管理 → REST API            会话管理 → REST API（不变）
健康检查 → HTTP GET            心跳检测 → WebSocket ping/pong
```

使用 `socket.io` 的好处是它自带 HTTP long-polling 降级，即使 WebSocket 连接在防火墙/代理处被阻断也能退化为 HTTP 轮询。

---

## 七、两者共存的可能性

在一些复杂场景下，SSE 和 WebSocket 可以**同时使用**，各司其职：

```
┌─────────────────────────────────────────────────┐
│                   厨神小助                       │
│                                                  │
│  SSE (text/event-stream)      WebSocket (ws://) │
│  ─────────────────────        ───────────────   │
│  · AI 对话流式输出             · 实时协作编辑     │
│  · 系统通知推送                · 语音通话        │
│  · 数据更新监播                · IoT 设备通信     │
│                                                  │
│  REST API (HTTP)                                 │
│  ────────────────────                            │
│  · 会话 CRUD                                     │
│  · 用户画像                                      │
│  · 文件上传/下载                                  │
└─────────────────────────────────────────────────┘
```

---

## 八、SSE 与人机协作（交互式工具）

### 8.1 场景引入

厨神小助不仅会"自问自答"，LLM 还会**主动把决策权交回用户**——比如询问"你想做川菜还是粤菜？"。这就是人机协作（Human-in-the-Loop），需要 SSE 流能够**中途暂停**，等用户选择后再**续点**继续生成。

### 8.2 SSE 协议扩展

SSE 的 `event:` 字段天然支持自定义事件类型，因此新增 1 种事件即可支持交互：

```
event: chunk                # LLM 输出 token（原有）
data: {"content": "好的，川菜口味偏重…"}

event: interactive_request  # ← 新增：交互式工具触发
data: {"interactiveId": "tool_call_xxx", "question": "想做哪种菜系？", "options": ["川菜","粤菜"], "multiSelect": false}

event: done                 # 流正常结束（原有）
data: {"content": "完整回答", "sessionId": "abc123"}
```

收到 `interactive_request` 事件后，SSE 连接由服务端 `res.end()` 关闭，前端展示选项卡片。用户点击后调用新的 `POST /api/chat/continue` 端点，**开新流**继续生成。

### 8.3 为什么 SSE 比 WebSocket 更适合此场景

| | SSE（开新流） | WebSocket（双工消息） |
|------|---------------|---------------------|
| **协议复杂度** | 多一个 `/api/chat/continue` HTTP 端点 | 在同一通道里发 JSON 消息 |
| **状态管理** | sessionId 决定续点归属，状态机清晰 | 需要在 WS 服务器内维护"等待用户输入"标记 |
| **断线恢复** | 浏览器/代理重连后用 sessionId 重新调 `/continue` | 需手动实现重连、消息去重、断点续传 |
| **HTTP 生态** | 复用 fetch / 中间件 / 限流 / 鉴权 | 需在 ws 框架里重新实现 |
| **服务端实现成本** | `agent.resumeInteractive()` 与 `chatStream` 共享循环 | 需引入"消息分发器" |
| **是否需要长连接** | ❌ 流结束即释放 | ✅ 长连接保活（心跳、断线检测） |

**核心结论：** 交互式工具是"半双工"模型——服务端暂停后等用户输入，**此时并不需要双向通信**。SSE 在"暂停 → 续点"的两段式流程里表现更优，状态完全无状态化（sessionId 决定上下文）。

### 8.4 完整的端到端时序

```
┌─────────┐                       ┌─────────┐                  ┌─────────┐
│ 浏览器  │                       │ Express │                  │  Agent  │
└────┬────┘                       └────┬────┘                  └────┬────┘
     │  POST /api/chat/stream          │                             │
     │─────────────────────────────────>                             │
     │                                │  chatStream()                │
     │  event: chunk ...              │────────────────────────────>│
     │<────────────────────────────────│                             │
     │  event: interactive_request    │  onInteractive()             │
     │    { interactiveId, options }  │<────────────────────────────│
     │<────────────────────────────────│  res.end()                   │
     │                                │                              │
     │  (SSE 关闭)                     │                              │
     │  POST /api/chat/continue        │                              │
     │    { sessionId, choice }        │  resumeInteractive()         │
     │─────────────────────────────────>────────────────────────────>│
     │  event: chunk ...              │                              │
     │<────────────────────────────────│                              │
     │  event: done                   │  onDone()                    │
     │<────────────────────────────────│                              │
```

### 8.5 与 WebSocket 实现对比

如果改用 WebSocket 实现同样的人机协作，需要：

```typescript
// 伪代码：WS 实现
wss.on('connection', (ws) => {
  ws.on('message', async (data) => {
    const msg = JSON.parse(data)
    if (msg.type === 'user_message') {
      const stream = agent.chatStream(msg.text, msg.sessionId, {
        onInteractive(req) {
          ws.send(JSON.stringify({ type: 'interactive_request', payload: req }))
          // 注意：此时连接还活着，要进入"等待"状态
          ws._waitingForChoice = req.id  // 状态标记
        },
      })
    }
    if (msg.type === 'user_choice') {
      // 检测到上一轮是等待状态？
      if (ws._waitingForChoice === msg.interactiveId) {
        agent.resumeInteractive(ws._sessionId, msg.interactiveId, msg.choice, ...)
        ws._waitingForChoice = null
      }
    }
  })
})
```

**对比 SSE 方案：**

- 多了"连接内状态"——服务端需追踪"当前是否在等用户"
- 消息需要 `type` 字段区分（chunk/choice/...）
- 续点失败时需要清理状态，超时/重连都要处理
- 部署需配 Nginx `Upgrade` 头，处理 `wss://` 证书

**结论：** 当交互式是"低频"且"段落式"时（用户在 AI 完成一段生成后才选），SSE 方案显著更简洁；只有"高频双向"（语音、协作编辑）才值得上 WebSocket。

---

## 九、总结

| | SSE | WebSocket |
|------|-----|-----------|
| **一句话总结** | 一个永不结束的 HTTP 响应 | 一次 HTTP 握手后的独立双向通道 |
| **最适合** | 单向推送：AI 流式输出、通知、进度更新 | 双向实时：聊天、协作、游戏 |
| **最不适合** | 客户端频繁向服务端发消息 | 纯服务端单向推送 |
| **部署复杂度** | 低 — HTTP 生态透明兼容 | 中 — 需 Nginx Upgrade 配置 |
| **本项目适用度** | ⭐⭐⭐⭐⭐ 模型天然匹配 | ⭐ 能力溢出、部署成本高 |
| **前端依赖** | 零（本项目用 fetch） | socket.io ~15KB |
| **后端改动** | 无（Express 原生支持） | 需引入 ws/socket.io 库 |
| **交互式工具** | ✅ `/api/chat/continue` 开新流，无状态化 | ⚠️ 需维护"等待用户输入"标记 |
| **续点实现** | 共享 `agent.resumeInteractive()` | 需在 WS 分发器里手写恢复逻辑 |
| **断线恢复** | sessionId 兜底，前端重调即可 | 需消息序号 + 状态机 |