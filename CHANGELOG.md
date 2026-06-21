# 更新日志 (Changelog)

本项目所有重要功能、性能优化、Bug 修复的变更记录都汇总在本文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范，
本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/) 但目前仍处于 0.x 阶段。

---

## [Unreleased] — 2026-06-21

### ✨ 新增 (Added)

#### 交互式工具补齐
- **text 输入**：用户可在 AI 调起 `ask_user_text` 时直接在对话框中输入文字
- **confirm 确认**：用户面对"是/否"类问题时显示双按钮（确认 / 取消）
- **slider 滑块**：用户调整 0-100 或自定义范围的数值
- **choice 列表带图**：选项支持 `image` 字段，前端用 `<img>` 缩略图渲染

#### Markdown 渲染增强
- **Mermaid 图表渲染**：AI 输出的 ` ```mermaid ` 代码块自动渲染为 SVG
- **KaTeX 公式渲染**：AI 输出的 `$...$` / `$$...$$` 自动用 KaTeX 排版
- **代码高亮**：通过 `highlight.js` 渲染 `<pre><code>` 块的语法着色
- **动态导入**：Mermaid / KaTeX / highlight.js 都通过 `import()` 懒加载，初始 bundle 体积下降 ~120KB

#### ReAct 推理中间状态反馈（P1 性能优化）
- **`progress` SSE 事件**：后端 ReAct 循环 4 个关键节点下发结构化进度
  - `thinking` — LLM 调用前："🧠 正在推理第 1 / 5 步…"
  - `tool_call` — 工具即将执行："🔧 正在调用 search_recipe…"
  - `tool_result` — 工具执行完成
  - `streaming` — 进入流式回答阶段
- **进度指示器 UI**：[ReActProgressIndicator.vue](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-app/src/components/MessageBubble/ReActProgressIndicator.vue) 蓝底小指示器，200ms 淡入淡出
- **`useReActProgress` 单例 ref**：模块级 ref 暴露状态，避免污染 Pinia store 边界

#### SSE 心跳保活（P1 性能优化）
- **服务端 15s 心跳注释行**：[http/sse.ts](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-agent/src/http/sse.ts) 启动 `setInterval` 每 15s 写一条 `:heartbeat\n\n`
- **前端注释行识别**：[api/sse.ts](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-app/src/api/sse.ts) `line.startsWith(':')` 跳过数据组装，转调 `onHeartbeat`
- **静默计时器重置**：[useStreamEvents.ts](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-app/src/hooks/conversation/useStreamEvents.ts) 收到心跳后 reset 30s 静默计时器

#### 断连自动重连（P1 性能优化）
- **`useAutoReconnect` 通用包装器**：[useAutoReconnect.ts](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-app/src/hooks/conversation/useAutoReconnect.ts) 指数退避 1s → 2s → 4s，最多 3 次
- **AbortSignal 感知**：用户中途停止时 sleep 立即拒绝，不浪费重试
- **aiMsg 文本不重置**：重连期间已收到的 AI 回复内容保留，体感"无感恢复"
- **ElMessage 提示**：`onRetry` 回调触发"连接中断，正在重试 (1/3)…"提示
- **双层 AbortSignal**：外层 `useStopGeneration`（用户一键停止）+ 内层 `attemptStream` 每次新建（重连时旧 fetch 已死）

### 🔧 变更 (Changed)

- **`chatStream` 签名**：新增第 7 个参数 `onProgress?: (event: ReActProgressEvent) => void`
- **`resumeInteractive` 签名**：同上，新增 `onProgress` 参数
- **`ReActLoopDeps` 接口**：新增 `onProgress` 回调字段
- **Markdown 渲染管线**：节流 60ms；Mermaid/KaTeX 改为动态 `import()`
- **SSE 端点**：注入 15s 心跳 `setInterval` + 3 标记守卫（`finished` / `writableEnded` / `hasStreamed`）

### 🐛 修复 (Fixed)

- **AbortError 状态卡死**：移除 `error.name === 'AbortError'` 时对 `loading` 状态的特殊处理
- **SSE `close` 误触发**：`req.on('close')` 守卫加入 `hasStreamed` 标志位，未收到任何数据就关闭不算中止
- **空内容兜底**：ReAct 循环跑完但 `fullContent === ''` 时 fallback 到"抱歉，这个问题比较复杂…"
- **流式 Markdown 闪烁**：节流 `marked.parse` 至 60ms 间隔，避免每个 token 都重新解析整段

### 📚 文档 (Documentation)

- 新增 [streaming-guide.md §9 P1 总结](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-app/src/views/streaming-guide.md)：端到端协议改动 / 14 个文件 / 6 个设计决策 / 验证 / 体感提升
- 更新 [agent-dev-guide.md §8.2.1-§8.2.2](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-agent/docs/agent-dev-guide.md)：progress 事件与 `:heartbeat` 详细代码
- 更新 [interactive-dialogue-deep-dive.md](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-agent/docs/interactive-dialogue-deep-dive.md) 顶部：P1 提示 + 附录 B 签名 7 参数
- 更新 [sse-vs-websocket.md §3.1 ③ + §5.5](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-app/src/views/sse-vs-websocket.md)：P1 优化整合到协议选型
- 更新根 [README.md](file:///e:/workspace/private/ai-agent-cooking-sse/README.md) 核心特性表：3 行 P1
- 更新 [cooking-agent/README.md](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-agent/README.md) P1 章节
- 更新 [cooking-app/README.md](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-app/README.md) P1 实现位置表格

### 📁 新增文件

- [cooking-app/src/hooks/conversation/useAutoReconnect.ts](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-app/src/hooks/conversation/useAutoReconnect.ts) — 自动重连包装器
- [cooking-app/src/hooks/conversation/useReActProgress.ts](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-app/src/hooks/conversation/useReActProgress.ts) — 进度状态单例
- [cooking-app/src/components/MessageBubble/ReActProgressIndicator.vue](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-app/src/components/MessageBubble/ReActProgressIndicator.vue) — 进度指示器 UI

---

## [1.0.0] — 之前的稳定基线

> 此前功能已通过 git commit 记录，未单独在此列出。
> 主要能力包括：ReAct + Function Calling Agent、7 大烹饪工具、SQLite/MySQL 持久化、Vue3 流式对话 UI、Docker Compose 一键启动、Markdown 基础渲染、图片识别。

详细历史请用 `git log --oneline` 查看。
