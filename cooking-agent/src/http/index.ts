/**
 * ============================================================
 * http/index.ts — HTTP 路由总装入口
 * ============================================================
 *
 * 把 chat / vision / session / profile 四个 Router 合并到 /api 命名空间下，
 * 健康检查挂载在 /health。
 *
 * 用法：
 *   import { mountRoutes } from './http'
 *   mountRoutes(app, agent)
 */

import type { Express } from 'express'
import type { CookingAgent } from '../agent'
import { chatRouter, setChatAgent } from './routes/chat'
import { visionRouter } from './routes/vision'
import { sessionRouter, setSessionAgent } from './routes/session'
import { profileRouter } from './routes/profile'

export function mountRoutes(app: Express, agent: CookingAgent): void {
  // 注入 agent 引用
  setChatAgent(agent)
  setSessionAgent(agent)

  // 业务路由统一挂载在 /api 前缀下
  app.use('/api', chatRouter)
  app.use('/api', visionRouter)
  app.use('/api', sessionRouter)
  app.use('/api', profileRouter)
}
