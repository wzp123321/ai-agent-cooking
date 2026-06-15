# Debug: agent-call-failure

> Session ID: `agent-call-failure`
> Status: **[RESOLVED — 非代码问题]**
> Started: 2026-06-15
> Resolved: 2026-06-15

## 用户反馈（症状）

> "agent服务怎么调用失败了"（agent service call failed）

实际 vs 预期：
- 实际：调用 agent 服务失败
- 预期：agent 服务能正常返回流式响应

## 复现信息

- 失败时报错来源：后端 agent 进程控制台
- 已确认正常的环节：agent 进程已起来且没退
- HTTP 状态：402

## 后端控制台原始报错

```
[Agent] ⚠️ LLM 调用失败（第 1/3 次），500ms 后重试：402 Insufficient Balance
[Agent] ⚠️ LLM 调用失败（第 2/3 次），1000ms 后重试：402 Insufficient Balance
[Agent] ❌ 流式调用失败 [1779202765205_x378gl]：402 Insufficient Balance
[Agent] 📋 失败时已生成 0 字符，0 次工具调用
[Route] ❌ SSE [1779202765205_x378gl] 出错：402 Insufficient Balance
```

## 候选假设核验

| # | 假设 | 状态 | 证据 |
|---|---|---|---|
| H1 | DeepSeek API Key 无效/过期 | ❌ 排除 | Key 有效，请求成功抵达 DeepSeek（拿到 402 而非 401） |
| **H2** | **DeepSeek 余额/配额耗尽** | ✅ **命中** | **HTTP 402 Insufficient Balance** |
| H3 | agent 进程没起来 / 9000 端口未监听 | ❌ 排除 | 进程仍在运行，未退出 |
| H4 | 环境变量没注入到 LLM 模块 | ❌ 排除 | 请求成功抵达 DeepSeek，说明 `DEEPSEEK_API_KEY` 已正确加载 |
| H5 | OpenAI SDK 与 DeepSeek 协议不兼容 | ❌ 排除 | 错误在 HTTP 层返回，未走到 SDK 解析阶段 |

## 根因

DeepSeek 账户余额耗尽。重试机制在 `cooking-agent/src/agent.ts` 中按指数退避（500ms / 1000ms / 2000ms）重试 3 次后仍失败，HTTP 402 是不可恢复的服务端错误，**代码层面无法绕过**。

## 修复动作（非代码层面）

前往 [DeepSeek 控制台](https://platform.deepseek.com/) 充值账户 → 重启 agent 服务 → 前端重试即可。

## 重启命令

```bash
cd cooking-agent
# 停止当前进程：Ctrl+C 或 kill <PID>
npm run dev
```

## 经验沉淀（避免下次再踩）

1. **402 不应该无限重试**：`agent.ts` 当前的指数退避对所有错误一视同仁，402 / 401 这类"配置类 / 账户类"错误应当**立即失败**而非重试 3 次浪费 3.5s。
2. **建议改进**（未实施，待用户确认是否需要）：
   - 在 `deepseek.ts` 中捕获 `status === 402` / `401` 时直接抛出，不进入重试队列
   - 在前端 `useConversation.ts` 的 `onError` 中对 `402` / `401` 给出更明确的提示（如"DeepSeek 账户余额不足，请联系管理员"）
3. **预防手段**（未实施）：可在 `cooking-agent` 启动时加一个 `ping` 调用 DeepSeek `/user/balance` 接口，若余额 < 阈值则打印 WARN 提醒。

## 进度日志

- 2026-06-15 启动会话
- 2026-06-15 用户提供后端控制台报错 → 锁定 H2
- 2026-06-15 标记 RESOLVED（运维侧问题，不需代码修复）

## 状态

✅ 会话结束。无插桩代码、无调试服务器需要清理（本次未插入任何 instrumentation）。
