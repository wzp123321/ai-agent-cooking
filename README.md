# cooking-ai — AI 烹饪智能体 🍳

> **AI烹饪助手 / AI Cooking Assistant** — 基于 DeepSeek 大模型的智能做菜问答机器人。
> 支持菜谱查询、营养计算、食品安全检查、烹饪技法教学、食材替换、食材推荐、膳食模式适配。
> 采用 ReAct 推理框架 + Function Calling，内置 RAG 知识库，支持流式对话和多轮记忆。
>
> An intelligent cooking Q&A agent powered by DeepSeek LLM. Features recipe search,
> nutrition analysis, food safety, cooking techniques, ingredient substitution,
> meal suggestion, and dietary adaptation. Built with ReAct + Function Calling + RAG.

## 项目结构

```
cooking-ai/
├── cooking-agent/          ← Node.js Agent 后端（TypeScript，端口 9000）
│   ├── src/
│   │   ├── index.ts        ← Express 服务入口
│   │   ├── agent.ts        ← CookingAgent 核心（ReAct + Function Calling）
│   │   ├── prompts.ts      ← 系统提示词（动态生成工具描述）
│   │   ├── types.ts        ← 核心类型
│   │   ├── loader.ts       ← Skill 文件加载器
│   │   ├── llm/            ← LLM Provider 抽象层
│   │   │   ├── index.ts    ← Provider 注册中心
│   │   │   ├── types.ts    ← 统一接口定义
│   │   │   └── deepseek.ts ← DeepSeek Provider 实现
│   │   ├── db/             ← 数据库层
│   │   │   ├── index.ts    ← 连接管理
│   │   │   ├── migrate.ts  ← 数据库迁移
│   │   │   ├── session.repository.ts
│   │   │   ├── message.repository.ts
│   │   │   └── user-profile.repository.ts
│   │   ├── tools/          ← 工具目录
│   │   │   ├── types.ts    ← 工具类型定义
│   │   │   ├── index.ts    ← 工具注册表
│   │   │   ├── recipe.ts   ← 菜谱查询
│   │   │   ├── nutrition.ts← 营养计算
│   │   │   ├── safety.ts   ← 食品安全
│   │   │   ├── technique.ts← 烹饪技法
│   │   │   ├── suggest.ts  ← 食材推荐
│   │   │   ├── substitute.ts ← 食材替换
│   │   │   └── diet.ts     ← 膳食适配
│   │   └── knowledge/      ← RAG 知识库
│   │       ├── types.ts
│   │       └── retriever.ts ← TF-IDF 检索器
│   ├── skills/             ← Skill 定义（.md 文件）
│   └── docs/               ← 开发文档
│
└── cooking-app/            ← Vue3 前端（端口 5173）
    ├── src/
    │   ├── views/ChatView.vue
    │   ├── components/
    │   │   ├── SidebarPanel.vue
    │   │   ├── MessageList.vue
    │   │   ├── MessageBubble.vue
    │   │   ├── InputBar.vue
    │   │   ├── WelcomeScreen.vue
    │   │   └── ProfileSettings.vue
    │   ├── stores/chat.ts      ← Pinia 状态管理
    │   ├── api/
    │   │   ├── request.ts      ← Axios 实例（拦截器）
    │   │   └── chat.ts         ← API 客户端
    │   ├── hooks/              ← 自定义 Hooks
    │   ├── router/index.ts     ← Vue Router
    │   ├── constants/index.ts  ← 公共常量
    │   └── types/index.ts      ← 前端 TS 类型
    └── README.md
```

## 核心特性

| 特性                 | 说明                                                   |
| -------------------- | ------------------------------------------------------ |
| 🤖 **真正的 Agent**  | ReAct 推理循环 + Function Calling                      |
| 🔧 **7 大工具**      | 菜谱 / 营养 / 安全 / 技法 / 推荐 / 食材替换 / 膳食适配 |
| ⚡ **流式响应**      | SSE 打字机效果                                         |
| 🧠 **ReAct 进度反馈** | 实时显示 "🧠 正在推理第 N 步" / "🔧 正在调用 XX" 指示器（P1） |
| 💓 **SSE 心跳保活**  | 15s 心跳注释行，长 ReAct 不被 nginx 切断（P1）        |
| 🔁 **断连自动重连**  | 指数退避 1s→2s→4s 最多 3 次，弱网/移动端无感恢复（P1） |
| 💬 **多轮对话**      | Session 级别记忆 + 历史持久化                          |
| 📱 **响应式**        | 移动端适配                                             |
| 🔄 **LLM 重试**      | 指数退避自动重试（最多 3 次）                          |
| 🛡️ **请求限流**      | IP 级别限流（每秒 10 次）                              |
| 👤 **用户画像**      | 过敏食材 / 膳食模式 / 烹饪水平偏好                     |
| 📚 **RAG 知识库**    | TF-IDF 检索增强生成                                    |
| 🔌 **多模型支持**    | DeepSeek / OpenAI 可切换                               |
| 🎨 **Markdown 渲染** | AI 回复支持富文本 + Mermaid 图表 + KaTeX 公式          |
| ⌨️ **快捷键**        | Ctrl+N 新建对话                                        |

## 快速启动

**第一步：配置 Agent**

```bash
cd cooking-ai/cooking-agent
cp .env.example .env
# 填入 DEEPSEEK_API_KEY=sk-xxxxxxxx

npm install
npm run dev   # 开发模式（tsc --watch）
```

**第二步：启动前端**

```bash
cd cooking-ai/cooking-app
npm install
npm run dev   # 访问 http://localhost:5173
```

## Agent 工具说明

| 工具                       | 触发场景   | 示例问题                             |
| -------------------------- | ---------- | ------------------------------------ |
| `search_recipe`            | 问菜谱做法 | "红烧肉怎么做"                       |
| `calculate_nutrition`      | 问营养热量 | "这道菜减肥能吃吗"                   |
| `check_food_safety`        | 问食品安全 | "四季豆能吃吗"                       |
| `explain_technique`        | 问烹饪技法 | "炒菜怎么才不粘锅"                   |
| `suggest_dishes`           | 问食材推荐 | "我冰箱里有鸡胸肉和西兰花，能做什么" |
| `suggest_substitute`       | 问食材替代 | "没有料酒能用什么代替"               |
| `check_diet_compatibility` | 问膳食适配 | "这道菜适合生酮饮食吗"               |

## 技术栈

**后端**：`TypeScript` + `Node.js` + `Express` + `OpenAI SDK` + `better-sqlite3`

**前端**：`Vue 3` + `Vite` + `Pinia` + `Vue Router` + `TypeScript` + `Element Plus` + `Axios` + `marked`

## 更新日志

完整功能迭代、性能优化、Bug 修复记录见 [CHANGELOG.md](file:///e:/workspace/private/ai-agent-cooking-sse/CHANGELOG.md)。
