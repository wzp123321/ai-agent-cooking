/**
 * ============================================================
 * conversation/useStreamTimers.ts — 双计时器 + 卡住检测
 * ============================================================
 *
 * 三个计时器的职责：
 *   - hardTimer        ：从 sendMessage 开始计，到 STREAM_HARD_TIMEOUT_MS 必杀
 *   - inactivityTimer  ：每次事件（chunk / tool / interactive）重置
 *   - stuckHintTimer   ：静默 + 上次事件是 tool_calls 时启动，到点只显示提示不杀流
 *
 * 详见 interactive-dialogue-deep-dive.md §10
 */

import { useChatStore } from '@/stores/chat'
import {
  STREAM_HARD_TIMEOUT_MS,
  STREAM_INACTIVITY_MS,
  STREAM_INACTIVITY_MESSAGE,
  STUCK_AFTER_TOOL_HINT_MS,
} from '@/constants'
import {
  abortController,
  setAbortController,
  hardTimer,
  setHardTimer,
  inactivityTimer,
  setInactivityTimer,
  stuckHintTimer,
  setStuckHintTimer,
  lastEvent,
  setLastEvent,
  currentAIMsg,
  setCurrentAIMsg,
} from './_state'

// ═══ 清除单个计时器 ═══

export const clearHardTimer = (): void => {
  if (hardTimer !== null) {
    clearTimeout(hardTimer)
    setHardTimer(null)
  }
}

export const clearInactivityTimer = (): void => {
  if (inactivityTimer !== null) {
    clearTimeout(inactivityTimer)
    setInactivityTimer(null)
  }
}

export const clearStuckHintTimer = (): void => {
  if (stuckHintTimer !== null) {
    clearTimeout(stuckHintTimer)
    setStuckHintTimer(null)
  }
}

export const clearAllTimers = (): void => {
  clearHardTimer()
  clearInactivityTimer()
  clearStuckHintTimer()
}

// ═══ 重置计时器 ═══

/**
 * 重置静默计时器（每次新事件到达时调用）
 *
 * 关键：必须先 clearTimeout 再 setTimeout，否则会出现"多个 timer 并存"的 bug。
 */
export const resetInactivityTimer = (): void => {
  clearInactivityTimer()
  setInactivityTimer(
    setTimeout(() => {
      if (!abortController) return
      console.warn(`[Conversation] ⏰ 静默超时（${STREAM_INACTIVITY_MS}ms 无事件），中止流式请求`)
      abortController.abort()
      setAbortController(null)
      const store = useChatStore()
      store.loading = false
      if (currentAIMsg && currentAIMsg.streaming) {
        currentAIMsg.streaming = false
        currentAIMsg.content = currentAIMsg.content
          ? `${currentAIMsg.content}\n\n[${STREAM_INACTIVITY_MESSAGE.replace(/[。.]$/, '')}]`
          : STREAM_INACTIVITY_MESSAGE
      }
    }, STREAM_INACTIVITY_MS),
  )
}

/**
 * 重置"卡住提示"计时器。
 * 仅在 lastEvent === 'tool' 时启动，其他场景清除。
 * 触发时只追加"AI 卡住了"提示文本，**不**中止流（让 hardTimer / inactivityTimer 决定生死）。
 */
export const resetStuckHintTimer = (): void => {
  clearStuckHintTimer()
  if (lastEvent !== 'tool') return
  setStuckHintTimer(
    setTimeout(() => {
      if (!currentAIMsg || !currentAIMsg.streaming) return
      if (currentAIMsg.content.includes('[对话可能卡住]')) return
      console.warn(`[Conversation] ⏳ 流静默 + 上次事件是 tool_calls，显示卡住提示`)
      currentAIMsg.content = currentAIMsg.content
        ? `${currentAIMsg.content}\n\n[对话可能卡住，可点击停止]`
        : '[对话可能卡住，可点击停止]'
    }, STUCK_AFTER_TOOL_HINT_MS),
  )
}

/**
 * 启动硬上限计时器（流开始时调用一次）
 *
 * @param onExpire - 到点时执行的回调（由调用方传入，处理各自的"超时"逻辑）
 */
export const startHardTimer = (onExpire: () => void): void => {
  clearHardTimer()
  setLastEvent('start')
  setHardTimer(
    setTimeout(() => {
      onExpire()
    }, STREAM_HARD_TIMEOUT_MS),
  )
}

export { lastEvent, setLastEvent, currentAIMsg, setCurrentAIMsg }
