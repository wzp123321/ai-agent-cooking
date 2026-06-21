/**
 * ============================================================
 * agent/timeout-watcher.ts — 待回答交互式工具的过期清理
 * ============================================================
 *
 * 行为：
 *   - 后台 setInterval 周期性扫描所有 session
 *   - 找出 created_at 早于 cutoff 的 pending_interactive
 *   - 为每条补一条 role='tool' 的"用户超时未答"消息
 *   - 从 pending 数组中移除该条
 *
 * 提取原因：
 *   - 原 CookingAgent.startInteractiveTimeoutWatcher / cleanupStaleInteractives 是
 *     静态方法，与业务逻辑无关
 *   - 抽到独立文件后，agent.ts 主体更聚焦 ReAct + 交互
 *   - 便于单测和未来替换为 Bull / Agenda 等调度器
 */

import { sessionRepo } from '../db/session.repository'
import { messageRepo } from '../db/message.repository'

const INTERACTIVE_TIMEOUT_MS = 10 * 60 * 1000 // 10 分钟
const INTERACTIVE_TIMEOUT_CHECK_INTERVAL_MS = 60 * 1000 // 1 分钟扫一次

let handle: ReturnType<typeof setInterval> | null = null

/**
 * 启动后台清理任务。已启动时为 no-op。
 */
export function startInteractiveTimeoutWatcher(): void {
  if (handle) {
    console.info('[Agent] ⏰ 交互超时监听器已在运行，跳过重复启动')
    return
  }
  handle = setInterval(() => {
    cleanupStaleInteractives().catch((err) => {
      console.error('[Agent] ❌ 交互超时清理失败：', (err as Error).message)
    })
  }, INTERACTIVE_TIMEOUT_CHECK_INTERVAL_MS)
  console.info(
    `[Agent] ⏰ 交互超时监听器已启动（每 ${INTERACTIVE_TIMEOUT_CHECK_INTERVAL_MS / 1000}s 扫描，超时阈值 ${INTERACTIVE_TIMEOUT_MS / 1000}s）`,
  )
}

/**
 * 停止后台清理任务。优雅关闭时调用。
 */
export function stopInteractiveTimeoutWatcher(): void {
  if (handle) {
    clearInterval(handle)
    handle = null
    console.info('[Agent] ⏰ 交互超时监听器已停止')
  }
}

/**
 * 扫描所有 session，清理超时的 pending_interactive。
 * - 补一条 role='tool' 的跳过消息（reason: 'auto_timeout'）
 * - 从 pending 数组中移除
 *
 * P-修复：必须先确保对应的 assistant(tool_calls) 消息存在。
 *   OpenAI 协议要求：role='tool' 的消息前必须有 role='assistant' 且 tool_calls 非空。
 *   历史数据中部分 session 的 pending 来自异常路径（服务崩溃等），
 *   session 行有 pending 但 messages 表里没有 assistant(tool_calls) 记录，
 *   直接补 tool 消息会导致后续 LLM 调用 400 报错：
 *     "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"
 *
 * 行为：
 *   - 若 messages 表中已存在 tool_call_id = p.id 的对应 assistant(tool_calls) → 仅补 tool 消息
 *   - 若不存在 → 用 pending.arguments 合成一条 assistant(tool_calls) 消息，再补 tool 消息
 *
 * @returns 实际清理的条数
 */
export async function cleanupStaleInteractives(): Promise<{ cleaned: number }> {
  const cutoff = Date.now() - INTERACTIVE_TIMEOUT_MS
  const sessions = await sessionRepo.findAll()
  let cleaned = 0

  for (const session of sessions) {
    const list = await sessionRepo.getPendingInteractiveList(session.id)
    if (list.length === 0) continue

    const stale = list.filter((p) => p.created_at < cutoff)
    if (stale.length === 0) continue

    console.info(`[Agent] ⏰ 清理过期 pending [${session.id}]：${stale.length} 个`)

    for (const p of stale) {
      try {
        const now = Date.now()

        // 1) 防御：先看 messages 表中是否已有对应 assistant(tool_calls)
        const hasAssistant = await messageRepo.hasAssistantToolCall(session.id, p.id)
        if (!hasAssistant) {
          // 2) 合成一条 assistant(tool_calls) 消息
          await messageRepo.insert(
            session.id,
            {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: p.id,
                  type: 'function',
                  function: { name: p.name, arguments: p.arguments },
                },
              ],
            },
            now,
          )
          console.info(`[Agent] 🛠️ 补建 assistant(tool_calls) [${session.id}] id=${p.id}`)
        }

        // 3) 补 tool 消息
        await messageRepo.insert(
          session.id,
          {
            role: 'tool',
            tool_call_id: p.id,
            content: JSON.stringify({
              user_choice: null,
              skipped: true,
              reason: 'auto_timeout',
              hint: '用户未在超时时间内回答，请自行决定最合适的方案',
            }),
          },
          now,
        )
        await sessionRepo.removePendingInteractive(session.id, p.id, now)
        cleaned++
      } catch (err) {
        console.warn(`[Agent] ⚠️ 清理单个 pending 失败 [${p.id}]：`, (err as Error).message)
      }
    }
  }

  if (cleaned > 0) {
    console.info(`[Agent] ⏰ 本轮清理完成：共 ${cleaned} 个过期 pending`)
  }
  return { cleaned }
}
