/**
 * ============================================================
 * http/routes/session.ts — 会话管理
 * ============================================================
 *
 * GET    /api/sessions         - 会话列表
 * GET    /api/history/:id      - 对话历史
 * DELETE /api/session/:id      - 清除会话
 *
 * agent 引用由 setSessionAgent 注入（index.ts）
 */

import { Router, type Request, type Response } from 'express'
import type { CookingAgent } from '../../agent'

let agent: CookingAgent

export function setSessionAgent(a: CookingAgent): void {
  agent = a
}

export const sessionRouter: Router = Router()

sessionRouter.get('/sessions', async (_req: Request, res: Response) => {
  console.debug('[Route] GET /api/sessions')
  const sessions = await agent.listSessions()
  res.json(sessions)
})

sessionRouter.get(
  '/history/:sessionId',
  async (req: Request<{ sessionId: string }>, res: Response) => {
    const { sessionId } = req.params
    console.info(`[Route] GET /api/history/${sessionId}`)

    const history = await agent.getHistory(sessionId)
    res.json({ sessionId, history })
  },
)

sessionRouter.delete(
  '/session/:sessionId',
  async (req: Request<{ sessionId: string }>, res: Response) => {
    const { sessionId } = req.params
    console.info(`[Route] DELETE /api/session/${sessionId}`)

    await agent.clearSession(sessionId)
    res.json({ success: true, message: `会话 ${sessionId} 已清除` })
  },
)
