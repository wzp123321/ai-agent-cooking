/**
 * ============================================================
 * conversation/useSendVisionMessage.ts — 发送图片识别请求
 * ============================================================
 *
 * 简化流程（非流式，单次 fetch）：
 *   1) 校验 loading
 *   2) 推入 user 消息（带 data URL）+ aiMsg 占位
 *   3) 调用 sendVisionChat() 单次返回
 *   4) 失败时显示提示
 */

import { ElMessage } from 'element-plus'
import { useChatStore } from '@/stores/chat'
import { sendVisionChat } from '@/api/chat'
import { MAX_SESSION_TITLE_LENGTH } from '@/constants'
import type { ChatMessage } from '@/types'
import { useStopGeneration } from './useStopGeneration'

const genId = (): string => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

export const useSendVisionMessage = (): {
  sendVisionMessage: (imageBase64: string, text?: string) => Promise<void>
} => {
  const store = useChatStore()
  const { abort } = useStopGeneration()

  const sendVisionMessage = async (imageBase64: string, text?: string): Promise<void> => {
    if (store.loading) {
      console.warn('[Conversation] ⚠️ 正在发送中，忽略重复请求')
      return
    }

    abort()

    store.loading = true
    const session = store.currentSession

    const contentText = text || '帮我看看这些食材可以做什么菜？'
    console.info(`[Conversation] 📷 发送图片消息 [${session.id}]`)

    if (session.messages.length === 0) {
      session.title =
        contentText.slice(0, MAX_SESSION_TITLE_LENGTH) +
        (contentText.length > MAX_SESSION_TITLE_LENGTH ? '…' : '')
    }

    const userMsg: ChatMessage = {
      id: genId(),
      role: 'user',
      content: text || '📷 拍照识别食材',
      timestamp: Date.now(),
      image: `data:image/jpeg;base64,${imageBase64}`,
    }
    session.messages.push(userMsg)
    session.updatedAt = Date.now()

    session.messages.push({
      id: genId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      streaming: true,
    })
    const aiMsg = session.messages[session.messages.length - 1]

    try {
      const result = await sendVisionChat(imageBase64, text)

      aiMsg.content = result.content
      aiMsg.streaming = false
      session.updatedAt = Date.now()
      store.loading = false
      console.info(`[Conversation] ✅ 图片识别完成，共 ${aiMsg.content.length} 字符`)
    } catch (err) {
      aiMsg.content = `❌ 图片识别失败：${(err as Error).message}`
      aiMsg.streaming = false
      store.loading = false
      ElMessage.error('图片识别失败，请检查 Vision API 配置')
      console.error('[Conversation] ❌ 图片识别失败：', err)
    }
  }

  return { sendVisionMessage }
}
