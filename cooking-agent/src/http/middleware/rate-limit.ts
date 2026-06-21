/**
 * ============================================================
 * http/middleware/rate-limit.ts — 简易 IP 限流
 * ============================================================
 *
 * 设计：
 *   - 基于 IP + 滑动窗口（1 秒 / 10 次）
 *   - 内存 Map 存储（适合单实例 + 调试；生产多实例应使用 Redis）
 *   - 每 60 秒清空过期 key
 *
 * 提取原因：
 *   - index.ts 里的 rate-limit 中间件 + 定时清理代码 ~30 行
 *   - 拆分到中间件目录后，index.ts 只剩注册一行
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express'

const RATE_LIMIT_MAX = 10
const RATE_LIMIT_WINDOW_MS = 1000
const CLEANUP_INTERVAL_MS = 60_000

const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

let cleanupStarted = false

function startCleanup(): void {
  if (cleanupStarted) return
  cleanupStarted = true
  setInterval(() => {
    const now = Date.now()
    for (const [ip, entry] of rateLimitMap) {
      if (now > entry.resetAt) rateLimitMap.delete(ip)
    }
  }, CLEANUP_INTERVAL_MS)
}

export const ipRateLimit: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  startCleanup()

  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown'
  const now = Date.now()
  const entry = rateLimitMap.get(ip)

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    next()
    return
  }

  entry.count++
  if (entry.count > RATE_LIMIT_MAX) {
    console.warn(`[RateLimit] ⚠️ IP ${ip} 超过限流阈值（${entry.count}/${RATE_LIMIT_WINDOW_MS}ms）`)
    res.status(429).json({ error: '请求过于频繁，请稍后再试' })
    return
  }

  next()
}
