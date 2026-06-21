/**
 * ============================================================
 * cooking-agent 入口文件 — Express HTTP 服务
 * ============================================================
 *
 * 功能概述：
 *   提供 HTTP REST API，供前端应用调用做菜智能体。
 *
 * 接口清单：
 *   GET  /health              - 健康检查（前端轮询判断 Agent 是否在线）
 *   POST /api/chat            - 普通对话（完整返回）
 *   POST /api/chat/stream     - 流式对话（SSE）
 *   POST /api/chat/continue   - 恢复被交互式工具暂停的流
 *   POST /api/chat/cancel-interactive - 主动取消待回答的交互
 *   POST /api/chat/undo-interactive   - 撤销最近一次已回答的交互
 *   POST /api/vision/chat     - 图片识别对话
 *   GET  /api/sessions        - 会话列表
 *   GET  /api/history/:id     - 获取对话历史
 *   DELETE /api/session/:id   - 清除指定会话
 *   GET  /api/profile         - 获取用户画像
 *   PUT  /api/profile         - 更新用户画像
 *
 * P-重构：所有路由已拆分到 http/routes/{chat,vision,session,profile}.ts，
 *         SSE 工具在 http/sse.ts，错误处理在 http/error-handler.ts。
 *         本文件只负责：中间件装配 + 数据库/Agent 初始化 + 启动服务。
 */

import express, { type Request, type Response } from 'express'
import cors from 'cors'
import 'dotenv/config'
import { CookingAgent } from './agent'
import { runMigrations } from './db/migrate'
import { mountRoutes } from './http'
import { ipRateLimit } from './http/middleware/rate-limit'
import { startInteractiveTimeoutWatcher } from './agent/timeout-watcher'

// ─── Express 应用初始化 ────────────────────────────────────

const app = express()
const PORT = Number(process.env.PORT) || 9000

console.log('═══════════════════════════════════════════════')
console.log('   🍳 厨神小助 Agent 服务启动中…')
console.log('═══════════════════════════════════════════════')

// ─── 中间件配置 ────────────────────────────────────────────

app.use(cors())
console.info('[Middleware] ✅ CORS 已启用')

app.use(express.json({ limit: '20mb' }))
console.info('[Middleware] ✅ JSON 解析中间件已启用（限制 20MB）')

// 请求日志
app.use((req: Request, res: Response, next: express.NextFunction) => {
  const start = Date.now()
  const { method, url } = req
  res.on('finish', () => {
    const duration = Date.now() - start
    const { statusCode } = res
    const level = statusCode >= 400 ? '⚠️' : '📥'
    console.info(`[HTTP] ${level} ${method} ${url} → ${statusCode} (${duration}ms)`)
  })
  next()
})

app.use(ipRateLimit)
console.info('[Middleware] ✅ 请求限流已启用（每 IP 每秒最多 10 次）')

// ─── 健康检查 ──────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    agent: '厨神小助',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  })
})

// ─── 全局错误处理（仅兜底异常，404 在 start() 末尾注册）──

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: express.NextFunction) => {
  console.error('[GlobalError] 未捕获的错误：', err)
  res.status(500).json({ error: '服务器内部错误', detail: err.message })
})

// ─── 服务启动 ──────────────────────────────────────────────

async function start(): Promise<void> {
  await runMigrations()
  console.info('[DB] ✅ 迁移检查完成')

  let agent: CookingAgent
  try {
    agent = new CookingAgent()
    console.log('✅ 厨神小助 Agent 初始化成功')

    startInteractiveTimeoutWatcher()
  } catch (err) {
    console.error('❌ Agent 初始化失败：', (err as Error).message)
    console.error('💡 请检查 .env 文件中的 DEEPSEEK_API_KEY 是否正确配置')
    process.exit(1)
  }

  // 挂载所有业务路由
  mountRoutes(app, agent)

  // 404 兜底 —— 必须放在所有路由之后，否则会先吃掉 /api/* 请求
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: '接口不存在' })
  })

  app.listen(PORT, () => {
    console.log('')
    console.log('═══════════════════════════════════════════════')
    console.log(`   🍳 厨神小助 Agent 服务已启动！`)
    console.log(`   🌐 访问地址：http://localhost:${PORT}`)
    console.log('═══════════════════════════════════════════════')
    console.log('📋 可用接口：')
    console.log(`   GET    /health                  健康检查`)
    console.log(`   POST   /api/chat                普通对话`)
    console.log(`   POST   /api/chat/stream         流式对话（SSE）`)
    console.log(`   POST   /api/chat/continue       恢复交互式流`)
    console.log(`   POST   /api/chat/cancel-interactive  取消待回答交互`)
    console.log(`   POST   /api/chat/undo-interactive    撤销最近交互`)
    console.log(`   POST   /api/vision/chat         图片识别对话`)
    console.log(`   GET    /api/sessions            会话列表`)
    console.log(`   GET    /api/history/:id         获取对话历史`)
    console.log(`   DELETE /api/session/:id         清除会话`)
    console.log(`   GET    /api/profile             获取用户画像`)
    console.log(`   PUT    /api/profile             更新用户画像`)
    console.log('')
    console.info('[Server] 🚀 服务就绪，等待请求…')
  })
}

start().catch((err) => {
  console.error('❌ 服务启动失败：', (err as Error).message)
  process.exit(1)
})
