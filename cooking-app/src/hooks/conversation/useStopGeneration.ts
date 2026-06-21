/**
 * ============================================================
 * conversation/useStopGeneration.ts — 中止/停止生成
 * ============================================================
 *
 * 提供两个操作：
 *   - abort()     ：底层清理，释放资源（计时器 + controller + currentAIMsg）
 *   - stopGeneration()：用户主动点击"停止"按钮
 *
 * 区别：
 *   - abort()     不修改任何 store 状态（由调用方按需更新）
 *   - stopGeneration() 会显式更新最后一条 aiMsg 的内容为 "[已中止]"
 */

import { useChatStore } from '@/stores/chat'
import {
  abortController,
  setAbortController,
  setLastEvent,
  setCurrentAIMsg,
} from './_state'
import { clearAllTimers } from './useStreamTimers'

export const useStopGeneration = (): {
  abort: () => void
  stopGeneration: () => void
} => {
  const store = useChatStore()

  /**
   * 底层清理：清空所有计时器、controller、currentAIMsg。
   * 不动 store 状态，调用方按需决定如何更新 UI。
   */
  const abort = (): void => {
    clearAllTimers()
    if (abortController) {
      abortController.abort()
      setAbortController(null)
    }
    setCurrentAIMsg(null)
  }

  /**
   * 用户主动停止生成。
   *
   * 调用 abort() 触发的链路：
   *   1. fetch() 收到 AbortError → catch 中调用 onError
   *   2. sendChatStream 的 catch 中调用外层 catch 的 onError
   *   3. 本方 sendMessage 的 catch(err) 捕获 → 清理状态
   *
   * 但 onError 可能因 AbortError 直接 return 而不被调用，
   * 因此这里也要显式清理 loading / streaming / abortController。
   */
  const stopGeneration = (): void => {
    if (!abortController) return

    console.info('[Conversation] 🛑 用户手动中止生成')
    clearAllTimers()
    abortController.abort()
    setAbortController(null)
    store.loading = false
    setLastEvent('done')
    setCurrentAIMsg(null)

    const session = store.currentSession
    const aiMsg = session.messages[session.messages.length - 1]
    if (aiMsg && aiMsg.streaming) {
      aiMsg.streaming = false
      if (aiMsg.content.length > 0) {
        aiMsg.content += '\n\n[已中止]'
      }
      session.updatedAt = Date.now()
    }
  }

  return { abort, stopGeneration }
}
