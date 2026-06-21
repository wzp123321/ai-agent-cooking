# Debug Session: assistant-tool-messages-shortage
**Status:** [✅ 已修复 - 待用户复测]
**Error:** `400 An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. (insufficient tool messages following tool_calls message)`
**Scope:** cooking-agent 后端，pre-fix 时代脏数据触发 400
**User said:** 智能体报错了（应用上一轮 fix 后仍报错）

## 铁证
session `1781707042212_2kslo7` 的实际状态：
- `created_at=1781707048726`（2026-06-17 14:50）→ **pre-fix 时代**就存在
- id=52 = `assistant(tool_calls)` 含 1 个 `ask_user_choice`
- id=53/58/59 = user 消息（用户没回答 question 直接继续提问）
- id=52 之后**无任何 tool 响应**（pre-fix bug 产物）
- `updated_at=1782025620739`（2026-06-21 08:47）→ 用户今天复用这个 session → 立即 400

## 假设状态
- **H1 ⛔ 排除**: 无法验证 agent 服务是否有重启，但 H2 已能独立解释错误
- **H2 ✅ 确认**: 用户复用了 pre-fix 时代创建的 session，DB 有脏数据
- **H3 ⛔ 排除**: 代码静态分析未发现其他 LLM 调用路径
- **H4 ⛔ 排除**: parseInteractiveArgs 透传 id（`return { id, ... }`），req.id === tool_call.id
- **H5 ⛔ 排除**: 错误日志 `0 工具` 表明第一次 LLM 调用即失败，无后续 ReAct 串改

## 根因
pre-fix 时代 `handleToolCalls` 只持久化 assistant(tool_calls) 不写 tool 响应 → 留下脏数据。
今天用户复用该 session → `loadMessages` 加载到这条 assistant → LLM 第一次调用即 400。

## 修复
在 `cooking-agent/src/agent.ts` 的 `loadMessages` 中增加"内存合成缺失 tool 响应"逻辑：
- 扫描每条 `assistant(tool_calls)` 之后的所有 tool 消息（直到下一个 assistant/user）
- 缺失的 `tool_call_id` 在内存中合成 `synthesized_legacy` 占位 tool 消息插入
- **DB 不动**（保留前端 UI 状态，脏数据后续一次性迁移脚本清理）
- 详细注释标记为 "P-修复-2"

## 验证
- 单元测试 `testLoadMessagesSynthesizesMissingToolResponses`：✅
- 完整测试套件：10/10 ✅
- 日志输出确认：`[Session] 🛠️ 加载 [...] 时为 1 个历史 tool_call_id 合成占位 tool 消息（仅内存，DB 未修改）`

## 待办
- [ ] 用户重启 cooking-agent 服务（新代码）
- [ ] 复用任意老 session 发消息
- [ ] 预期：不再报 400，agent 正常响应
- [ ] （可选）写一次性迁移脚本把 DB 脏数据也补全

## 计划
- 步骤 1：实施修复 + 加测试 ✅
- 步骤 2：跑测试验证 ✅
- 步骤 3：让用户重启服务 + 重新触发，复测



