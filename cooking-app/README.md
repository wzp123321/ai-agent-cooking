# 厨神小助 - 做菜智能体对话界面

基于 **Vue3 + Vite + Pinia + Vue Router + TypeScript + Element Plus** 开发的烹饪 AI 对话界面。

## 技术栈

| 技术 | 版本 | 说明 |
|------|------|------|
| Vue 3 | ^3.4 | Composition API + `<script setup>` |
| Vite | ^5.2 | 构建工具，含代理配置 |
| Pinia | ^2.1 | 状态管理（会话/消息） |
| Vue Router | ^4.3 | 路由管理 |
| TypeScript | ^5.4 | 全量类型安全 |
| Element Plus | ^2.7 | UI 组件库（暗色主题） |
| marked | ^12 | Markdown 渲染 |

## 项目结构

```
src/
├── main.ts              # 应用入口（注册插件）
├── App.vue              # 根组件
├── vite-env.d.ts        # 环境类型声明
├── assets/
│   └── main.css         # 全局样式 + Element Plus 主题变量
├── types/
│   └── index.ts         # 全局 TS 类型定义
├── api/
│   └── chat.ts          # API 客户端（REST + SSE 流式）
├── router/
│   └── index.ts         # Vue Router 路由配置
├── stores/
│   └── chat.ts          # Pinia Store（会话/消息/状态）
├── views/
│   └── ChatView.vue     # 主页面视图
└── components/
    ├── SidebarPanel.vue # 侧边栏（会话列表 + 快捷问题）
    ├── MessageList.vue  # 消息列表容器
    ├── MessageBubble.vue# 单条消息气泡（Markdown）
    └── InputBar.vue     # 输入框 + 发送按钮
```

## 快速开始

### 1. 确保 cooking-agent 已启动

```bash
cd ../cooking-agent
npm start
```

### 2. 安装依赖

```bash
npm install
```

### 3. 开发模式

```bash
npm run dev
# 访问 http://localhost:5173
```

### 4. 构建生产版本

```bash
npm run build
```

## 功能特性

- 💬 **流式对话**：SSE 打字机效果，实时输出
- 🧠 **ReAct 进度反馈**：AI 思考时显示 "🧠 正在推理第 N 步" / "🔧 正在调用 XX 工具" 指示器（P1）
- 💓 **SSE 心跳感知**：消费器识别 `:heartbeat` 注释行，长 ReAct 不误判卡住（P1）
- 🔁 **断连自动重连**：指数退避 1s→2s→4s 最多 3 次，**保留已收到的 AI 文本不重置**（P1）
- 📝 **Markdown 渲染**：支持代码块、表格、列表、Mermaid 图表、KaTeX 公式
- 🗂️ **多会话管理**：侧边栏会话列表，可新建/切换/删除
- 💡 **快捷问题**：6 个烹饪快捷提问模板
- 📡 **连接状态**：实时检测 Agent 服务健康状态
- 📱 **响应式**：移动端抽屉式侧边栏适配
- 🌙 **暗色主题**：全局暗色 + Element Plus 主题变量覆盖

## P1 性能优化实现位置

| 优化项 | 文件 | 说明 |
|--------|------|------|
| **ReAct 进度事件解析** | `src/api/sse.ts` + `src/hooks/conversation/useReActProgress.ts` | 解析后端 `progress` SSE 事件，模块级 ref 暴露给 UI |
| **心跳注释行识别** | `src/api/sse.ts` | `line.startsWith(':')` 跳过 + 触发 `onHeartbeat` |
| **自动重连包装器** | `src/hooks/conversation/useAutoReconnect.ts` | 指数退避 + AbortSignal 感知 + isReconnecting/retryCount 状态 |
| **进度指示器 UI** | `src/components/MessageBubble/ReActProgressIndicator.vue` | 蓝底小指示器，200ms 淡入淡出，3 个点循环动画 |
| **重连集成** | `src/hooks/conversation/useSendMessage.ts` + `useInteractiveSubmit.ts` | `withReconnect` 包裹；`onRetry` 触发 ElMessage 提示 |
