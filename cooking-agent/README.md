# cooking-agent

> 🍳 厨神小助 — 基于 DeepSeek 的做菜智能体 Agent（TypeScript）

## 技术栈

| 技术 | 用途 |
|------|------|
| **TypeScript** | 全程类型安全 |
| **OpenAI SDK** | DeepSeek API 调用（含 Function Calling） |
| **Express** | HTTP REST API |
| **dotenv** | 环境变量管理 |

## 架构：真正的 Agent（ReAct + Function Calling）

```
用户: "我有鸡胸肉和西兰花，热量多少？推荐什么菜？"

          ↓

┌─────────────────────────────────────────────────────────────┐
│                    ReAct 推理循环                              │
│                                                             │
│  步1: Thought → 我需要先推荐菜品，再计算热量                │
│       Action  → suggest_dishes                             │
│       Observe → 推荐了"蒜蓉西兰花"、"宫保鸡丁"...         │
│                                                             │
│  步2: Thought → 用户问热量，我计算推荐菜品的营养           │
│       Action  → calculate_nutrition                        │
│       Observe → 蒜蓉西兰花约 120kcal/份                    │
│                                                             │
│  步3: LLM 综合结果 → 给出完整推荐回答                       │
└─────────────────────────────────────────────────────────────┘
```

## 工具体系

| 工具 | 功能 | 数据来源 |
|------|------|---------|
| `search_recipe` | 查询菜谱详细做法 | 内置8道经典菜数据库 |
| `calculate_nutrition` | 计算营养成分 | 内置20+种食材营养库 |
| `check_food_safety` | 食品安全检测 | 内置危险食材知识库 |
| `explain_technique` | 烹饪技法解释 | 内置10种技法知识库 |
| `suggest_dishes` | 食材推荐菜品 | 内置15+道菜数据库 |

## API 接口

```
GET    /health              健康检查
POST   /api/chat           普通对话（工具调用 + ReAct）
POST   /api/chat/stream    流式对话（打字机效果）
GET    /api/history/:id    获取对话历史
DELETE /api/session/:id   清除会话
```

## P1 性能优化

| 优化项 | 实现位置 | 说明 |
|--------|---------|------|
| **ReAct 进度事件** | `src/agent.ts` 中 `chatStream` / `resumeInteractive` 新增 `onProgress` 回调 | 4 种类型（`thinking` / `tool_call` / `tool_result` / `streaming`），通过 SSE `progress` 事件下发到前端 |
| **SSE 心跳保活** | `src/http/sse.ts` | `setInterval` 每 15s 写一条 `:heartbeat\n\n` 注释行，防止长 ReAct（30s+）被 nginx `proxy_read_timeout` 切断 |
| **3 标记守卫** | `src/http/sse.ts` | `finished` / `writableEnded` / `hasStreamed` 三重检查，准确区分用户中止 vs 网络抖动 |

详细设计见 [docs/agent-dev-guide.md §8.2.1-§8.2.2](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-agent/docs/agent-dev-guide.md) 与 [cooking-app/streaming-guide.md §9](file:///e:/workspace/private/ai-agent-cooking-sse/cooking-app/src/views/streaming-guide.md)。

## 启动

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY=sk-xxxxxxxx

# 3. 开发模式（热更新）
npm run dev

# 4. 生产构建
npm run build
npm start
```

## 目录结构

```
src/
├── index.ts          # Express 入口
├── agent.ts          # CookingAgent 核心（ReAct + Function Calling）
├── prompts.ts        # 系统提示词（含工具描述 + 推理指令）
├── types.ts          # 核心类型定义
└── tools/
    ├── types.ts      # 工具类型定义
    ├── index.ts      # 工具注册表
    ├── recipe.ts     # 菜谱查询工具
    ├── nutrition.ts  # 营养计算工具
    ├── safety.ts     # 食品安全工具
    ├── technique.ts  # 烹饪技法工具
    └── suggest.ts    # 食材推荐工具
```
