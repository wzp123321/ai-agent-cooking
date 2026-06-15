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
 *   POST /api/vision/chat     - 图片识别对话
 *   GET  /api/sessions        - 会话列表
 *   GET  /api/history/:id     - 获取对话历史
 *   DELETE /api/session/:id   - 清除指定会话
 *   GET  /api/profile         - 获取用户画像
 *   PUT  /api/profile         - 更新用户画像
 *
 * 技术选型：
 *   - Express：轻量 HTTP 框架，路由清晰，middleware 机制完善
 *   - CORS：允许前端跨域访问
 *   - SSE（Server-Sent Events）：服务端推送协议，比 WebSocket 更轻量
 *
 * 注意事项：
 *   - SSE 连接会占用一个 HTTP 响应流，直到 res.end() 才释放
 *   - 生产环境建议在 Nginx/网关层配置连接超时
 */

import express, { type Request, type Response } from 'express'
import cors from 'cors'
import 'dotenv/config'
import { CookingAgent } from './agent'
import { runMigrations } from './db/migrate'
import { userProfileRepo } from './db/user-profile.repository'
import { analyzeImage } from './vision'
import type { ChatRequestBody, ContinueRequestBody } from './types'

// ─── Express 应用初始化 ────────────────────────────────────

const app = express()
const PORT = Number(process.env.PORT) || 9000

console.log('═══════════════════════════════════════════════')
console.log('   🍳 厨神小助 Agent 服务启动中…')
console.log('═══════════════════════════════════════════════')

// ─── 中间件配置 ────────────────────────────────────────────

// CORS：允许所有来源的跨域请求（开发环境）
// 生产环境建议配置为具体的前端域名，如：origin: 'http://localhost:5173'
app.use(cors())
console.info('[Middleware] ✅ CORS 已启用')

// JSON 请求体解析：限制 100KB 防止大请求攻击
app.use(express.json({ limit: '20mb' }))
console.info('[Middleware] ✅ JSON 解析中间件已启用（限制 20MB）')

// 请求日志中间件
app.use((req: Request, _res: Response, next: express.NextFunction) => {
  const start = Date.now()
  const { method, url } = req

  _res.on('finish', () => {
    const duration = Date.now() - start
    const { statusCode } = _res
    const level = statusCode >= 400 ? '⚠️' : '📥'
    console.info(`[HTTP] ${level} ${method} ${url} → ${statusCode} (${duration}ms)`)
  })

  next()
})

// 简易请求限流（基于 IP，每秒最多 10 个请求）
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_MAX = 10
const RATE_LIMIT_WINDOW_MS = 1000

app.use((req: Request, res: Response, next: express.NextFunction) => {
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
})

// 定期清理限流记录（每 60 秒）
setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip)
  }
}, 60_000)
console.info('[Middleware] ✅ 请求限流已启用（每 IP 每秒最多 10 次）')

// ─── 数据库初始化 ──────────────────────────────────────────

// ─── Agent 初始化 ──────────────────────────────────────────

let agent: CookingAgent

async function start(): Promise<void> {
  await runMigrations()
  console.info('[DB] ✅ 迁移检查完成')

  try {
    agent = new CookingAgent()
    console.log('✅ 厨神小助 Agent 初始化成功')
  } catch (err) {
    console.error('❌ Agent 初始化失败：', (err as Error).message)
    console.error('💡 请检查 .env 文件中的 DEEPSEEK_API_KEY 是否正确配置')
    process.exit(1)
  }

// ─── 路由定义 ──────────────────────────────────────────────

/**
 * GET /health
 * ────────────────────────────────────────────────────────────
 * 健康检查接口。
 *
 * 用途：
 *   - 前端每 30 秒轮询一次，判断 Agent 服务是否在线
 *   - 负载均衡器/容器编排探测服务可用性
 *
 * 请求参数：无
 *
 * 返回示例：
 *   { "status": "ok", "agent": "厨神小助", "version": "1.0.0" }
 */
app.get('/health', (_req: Request, res: Response) => {
  console.debug('[Route] GET /health 被调用')
  res.json({
    status: 'ok',
    agent: '厨神小助',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  })
})

/**
 * POST /api/chat
 * ────────────────────────────────────────────────────────────
 * 普通对话接口（非流式，一次性返回完整结果）。
 *
 * 适用场景：
 *   - 简单问答（不需要打字机效果）
 *   - 客户端不支持 SSE（如某些低版本浏览器）
 *
 * 请求 Body：
 *   {
 *     "message": "string",   // 必填，用户消息
 *     "sessionId": "string"  // 选填，默认 'default'
 *   }
 *
 * 返回示例：
 *   {
 *     "success": true,
 *     "message": "这是 AI 回复的完整内容…",
 *     "sessionId": "123456_abc",
 *     "usage": { "prompt_tokens": 120, "completion_tokens": 85, "total_tokens": 205 }
 *   }
 */
app.post(
  '/api/chat',
  async (req: Request<object, object, ChatRequestBody>, res: Response) => {
    const { message, sessionId = 'default' } = req.body

    console.info(`[Route] POST /api/chat [${sessionId}] 收到请求`)

    // ── 参数校验 ──
    if (!message || typeof message !== 'string' || !message.trim()) {
      console.warn(`[Route] ⚠️  参数校验失败：message 为空或无效`)
      res.status(400).json({ error: '请提供有效的 message 字段' })
      return
    }

    try {
      // ── 调用 Agent ──
      const result = await agent.chat(message.trim(), sessionId)

      console.info(`[Route] ✅ /api/chat [${sessionId}] 返回成功`)
      res.json(result)
    } catch (err) {
      // 统一错误处理：返回 500 并附带错误信息（线上可关闭 detail）
      console.error(`[Route] ❌ /api/chat [${sessionId}] 调用出错：`, err)
      res.status(500).json({
        error: '调用 DeepSeek API 失败',
        detail: (err as Error).message,
      })
    }
  },
)

/**
 * POST /api/chat/stream
 * ────────────────────────────────────────────────────────────
 * 流式对话接口（SSE — Server-Sent Events）。
 *
 * 与 /api/chat 的区别：
 *   - 返回 Content-Type 为 text/event-stream
 *   - 响应体是多个 SSE 事件，直到最后一个事件才 res.end()
 *   - 适合长文本回复，前端可实现打字机效果
 *
 * SSE 事件格式：
 *   event: chunk
 *   data: {"content": "部分文本"}
 *
 *   event: done
 *   data: {"content": "完整文本", "sessionId": "xxx"}
 *
 *   event: error
 *   data: {"error": "错误描述"}
 */
app.post(
  '/api/chat/stream',
  async (req: Request<object, object, ChatRequestBody>, res: Response) => {
    const { message, sessionId = 'default' } = req.body

    console.info(`[Route] POST /api/chat/stream [${sessionId}] 建立 SSE 连接`)

    // ── 参数校验 ──
    if (!message || typeof message !== 'string' || !message.trim()) {
      console.warn(`[Route] ⚠️  参数校验失败：message 为空或无效`)
      res.status(400).json({ error: '请提供有效的 message 字段' })
      return
    }

    // ── 设置 SSE 响应头 ──
    // Content-Type：告知客户端这是 SSE 流，不是普通文本
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    // Cache-Control：禁止缓存，确保浏览器实时接收数据
    res.setHeader('Cache-Control', 'no-cache')
    // Connection：保持连接不断开
    res.setHeader('Connection', 'keep-alive')
    // X-Accel-Buffering：Nginx 反向代理时禁用缓冲（否则会等 SSE 结束后才返回）
    res.setHeader('X-Accel-Buffering', 'no')
    // 立即发送 HTTP 头（SSE 必须先 flush，才能开始发送 body）
    res.flushHeaders()

    console.info(`[Route] 🔗 SSE 头已发送，等待 Agent 处理…`)

    /**
     * SSE 事件发送工具函数
     *
     * event 字段：客户端通过 EventSource.addEventListener(event, handler) 监听
     * data 字段：JSON 序列化后的数据
     * \n\n：SSE 协议规定的消息分隔符
     */
    const sendEvent = (event: string, data: object): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    /**
     * 中止信号控制器 — 串联前后端的中断链路
     *
     * 场景：
     *   ① 用户在前端点击"停止生成" → AbortController.abort() → signal 置位
     *   ② 客户端 TCP 连接意外断开 → req.on('close') → abort()
     *
     * 信号沿以下路径传播：
     *   index.ts → agent.chatStream(signal) → llm.chatCompletionStream(signal)
     *   → for await (const chunk of stream) { if (signal.aborted) break }
     */
    const abortController = new AbortController()

    /**
     * finished — 正常完成标记
     *   在 onDone 回调中置为 true，防止 close 事件误触发中止
     *
     * hasStreamed — 已开始流式传输标记
     *   防止 Vite 代理在 SSE 连接建立初期的瞬时 close 事件误触发中止
     *   只有在至少一个 chunk 已发送给客户端后，close 才被视为"用户主动断开"
     *
     * writableEnded — Express 响应结束标记
     *   res.end() 后底层 socket 可能延迟关闭，此时 close 事件不应再处理
     */
    let finished = false
    let hasStreamed = false

    req.on('close', () => {
      if (!finished && !res.writableEnded && hasStreamed) {
        console.info(`[Route] 🔌 SSE [${sessionId}] 客户端断开连接（已流式 ${hasStreamed ? '是' : '否'}），触发中止`)
        abortController.abort()
      } else if (!hasStreamed) {
        console.info(`[Route] 🔌 SSE [${sessionId}] 连接建立阶段 close 事件，忽略（hasStreamed=false）`)
      } else if (finished) {
        console.info(`[Route] 🔌 SSE [${sessionId}] 正常完成后的 close 事件，忽略`)
      }
    })

    /**
     * try 块内调用 agent.chatStream()，正常的完成/中止均由内部回调处理：
     *   - onChunk → sendEvent('chunk') → 前端逐 token 显示
     *   - onDone  → sendEvent('done')  → 前端停止打字机效果
     *
     * catch 块捕获两种异常：
     *   ① Agent 内部未处理的异常（如 JSON 解析失败、持久化错误）
     *   ② LLM API 调用异常（网络超时、限流等）
     *   均通过 SSE error 事件告知前端，前端展示友好错误提示
     */
    try {
      await agent.chatStream(
        message.trim(),
        sessionId,
        (chunk) => {
          hasStreamed = true
          if (!res.writableEnded) {
            sendEvent('chunk', { content: chunk })
          }
        },
        (full) => {
          finished = true
          if (!res.writableEnded) {
            sendEvent('done', { content: full, sessionId })
            console.info(`[Route] ✅ SSE [${sessionId}] 传输完成`)
            res.end()
          }
        },
        abortController.signal,
        // 交互式工具触发：把 InteractiveRequest 序列化为 SSE 事件，
        // 前端拿到后渲染可点击按钮，等待用户选完调 /api/chat/continue。
        // 这里不调 res.end()，由 agent 内部在 paused=true 时跳出，
        // 跳到 try 块之后，外层 onDone 不会被调用，所以连接会自然挂起；
        // 为了让客户端能立即收尾，我们显式 end 一次。
        (interactiveReq) => {
          hasStreamed = true
          if (!res.writableEnded) {
            console.info(`[Route] 🙋 SSE [${sessionId}] 下发交互式请求：${interactiveReq.question}`)
            sendEvent('interactive_request', {
              interactiveId: interactiveReq.id,
              question: interactiveReq.question,
              options: interactiveReq.options,
              multiSelect: interactiveReq.multiSelect,
            })
          }
        },
      )
    } catch (err) {
      finished = true
      console.error(`[Route] ❌ SSE [${sessionId}] 出错：${(err as Error).message}`)
      if (!res.writableEnded) {
        sendEvent('error', { error: (err as Error).message })
        res.end()
      }
    }

    // 因交互式工具暂停：agent 不调 onDone，需要 route 主动结束 SSE，
    // 让前端可以正常监听 interactive_request 事件。
    if (!finished && !res.writableEnded) {
      console.info(`[Route] ⏸️  SSE [${sessionId}] 因交互式工具暂停，关闭连接`)
      res.end()
    }
  },
)

/**
 * POST /api/chat/continue
 * ────────────────────────────────────────────────────────────
 * 恢复被交互式工具暂停的 SSE 流。
 *
 * 触发场景：用户在 /api/chat/stream 的 SSE 流中收到 interactive_request 事件，
 *          在前端点击选项后调用此端点。
 *
 * 请求 Body：
 *   {
 *     "sessionId":     "xxx",
 *     "interactiveId": "tool_call_id_xxx",  // 上一轮 ask_user_choice 的 ID
 *     "choice":        ["减脂"]              // 始终是数组，单选时只有一个元素
 *   }
 *
 * 返回：与 /api/chat/stream 同样的 SSE 流（chunk / done / error / interactive_request）
 *
 * 协议设计说明：
 *   - 选择"新建 SSE 流"而非"复用旧流"：旧流已经在 interactive_request 后被关闭，
 *     浏览器侧无法通过 EventSource 直接 attach 回去；
 *     改为新开一条 SSE，行为对前端完全一致（onChunk / onDone / onInteractiveRequest 复用）。
 */
app.post(
  '/api/chat/continue',
  async (req: Request<object, object, ContinueRequestBody>, res: Response) => {
    const { sessionId = 'default', interactiveId, choice } = req.body

    console.info(`[Route] POST /api/chat/continue [${sessionId}] 恢复 interactiveId=${interactiveId}`)

    // ── 参数校验 ──
    if (!interactiveId || typeof interactiveId !== 'string') {
      res.status(400).json({ error: '请提供有效的 interactiveId' })
      return
    }
    if (!Array.isArray(choice) || choice.length === 0) {
      res.status(400).json({ error: '请提供至少一个 choice' })
      return
    }

    // ── 设置 SSE 响应头（与 /api/chat/stream 一致） ──
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    const sendEvent = (event: string, data: object): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    const abortController = new AbortController()
    let finished = false
    let hasStreamed = false

    req.on('close', () => {
      if (!finished && !res.writableEnded && hasStreamed) {
        console.info(`[Route] 🔌 continue [${sessionId}] 客户端断开，触发中止`)
        abortController.abort()
      }
    })

    try {
      await agent.resumeInteractive(
        sessionId,
        interactiveId,
        choice,
        (chunk) => {
          hasStreamed = true
          if (!res.writableEnded) {
            sendEvent('chunk', { content: chunk })
          }
        },
        (full) => {
          finished = true
          if (!res.writableEnded) {
            sendEvent('done', { content: full, sessionId, finish_reason: 'stop' })
            console.info(`[Route] ✅ continue [${sessionId}] 恢复完成`)
            res.end()
          }
        },
        (interactiveReq) => {
          hasStreamed = true
          if (!res.writableEnded) {
            console.info(`[Route] 🙋 continue [${sessionId}] 又遇到交互式工具：${interactiveReq.question}`)
            sendEvent('interactive_request', {
              interactiveId: interactiveReq.id,
              question: interactiveReq.question,
              options: interactiveReq.options,
              multiSelect: interactiveReq.multiSelect,
            })
          }
        },
        abortController.signal,
      )
    } catch (err) {
      finished = true
      console.error(`[Route] ❌ continue [${sessionId}] 失败：${(err as Error).message}`)
      if (!res.writableEnded) {
        sendEvent('error', { error: (err as Error).message })
        res.end()
      }
    }

    if (!finished && !res.writableEnded) {
      console.info(`[Route] ⏸️  continue [${sessionId}] 因再次暂停，关闭连接`)
      res.end()
    }
  },
)

/**
 * POST /api/vision/chat
 * ────────────────────────────────────────────────────────────
 * 图片识别对话接口。
 *
 * 用途：
 *   - 用户上传食材/菜品图片，AI 识别并给出做菜建议
 *   - 需要配置 VISION_API_KEY（或 OPENAI_API_KEY）才能使用
 *
 * 请求 Body：
 *   {
 *     "image": "base64编码的图片数据",
 *     "message": "可选的文字描述",
 *     "sessionId": "会话ID（可选）"
 *   }
 *
 * 返回示例：
 *   {
 *     "success": true,
 *     "content": "我看到了番茄、鸡蛋和青椒…你可以做…",
 *     "usage": { "prompt_tokens": 500, "completion_tokens": 200, "total_tokens": 700 }
 *   }
 */
app.post(
  '/api/vision/chat',
  async (req: Request, res: Response) => {
    const { image, message } = req.body

    if (!image || typeof image !== 'string') {
      res.status(400).json({ error: '请提供有效的 image 字段（base64 编码）' })
      return
    }

    console.info(`[Route] POST /api/vision/chat 收到图片请求`)

    const result = await analyzeImage({
      imageBase64: image,
      message: message?.trim() || undefined,
    })

    if (!result.success) {
      res.status(500).json({ error: result.error })
      return
    }

    console.info(`[Route] ✅ /api/vision/chat 返回成功，${result.content.length} 字符`)
    res.json(result)
  },
)

/**
 * GET /api/sessions
 * ────────────────────────────────────────────────────────────
 * 获取所有会话列表（用于前端侧边栏展示历史对话）。
 *
 * 返回示例：
 *   [{ "id": "xxx", "title": "红烧肉怎么做", "created_at": 123, "updated_at": 456 }]
 */
app.get('/api/sessions', async (_req: Request, res: Response) => {
  console.debug('[Route] GET /api/sessions')
  const sessions = await agent.listSessions()
  res.json(sessions)
})

/**
 * GET /api/history/:sessionId
 * ────────────────────────────────────────────────────────────
 * 获取指定会话的对话历史（不含 system prompt）。
 *
 * 用途：
 *   - 前端加载页面时恢复历史会话
 *   - 调试时查看服务端存储的对话内容
 */
app.get(
  '/api/history/:sessionId',
  async (req: Request<{ sessionId: string }>, res: Response) => {
    const { sessionId } = req.params

    console.info(`[Route] GET /api/history/${sessionId}`)

    const history = await agent.getHistory(sessionId)
    res.json({ sessionId, history })
  },
)

/**
 * DELETE /api/session/:sessionId
 * ────────────────────────────────────────────────────────────
 * 清除指定会话，开启新对话。
 *
 * 用途：
 *   - 用户点击"清空对话"或"新对话"按钮时调用
 *   - 服务端删除该 sessionId 的所有消息历史
 */
app.delete(
  '/api/session/:sessionId',
  async (req: Request<{ sessionId: string }>, res: Response) => {
    const { sessionId } = req.params

    console.info(`[Route] DELETE /api/session/${sessionId}`)

    await agent.clearSession(sessionId)
    res.json({ success: true, message: `会话 ${sessionId} 已清除` })
  },
)

// ─── 用户画像接口 ──────────────────────────────────────────

/**
 * GET /api/profile
 * 获取用户画像（偏好设置）。
 */
app.get('/api/profile', async (_req: Request, res: Response) => {
  console.debug('[Route] GET /api/profile')
  const profile = await userProfileRepo.getOrCreate()
  res.json(profile)
})

/**
 * PUT /api/profile
 * 更新用户画像。
 *
 * 请求 Body：
 *   {
 *     "allergies": ["花生", "海鲜"],
 *     "diet_type": "生酮",
 *     "skill_level": "beginner",
 *     "disliked": ["香菜"],
 *     "calorie_goal": 1800
 *   }
 */
app.put('/api/profile', async (req: Request, res: Response) => {
  console.info('[Route] PUT /api/profile')
  const { allergies, diet_type, skill_level, disliked, calorie_goal } = req.body

  const profile = await userProfileRepo.update('default', {
    allergies,
    diet_type,
    skill_level,
    disliked,
    calorie_goal,
  })

  res.json(profile)
})

// ─── 全局错误处理 ──────────────────────────────────────────

// Express 路由未匹配到时触发（404）
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: '接口不存在' })
})

// 统一错误中间件（Express 会将 thrown Error 传递到这里）
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: express.NextFunction) => {
  console.error('[GlobalError] 未捕获的错误：', err)
  res.status(500).json({ error: '服务器内部错误', detail: err.message })
})

// ─── 服务启动 ──────────────────────────────────────────────

  app.listen(PORT, () => {
    console.log('')
    console.log('═══════════════════════════════════════════════')
    console.log(`   🍳 厨神小助 Agent 服务已启动！`)
    console.log(`   🌐 访问地址：http://localhost:${PORT}`)
    console.log('═══════════════════════════════════════════════')
    console.log('📋 可用接口：')
    console.log(`   GET    /health               健康检查`)
    console.log(`   POST   /api/chat             普通对话`)
    console.log(`   POST   /api/chat/stream      流式对话（SSE）`)
    console.log(`   POST   /api/vision/chat      图片识别对话`)
    console.log(`   GET    /api/sessions         会话列表`)
    console.log(`   GET    /api/history/:id      获取对话历史`)
    console.log(`   DELETE /api/session/:id      清除会话`)
    console.log(`   GET    /api/profile          获取用户画像`)
    console.log(`   PUT    /api/profile          更新用户画像`)
    console.log('')
    console.info('[Server] 🚀 服务就绪，等待请求…')
  })
}

start().catch((err) => {
  console.error('❌ 服务启动失败：', (err as Error).message)
  process.exit(1)
})
