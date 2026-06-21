/**
 * ============================================================
 * conversation/useInteractiveSubmit.ts — 提交交互式工具选择
 * ============================================================
 *
 * 流程：
 *   1) 找到上一条 pending 的 interactive aiMsg，标记 resolved
 *   2) 追加 user 消息（"已选择: X"） + 新 aiMsg 占位
 *   3) 启动新一轮 SSE 流（continueInteractive）
 *   4) 复用 buildStreamCallbacks 统一事件
 *
 * 异常处理：
 *   - 没有 pending 的 interactive：直接 return
 *   - 网络错误由 onError 统一处理
 */

import { useChatStore } from '@/stores/chat'
import { continueInteractive } from '@/api/chat'
import { ERROR_MSG_AGENT_OFFLINE } from '@/constants'
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

export const useInteractiveSubmit = (): {
  submitInteractiveChoice: (interactiveId: string, choice: string[]) => Promise<void>
} => {
  const store = useChatStore()
  const { abort } = useStopGeneration()
  const { withReconnect } = useAutoReconnect()

  const submitInteractiveChoice = async (interactiveId: string, choice: string[]): Promise<void> => {
    const session = store.currentSession
    if (!session) {
      console.warn('[Conversation] ⚠️ 没有当前会话，忽略交互选择')
      return
    }

    const targetMsg = session.messages.find(
      (m) =>
        m.role === 'assistant' &&
        m.interactive &&
        !m.interactiveResolved &&
        m.interactive.id === interactiveId,
    )
    if (!targetMsg || !targetMsg.interactive) {
      console.warn(`[Conversation] ⚠️ 未找到 interactiveId=${interactiveId} 的待回答请求`)
      return
    }

    targetMsg.interactiveResolved = true
    targetMsg.interactiveChoice = choice

    // 按 type 决定 user 消息的展示文案，与 ResolvedView 风格保持一致
    const req = targetMsg.interactive
    const interactiveType = req.type ?? 'choice'
    const first = choice[0] ?? ''
    let choiceText: string
    switch (interactiveType) {
      case 'text':
        choiceText = first || '（空）'
        break
      case 'confirm':
        choiceText = first === '确认' ? '已确认' : first === '取消' ? '已取消' : first
        break
      case 'slider': {
        const unit = typeof req.meta?.unit === 'string' ? req.meta.unit : ''
        choiceText = unit ? `${first} ${unit}` : first
        break
      }
      case 'choice':
      default:
        choiceText = choice.join('、')
    }
    const userMsg: ChatMessage = {
      id: genId(),
      role: 'user',
      content: `已选择：${choiceText}`,
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
    const resumedMsg = session.messages[session.messages.length - 1]

    abort()
    store.loading = true
    setAbortController(new AbortController())

    startHardTimer(() => {
      if (!abortController) return
      console.warn(`[Conversation] ⏰ 交互恢复硬上限超时`)
      abortController.abort()
      setAbortController(null)
      store.loading = false
      clearInactivityTimer()
      clearStuckHintTimer()
      if (resumedMsg.streaming) {
        resumedMsg.streaming = false
        if (!resumedMsg.content) {
          resumedMsg.content = '恢复超时，请稍后重试。'
        } else {
          resumedMsg.content += '\n\n[回答超时]'
        }
      }
      setLastEvent('done')
      setCurrentAIMsg(null)
    })
    resetInactivityTimer()

    console.info(`[Conversation] ▶️ 提交交互选择 [${session.id}]：${choiceText}`)

    setCurrentAIMsg(resumedMsg)

    const callbacks = buildStreamCallbacks(resumedMsg, session, store, (finishReason) => {
      console.info(
        `[Conversation] ✅ 交互恢复完成（finish_reason=${finishReason}），共 ${resumedMsg.content.length} 字符`,
      )
    })

    const attemptContinue = async (): Promise<void> => {
      const ac = new AbortController()
      setAbortController(ac)
      await continueInteractive(
        session.id,
        interactiveId,
        choice,
        callbacks.onChunk,
        callbacks.onDone,
        callbacks.onError,
        ac.signal,
        callbacks.onInteractive,
        callbacks.onProgress,
        callbacks.onHeartbeat,
      )
    }

    try {
      await withReconnect(attemptContinue, {
        signal: abortController!.signal,
        onRetry: (attempt) => {
          console.info(`[Conversation] 🔁 交互恢复第 ${attempt} 次重连…`)
        },
      })
    } catch (err) {
      clearAllTimers()
      const e = err as Error
      if (e.name === 'AbortError') {
        console.info('[Conversation] 🛑 交互恢复已取消')
        resumedMsg.streaming = false
        store.loading = false
        setAbortController(null)
        setLastEvent('done')
        setCurrentAIMsg(null)
        return
      }
      resumedMsg.content = `❌ 未知错误：${e.message}`
      resumedMsg.streaming = false
      store.loading = false
      setAbortController(null)
      setLastEvent('done')
      setCurrentAIMsg(null)
      console.error('[Conversation] ❌ submitInteractiveChoice 未捕获的错误：', err)
    }

    if (resumedMsg.streaming && resumedMsg.content === '') {
      resumedMsg.content = ERROR_MSG_AGENT_OFFLINE
      resumedMsg.streaming = false
      store.loading = false
    }
  }

  return { submitInteractiveChoice }
}
