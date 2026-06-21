/**
 * ============================================================
 * conversation/useSendMessage.ts — 发送文本消息
 * ============================================================
 *
 * 流程：
 *   1) 校验：非空 + 未在 loading
 *   2) 清理前序状态（abort）
 *   3) 推入 user 消息 + aiMsg 占位
 *   4) 启动硬上限计时器 + 静默计时器
 *   5) 调用 sendChatStream()，复用 buildStreamCallbacks 统一事件
 *   6) catch 中兜底（AbortError 吞掉，其他错误显示）
 *
 * 会话标题策略：
 *   - 首条消息前 30 字作为标题
 *   - 超出截断加 "…"
 */

import { ElMessage } from 'element-plus'
import { useChatStore } from '@/stores/chat'
import { sendChatStream } from '@/api/chat'
import { MAX_SESSION_TITLE_LENGTH, ERROR_MSG_AGENT_OFFLINE } from '@/constants'
import type { ChatMessage } from '@/types'
import {
  abortController,
  setAbortController,
  setCurrentAIMsg,
} from './_state'
import {
  startHardTimer,
  resetInactivityTimer,
  clearInactivityTimer,
  clearStuckHintTimer,
  clearAllTimers,
  setLastEvent,
} from './useStreamTimers'
import { buildStreamCallbacks } from './useStreamEvents'
import { useStopGeneration } from './useStopGeneration'
import { useAutoReconnect } from './useAutoReconnect'

const genId = (): string => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

export const useSendMessage = (): {
  sendMessage: (content: string) => Promise<void>
  isReconnecting: ReturnType<typeof useAutoReconnect>['isReconnecting']
  retryCount: ReturnType<typeof useAutoReconnect>['retryCount']
} => {
  const store = useChatStore()
  const { abort } = useStopGeneration()
  const { withReconnect, isReconnecting, retryCount } = useAutoReconnect()

  const sendMessage = async (content: string): Promise<void> => {
    if (store.loading) {
      console.warn('[Conversation] ⚠️ 正在发送中，忽略重复请求')
      return
    }
    if (!content.trim()) {
      console.warn('[Conversation] ⚠️ 收到空消息，忽略')
      return
    }

    abort()

    store.loading = true
    const session = store.currentSession

    console.info(`[Conversation] 📤 发送消息 [${session.id}]：${content.slice(0, 50)}…`)

    if (session.messages.length === 0) {
      session.title =
        content.slice(0, MAX_SESSION_TITLE_LENGTH) +
        (content.length > MAX_SESSION_TITLE_LENGTH ? '…' : '')
      console.info(`[Conversation] 📝 会话标题更新为：${session.title}`)
    }

    const userMsg: ChatMessage = {
      id: genId(),
      role: 'user',
      content,
      timestamp: Date.now(),
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
    setCurrentAIMsg(aiMsg)
    console.info('[Conversation] ⏳ AI 消息已追加，等待流式响应…')

    setAbortController(new AbortController())

    // 启动硬上限计时器（to点时执行清理）
    startHardTimer(() => {
      if (!abortController) return
      console.warn(`[Conversation] ⏰ 硬上限超时`)
      abortController.abort()
      setAbortController(null)
      store.loading = false
      clearInactivityTimer()
      clearStuckHintTimer()
      if (aiMsg.streaming) {
        aiMsg.streaming = false
        if (!aiMsg.content) {
          aiMsg.content = '回答超时，请稍后重试。'
        } else {
          aiMsg.content += '\n\n[回答超时]'
        }
      }
      setLastEvent('done')
      setCurrentAIMsg(null)
    })

    // 启动静默计时器（每次新事件会被重置）
    resetInactivityTimer()

    const callbacks = buildStreamCallbacks(aiMsg, session, store, (finishReason) => {
      console.info(
        `[Conversation] ✅ AI 回复完成（finish_reason=${finishReason}），共 ${aiMsg.content.length} 字符`,
      )
    })

    // P1-③：用 useAutoReconnect 包裹 sendChatStream
    //   - 每次重试都新建一个 AbortController（旧的已 abort）
    //   - 重试期间 aiMsg 文本/streaming 标志都保留（不重置）
    //   - 用户点停止 → signal 触发，withReconnect 内部 sleep 会拒绝等待
    const attemptStream = async (): Promise<void> => {
      // 每次重连前确保 controller 是新的（旧的已被 server 因断开而 abort）
      const ac = new AbortController()
      setAbortController(ac)
      try {
        await sendChatStream(
          content,
          session.id,
          callbacks.onChunk,
          callbacks.onDone,
          callbacks.onError,
          ac.signal,
          callbacks.onToolCallDelta,
          callbacks.onToolCalls,
          callbacks.onInteractive,
          callbacks.onProgress,
          callbacks.onHeartbeat,
        )
      } catch (err) {
        // onError 已被 SSE 消费器内部调用过，不再在这里覆盖 aiMsg；
        // 真正的兜底由外层 catch + ERROR_MSG_AGENT_OFFLINE 负责。
        // 这里 rethrow 让 withReconnect 决定是否重试。
        throw err
      }
    }

    try {
      await withReconnect(attemptStream, {
        signal: abortController!.signal,
        onRetry: (attempt, delayMs) => {
          console.info(`[Conversation] 🔁 第 ${attempt} 次重连将在 ${delayMs}ms 后进行…`)
          // UI 提示（不重置 aiMsg 文本）
          ElMessage.warning({
            message: `连接中断，正在重试 (${attempt}/3)…`,
            duration: delayMs,
          })
        },
      })
    } catch (err) {
      clearAllTimers()
      const e = err as Error
      if (e.name === 'AbortError') {
        console.info('[Conversation] 🛑 请求已被取消')
        aiMsg.streaming = false
        store.loading = false
        setAbortController(null)
        setLastEvent('done')
        setCurrentAIMsg(null)
        return
      }
      // 重连 3 次仍失败：兜底错误显示
      aiMsg.content = aiMsg.content
        ? aiMsg.content + `\n\n[连接失败：${e.message}]`
        : `❌ 未知错误：${e.message}`
      aiMsg.streaming = false
      store.loading = false
      setAbortController(null)
      setLastEvent('done')
      setCurrentAIMsg(null)
      console.error('[Conversation] ❌ sendMessage 未捕获的错误：', err)
    }

    // 用 ERROR_MSG_AGENT_OFFLINE 处理 onError 抛出的非 AbortError
    if (aiMsg.streaming && aiMsg.content === '') {
      aiMsg.content = ERROR_MSG_AGENT_OFFLINE
      aiMsg.streaming = false
      store.loading = false
      ElMessage.error('Agent 服务请求失败，请检查后端是否已启动')
    }
  }

  return { sendMessage, isReconnecting, retryCount }
}
