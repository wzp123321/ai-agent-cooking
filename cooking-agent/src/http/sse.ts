/**
 * ============================================================
 * http/sse.ts — SSE（Server-Sent Events）流式响应工具
 * ============================================================
 *
 * 设计目标：
 *   - 统一管理 SSE 响应头、事件写入、连接关闭/中止跟踪
 *   - 屏蔽 Express Response 与 Agent callback 之间的样板代码
 *   - 让 /api/chat/stream 和 /api/chat/continue 共享同一套连接生命周期
 *
 * 提供能力：
 *   1. setSSEHeaders(res)            — 一次性写入 SSE 必需的响应头
 *   2. sendSSEEvent(res, ev, data)   — 写入单条 SSE 事件
 *   3. createSSEConnection(req, res) — 创建带中止跟踪的连接上下文
 *   4. runSSEAgentCall(...)          — 包装 agent 的 chatStream/resumeInteractive
 *
 * SSE 事件格式（按 SSE 协议）：
 *   event: <name>
 *   data: <json>
 *
 *   \n\n   ← 消息分隔符
 */

import type { Request, Response } from 'express'
import type { InteractiveRequest } from '../agent/interactive'
import { messageRepo } from '../db/message.repository'

// ─── 响应头 ────────────────────────────────────────────────

/**
 * 设置 SSE 必需的响应头并立即 flush。
 *
 * 关键头：
 *   - Content-Type: text/event-stream
 *   - Cache-Control: no-cache（浏览器必须实时转发）
 *   - Connection: keep-alive
 *   - X-Accel-Buffering: no（Nginx 反代禁用缓冲，否则会等流结束才返回）
 */
export function setSSEHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()
}

/**
 * 写入一条 SSE 事件。
 * 注意：res.write 失败时（客户端已断开），事件会进入 socket 内部缓冲，调用方应检查 res.writableEnded。
 */
export function sendSSEEvent(res: Response, event: string, data: object): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

// ─── 连接生命周期 ──────────────────────────────────────────

/**
 * SSEConnection — 单条 SSE 连接的状态机
 *
 * 字段：
 *   - finished   : Agent 已正常调用 onDone（防止后续 close 误触 abort）
 *   - hasStreamed: 至少有一个 chunk 已发送给客户端（防止 Vite 代理在握手阶段的瞬时 close 误触 abort）
 *   - signal     : AbortSignal，req.on('close') 时置位，传入 agent
 *
 * 调用方应：
 *   - 在 onChunk / onInteractive 回调里把 hasStreamed 置 true
 *   - 在 onDone 里把 finished 置 true
 *   - 在 SSE 写入前检查 res.writableEnded（已关闭时不写）
 */
/**
 * SSEConnection — 单条 SSE 连接的状态机
 *
 * 字段：
 *   - finished   : Agent 已正常调用 onDone（防止后续 close 误触 abort）
 *   - hasStreamed: 至少有一个 chunk 已发送给客户端（防止 Vite 代理在握手阶段的瞬时 close 误触 abort）
 *   - signal     : AbortSignal，req.on('close') 时置位，传入 agent
 *
 * 调用方应：
 *   - 在 onChunk / onInteractive 回调里把 hasStreamed 置 true
 *   - 在 onDone 里把 finished 置 true
 *   - 在 SSE 写入前检查 res.writableEnded（已关闭时不写）
 *
 * P1-②：增加心跳保活
 *   - SSE 默认连接可能被代理（Vite / Nginx / 防火墙）在 30-60s 无数据时静默断开
 *   - 通过 setInterval 每 15s 发一条 SSE 注释（`:heartbeat\n\n`）
 *   - 注释行浏览器会忽略，但能"喂"给中间链路的 keep-alive 探针
 *   - 连接关闭时（finished / writableEnded）自动 clearInterval
 */
export interface SSEConnection {
  signal: AbortSignal
  markStreamed(): void
  markFinished(): void
  isAlive(): boolean
}

/** P1-②：心跳间隔（毫秒）。生产经验值 15-30s；过短浪费带宽，过长易被中间链路切断 */
const HEARTBEAT_INTERVAL_MS = 15_000

export function createSSEConnection(req: Request, res: Response, logTag: string): SSEConnection {
  const abortController = new AbortController()
  let finished = false
  let hasStreamed = false

  req.on('close', () => {
    if (!finished && !res.writableEnded && hasStreamed) {
      console.info(`[SSE] 🔌 ${logTag} 客户端断开，触发中止`)
      abortController.abort()
    } else if (!hasStreamed) {
      console.info(`[SSE] 🔌 ${logTag} 握手阶段 close 事件，忽略`)
    } else if (finished) {
      console.info(`[SSE] 🔌 ${logTag} 正常完成后的 close 事件，忽略`)
    }
  })

  // P1-②：心跳定时器。
  // 注意：SSE 注释行（以 `:` 开头）浏览器 EventSource 会忽略，但 socket 层的 TCP
  // 探针能识别到流量。这与 nginx / proxy / 防火墙的 keep-alive 配合使用。
  const heartbeatTimer = setInterval(() => {
    if (finished || res.writableEnded) {
      clearInterval(heartbeatTimer)
      return
    }
    try {
      res.write(':heartbeat\n\n')
    } catch (err) {
      console.warn(`[SSE] 💔 ${logTag} 心跳写入失败，停止心跳：`, (err as Error).message)
      clearInterval(heartbeatTimer)
    }
  }, HEARTBEAT_INTERVAL_MS)

  return {
    signal: abortController.signal,
    markStreamed: () => {
      hasStreamed = true
    },
    markFinished: () => {
      finished = true
      // 正常完成时立即停止心跳（避免在 res.end() 后再尝试写）
      clearInterval(heartbeatTimer)
    },
    isAlive: () => !res.writableEnded,
  }
}

// ─── 交互式工具计数（用于"续点 UX 优化"）──────────────────

/**
 * 计算当前会话已经历的"交互式轮次"数，下发 round=N 用于前端 UI 提示。
 *
 * isReinteractive:
 *   - false：来自 /api/chat/stream（首次交互）
 *   - true ：来自 /api/chat/continue（恢复后的再交互）
 */
export async function buildInteractiveEventPayload(
  sessionId: string,
  req: InteractiveRequest,
  isReinteractive: boolean,
): Promise<Record<string, unknown>> {
  const prevCount = await messageRepo.countInteractiveToolCalls(sessionId)
  const round = prevCount + 1
  console.info(
    `[SSE] 🙋 ${isReinteractive ? 're' : ''}interactive_request [${sessionId}] ` +
      `round=${round} type=${req.type} q=${req.question}`,
  )
  return {
    interactiveId: req.id,
    question: req.question,
    options: req.options,
    multiSelect: req.multiSelect,
    category: req.category,
    type: req.type,
    meta: req.meta,
    optionImages: req.optionImages,
    validation: req.validation,
    isReinteractive,
    round,
  }
}
