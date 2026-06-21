/**
 * ============================================================
 * http/routes/vision.ts — 图片识别对话
 * ============================================================
 *
 * POST /api/vision/chat
 *   - body: { image: base64, message?: string }
 *   - 返回 { success, content, usage? }
 */

import { Router, type Request, type Response } from 'express'
import { analyzeImage } from '../../vision'
import { wrap, badRequest } from '../error-handler'

export const visionRouter: Router = Router()

visionRouter.post(
  '/vision/chat',
  wrap(
    async (req: Request, res: Response) => {
      const { image, message } = req.body

      if (!image || typeof image !== 'string') {
        const r = badRequest('请提供有效的 image 字段（base64 编码）')
        res.status(r.status).json(r.body)
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
    { route: 'POST /api/vision/chat' },
  ),
)
