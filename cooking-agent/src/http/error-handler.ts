/**
 * ============================================================
 * http/error-handler.ts — 路由错误处理工具
 * ============================================================
 *
 * 设计目标：
 *   - 消除各路由的 try-catch 样板代码
 *   - 统一日志格式：路由名 + sessionId + 错误信息
 *   - 统一 HTTP 响应：500 + { error, detail? }
 *
 * 用法：
 *   router.post('/x', wrap(async (req, res) => {
 *     const data = await service.x()
 *     res.json(data)
 *   }, { route: 'POST /x' }))
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express'

export interface WrapOptions {
  /** 路由标识，写入日志 */
  route: string
  /** 自定义错误映射：把业务错误转成 HTTP status */
  mapError?: (err: Error) => { status: number; body: Record<string, unknown> }
}

/**
 * 包装一个 async 路由处理器，自动捕获 throw 并转成 500 响应。
 *
 * 关键点：
 *   - 不包装的话，async throw 不会自动 catch（Express 4 行为）
 *
 * 类型：内部用 `Request<any>` 抹平泛型差异（调用方已用 Request<P, _, Body> 约束过）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function wrap(
  handler: (req: Request<any, any, any, any>, res: Response, next: NextFunction) => Promise<unknown> | unknown,
  options: WrapOptions,
): RequestHandler {
  return async (req, res, next) => {
    try {
      await handler(req, res, next)
    } catch (err) {
      const e = err as Error
      if (options.mapError) {
        const mapped = options.mapError(e)
        console.error(`[${options.route}] ❌ ${e.message}`)
        res.status(mapped.status).json(mapped.body)
        return
      }
      console.error(`[${options.route}] ❌ ${e.message}`)
      res.status(500).json({ error: '服务器内部错误', detail: e.message })
    }
  }
}

/**
 * 参数校验失败时使用的 400 响应构造器。
 */
export function badRequest(message: string): { status: number; body: Record<string, unknown> } {
  return { status: 400, body: { error: message } }
}
