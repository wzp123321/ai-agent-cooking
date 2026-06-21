/**
 * ============================================================
 * conversation/useStreamEvents.ts — SSE 事件回调工厂
 * ============================================================
 *
 * 为 sendChatStream / continueInteractive 批量构造 5 个回调：
 *   onChunk / onDone / onError / onToolCallDelta / onToolCalls / onInteractive
 *
 * 统一处理：
 *   - lastEvent 状态更新
 *   - 计时器重置（chunk → inactivity，tool → inactivity + stuckHint）
 *   - 异常AbortError 吞掉（由调用方处理）
 */

import type {
  ChatMessage,
  ToolCallDelta,
  ToolCall,
  InteractiveRequest,
  FinishReason,
  ReActProgressEvent,
} from '@/types'
import {
  setAbortController,
  setLastEvent,
  setCurrentAIMsg,
  setReactProgress,
} from './_state'
import {
  resetInactivityTimer,
  resetStuckHintTimer,
  clearAllTimers,
} from './useStreamTimers'

// ═══ 流式回调集合 ═══

export interface StreamCallbacks {
  onChunk: (chunk: string) => void
  onDone: (full: string, finishReason: FinishReason) => void
  onError: (err: Error) => void
  onToolCallDelta: (delta: ToolCallDelta) => void
  onToolCalls: (calls: ToolCall[]) => void
  onInteractive: (req: InteractiveRequest) => void
  /**
   * P1-①：ReAct 阶段进度事件。模板侧用它渲染"正在思考 / 调用 XX 工具"指示器。
   */
  onProgress: (event: ReActProgressEvent) => void
  /**
   * P1-②：心跳事件。每 15s 一次，用来重置静默计时器（防止长 ReAct 推理被误判为卡住）。
   */
  onHeartbeat: () => void
}

/**
 * 构造流式事件回调集合。
 * 在 sendMessage / submitInteractiveChoice / sendVisionMessage 中调用。
 */
export function buildStreamCallbacks(
  aiMsg: ChatMessage,
  session: ReturnType<typeof import('@/stores/chat').useChatStore>['currentSession'],
  store: ReturnType<typeof import('@/stores/chat').useChatStore>,
  onDoneExtra?: (finishReason: FinishReason) => void,
): StreamCallbacks {
  // ── chunk：每次累积文本 + 重置静默计时器 ──
  const onChunk = (chunk: string): void => {
    aiMsg.content += chunk
    setLastEvent('chunk')
    resetInactivityTimer()
  }

  // ── done：流结束，覆盖 finish reason 文本 ──
  const onDone = (_full: string, finishReason: FinishReason): void => {
    setLastEvent('done')
    clearAllTimers()
    setCurrentAIMsg(null)
    // P1-①：流结束 → 清空 progress 指示器
    setReactProgress(null)
    aiMsg.streaming = false
    if (finishReason === 'length') {
      aiMsg.content = (aiMsg.content || '') + '\n\n[回答因达到长度上限被截断]'
    } else if (finishReason === 'content_filter') {
      aiMsg.content = (aiMsg.content || '') + '\n\n[回答因内容安全被过滤]'
    }
    session.updatedAt = Date.now()
    store.loading = false
    setAbortController(null)
    onDoneExtra?.(finishReason)
  }

  // ── error：统一错误处理（AbortError 吞掉，其他报错） ──
  const onError = (err: Error): void => {
    clearAllTimers()
    setLastEvent('done')
    setCurrentAIMsg(null)
    // P1-①：流结束（异常）→ 清空 progress 指示器
    setReactProgress(null)
    if (err.name === 'AbortError') {
      aiMsg.streaming = false
      store.loading = false
      setAbortController(null)
      return
    }
    aiMsg.content = err.message
    aiMsg.streaming = false
    store.loading = false
    setAbortController(null)
  }

  // ── tool delta：增量追加 tool call 参数 ──
  const onToolCallDelta = (delta: ToolCallDelta): void => {
    if (!aiMsg.toolCalls) aiMsg.toolCalls = []
    aiMsg.toolCalls[delta.index] = {
      id: delta.id ?? aiMsg.toolCalls[delta.index]?.id ?? '',
      type: 'function',
      function: {
        name: delta.function?.name ?? aiMsg.toolCalls[delta.index]?.function.name ?? '',
        arguments:
          (aiMsg.toolCalls[delta.index]?.function.arguments ?? '') +
          (delta.function?.arguments ?? ''),
      },
    }
  }

  // ── tool calls 聚合完成 ──
  const onToolCalls = (calls: ToolCall[]): void => {
    console.info(`[Conversation] 🔧 收到 ${calls.length} 个工具调用：`, calls.map((c) => c.function.name).join(', '))
    aiMsg.toolCalls = calls
    aiMsg.content = aiMsg.content || ''
    session.updatedAt = Date.now()
    setLastEvent('tool')
    resetInactivityTimer()
    resetStuckHintTimer()
  }

  // ── interactive：交互式工具请求 ──
  const onInteractive = (req: InteractiveRequest): void => {
    console.info(`[Conversation] 🙋 交互式请求 [${session.id}]：${req.question}（${req.options.length} 选项）`)
    setLastEvent('interactive')
    aiMsg.interactive = req
    aiMsg.streaming = false
    store.loading = false
    setAbortController(null)
  }

  return {
    onChunk,
    onDone,
    onError,
    onToolCallDelta,
    onToolCalls,
    onInteractive,
    // P1-①：写入模块级 progress 状态，UI ref 会自动刷新
    onProgress: (event: ReActProgressEvent) => {
      setReactProgress(event)
    },
    // P1-②：心跳 = 静默计时器重置（长 ReAct 推理不能被误判为卡住）
    onHeartbeat: () => {
      resetInactivityTimer()
    },
  }
}

export { setLastEvent }
