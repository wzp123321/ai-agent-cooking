/**
 * ============================================================
 * http/routes/chat.ts — 对话相关路由
 * ============================================================
 *
 * 接口：
 *   POST /api/chat                    - 普通对话
 *   POST /api/chat/stream             - 流式对话 (SSE)
 *   POST /api/chat/continue           - 恢复被交互式工具暂停的流
 *   POST /api/chat/cancel-interactive - 主动取消待回答的交互
 *   POST /api/chat/undo-interactive   - 撤销最近一次已回答的交互
 *
 * 设计：
 *   - 路由 + Agent 调用绑定在一个 Router 内
 *   - 共享 agent 引用（由 index.ts 通过 setChatAgent 注入）
 *   - SSE 路由的样板代码（headers、连接生命周期、错误事件）抽到 http/sse.ts
 */

import { Router, type Request, type Response } from 'express'
import type { CookingAgent } from '../../agent'
import { wrap, badRequest } from '../error-handler'
import {
  setSSEHeaders,
  sendSSEEvent,
  createSSEConnection,
  buildInteractiveEventPayload,
} from '../sse'
import type { ChatRequestBody, ContinueRequestBody, CancelInteractiveRequestBody, UndoInteractiveRequestBody } from '../../types'

// 共享 agent 引用（index.ts 注入）
let agent: CookingAgent

export function setChatAgent(a: CookingAgent): void {
  agent = a
}

export const chatRouter: Router = Router()

// ─── POST /api/chat ──────────────────────────────────────

chatRouter.post(
  '/chat',
  wrap(
    async (req: Request<Record<string, never>, unknown, ChatRequestBody>, res: Response) => {
      const { message, sessionId = 'default' } = req.body

      if (!message || typeof message !== 'string' || !message.trim()) {
        const r = badRequest('请提供有效的 message 字段')
        res.status(r.status).json(r.body)
        return
      }

      console.info(`[Route] POST /api/chat [${sessionId}] 收到请求`)

      const result = await agent.chat(message.trim(), sessionId)

      console.info(`[Route] ✅ /api/chat [${sessionId}] 返回成功`)
      res.json(result)
    },
    { route: 'POST /api/chat' },
  ),
)

// ─── POST /api/chat/stream ──────────────────────────────

chatRouter.post(
  '/chat/stream',
  async (req: Request<Record<string, never>, unknown, ChatRequestBody>, res: Response) => {
    const { message, sessionId = 'default' } = req.body

    console.info(`[Route] POST /api/chat/stream [${sessionId}] 建立 SSE 连接`)

    if (!message || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: '请提供有效的 message 字段' })
      return
    }

    setSSEHeaders(res)
    console.info(`[Route] 🔗 SSE 头已发送，等待 Agent 处理…`)

    const conn = createSSEConnection(req, res, `chat/stream [${sessionId}]`)

    try {
      await agent.chatStream(
        message.trim(),
        sessionId,
        (chunk) => {
          conn.markStreamed()
          if (conn.isAlive()) {
            sendSSEEvent(res, 'chunk', { content: chunk })
          }
        },
        (full) => {
          conn.markFinished()
          if (conn.isAlive()) {
            sendSSEEvent(res, 'done', { content: full, sessionId })
            console.info(`[Route] ✅ SSE [${sessionId}] 传输完成`)
            res.end()
          }
        },
        conn.signal,
        (interactiveReq) => {
          conn.markStreamed()
          if (!conn.isAlive()) return
          void (async () => {
            const payload = await buildInteractiveEventPayload(sessionId, interactiveReq, false)
            if (conn.isAlive()) {
              sendSSEEvent(res, 'interactive_request', payload)
            }
          })()
        },
        // P1-①：ReAct 阶段进度事件 → 转发为 SSE `progress` 事件
        (event) => {
          if (conn.isAlive()) {
            sendSSEEvent(res, 'progress', event)
          }
        },
      )
    } catch (err) {
      conn.markFinished()
      console.error(`[Route] ❌ SSE [${sessionId}] 出错：${(err as Error).message}`)
      if (conn.isAlive()) {
        sendSSEEvent(res, 'error', { error: (err as Error).message })
        res.end()
      }
    }

    // 交互式工具暂停：agent 不调 onDone，需要 route 主动 end
    if (conn.isAlive()) {
      console.info(`[Route] ⏸️  SSE [${sessionId}] 因交互式工具暂停，关闭连接`)
      res.end()
    }
  },
)

// ─── POST /api/chat/continue ─────────────────────────────

chatRouter.post(
  '/chat/continue',
  async (req: Request<Record<string, never>, unknown, ContinueRequestBody>, res: Response) => {
    const { sessionId = 'default', interactiveId, choice } = req.body

    console.info(`[Route] POST /api/chat/continue [${sessionId}] 恢复 interactiveId=${interactiveId}`)

    if (!interactiveId || typeof interactiveId !== 'string') {
      res.status(400).json({ error: '请提供有效的 interactiveId' })
      return
    }
    if (!Array.isArray(choice) || choice.length === 0) {
      res.status(400).json({ error: '请提供至少一个 choice' })
      return
    }

    setSSEHeaders(res)

    const conn = createSSEConnection(req, res, `chat/continue [${sessionId}]`)

    try {
      await agent.resumeInteractive(
        sessionId,
        interactiveId,
        choice,
        (chunk) => {
          conn.markStreamed()
          if (conn.isAlive()) {
            sendSSEEvent(res, 'chunk', { content: chunk })
          }
        },
        (full) => {
          conn.markFinished()
          if (conn.isAlive()) {
            sendSSEEvent(res, 'done', { content: full, sessionId, finish_reason: 'stop' })
            console.info(`[Route] ✅ continue [${sessionId}] 恢复完成`)
            res.end()
          }
        },
        (interactiveReq) => {
          conn.markStreamed()
          if (!conn.isAlive()) return
          void (async () => {
            const payload = await buildInteractiveEventPayload(sessionId, interactiveReq, true)
            if (conn.isAlive()) {
              sendSSEEvent(res, 'interactive_request', payload)
            }
          })()
        },
        conn.signal,
        // P1-①：continue 阶段也下发 progress 事件
        (event) => {
          if (conn.isAlive()) {
            sendSSEEvent(res, 'progress', event)
          }
        },
      )
    } catch (err) {
      conn.markFinished()
      console.error(`[Route] ❌ continue [${sessionId}] 失败：${(err as Error).message}`)
      if (conn.isAlive()) {
        sendSSEEvent(res, 'error', { error: (err as Error).message })
        res.end()
      }
    }

    if (conn.isAlive()) {
      console.info(`[Route] ⏸️  continue [${sessionId}] 因再次暂停，关闭连接`)
      res.end()
    }
  },
)

// ─── POST /api/chat/cancel-interactive ───────────────────

chatRouter.post(
  '/chat/cancel-interactive',
  wrap(
    async (req: Request<Record<string, never>, unknown, CancelInteractiveRequestBody>, res: Response) => {
      const { sessionId = 'default', interactiveId } = req.body

      console.info(`[Route] POST /api/chat/cancel-interactive [${sessionId}] interactiveId=${interactiveId}`)

      if (!interactiveId || typeof interactiveId !== 'string') {
        const r = badRequest('请提供有效的 interactiveId')
        res.status(r.status).json(r.body)
        return
      }

      const result = await agent.cancelInteractive(sessionId, interactiveId)
      res.status(200).json({ ...result, sessionId })
    },
    { route: 'POST /api/chat/cancel-interactive' },
  ),
)

// ─── POST /api/chat/undo-interactive ─────────────────────

chatRouter.post(
  '/chat/undo-interactive',
  wrap(
    async (req: Request<Record<string, never>, unknown, UndoInteractiveRequestBody>, res: Response) => {
      const { sessionId = 'default' } = req.body

      console.info(`[Route] POST /api/chat/undo-interactive [${sessionId}]`)

      const result = await agent.undoLastInteractive(sessionId)
      res.status(200).json({ ...result, sessionId })
    },
    { route: 'POST /api/chat/undo-interactive' },
  ),
)
