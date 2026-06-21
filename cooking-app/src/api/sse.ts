/**
 * ============================================================
 * api/sse.ts — SSE 流式消费的单一入口
 * ============================================================
 *
 * 设计目标：
 *   - 消除 sendChatStream / continueInteractive 之间的 ~150 行重复
 *   - 所有 SSE 行解析、buffer 拼接、工具调用增量聚合、错误处理
 *     集中在一个地方
 *   - 调用方只关心"接到事件后做什么"
 *
 * 使用：
 *   await consumeSSEStream(response, {
 *     onChunk, onDone, onError, onToolCallDelta, onToolCalls, onInteractiveRequest,
 *   }, signal)
 *
 * 后端 SSE 事件约定（统一）：
 *   - { content }                      : 文本 token 片段      → onChunk
 *   - { tool_calls: ToolCallDelta[] }  : 工具调用增量        → onToolCallDelta（按 index 聚合）
 *   - { interactiveId, question, ... } : 交互式工具请求     → onInteractiveRequest
 *   - { sessionId, finish_reason }     : 流结束             → onDone / onToolCalls
 *   - { error }                        : 后端错误            → onError
 *
 * finish_reason 分发规则：
 *   - 'tool_calls' : 调用 onToolCalls（聚合后的完整 ToolCall[]），不调 onDone
 *   - 其它        : 调用 onDone（full, finishReason）
 */

import type {
  ToolCall,
  ToolCallDelta,
  FinishReason,
  InteractiveRequest,
  ReActProgressEvent,
} from '@/types'

export interface SSEConsumerHandlers {
  onChunk: (chunk: string) => void
  onDone: (full: string, finishReason: FinishReason) => void
  onError: (err: Error) => void
  onToolCallDelta?: (delta: ToolCallDelta) => void
  onToolCalls?: (calls: ToolCall[]) => void
  onInteractiveRequest?: (req: InteractiveRequest) => void
  /**
   * P1-①：ReAct 阶段进度事件。用于 UI 渲染"正在思考 / 调用 XX 工具"指示器。
   */
  onProgress?: (event: ReActProgressEvent) => void
  /**
   * P1-②：心跳事件。后端每 15s 发一条 SSE 注释行（`:heartbeat\n\n`），
   * 收到时调用此回调（前端可借此重置静默计时器）。
   */
  onHeartbeat?: () => void
}

/**
 * 消费一个已建立 SSE 连接的 Response。
 *
 * @param response - 由 fetch() 返回的 Response（必须 ok=true，且 body 是 ReadableStream）
 * @param handlers - 事件回调
 * @param signal   - AbortSignal（来自调用方）
 */
export async function consumeSSEStream(
  response: Response,
  handlers: SSEConsumerHandlers,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.ok) {
    handlers.onError(new Error(`HTTP ${response.status}`))
    return
  }

  if (signal?.aborted) {
    handlers.onError(new DOMException('Aborted', 'AbortError'))
    return
  }

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  /**
   * 工具调用增量聚合：
   *   同一个 index 的 tool_call 可能横跨 N 个 chunk 到达，
   *   - id / type：仅在首个 delta 中出现（非空覆盖）
   *   - function.name  ：可能单独一个 chunk
   *   - function.arguments：可能拆成数十个 chunk 拼接
   * 用 Map<index, ToolCall> 聚合，下标即是稳定 key。
   */
  const toolCallBuffer = new Map<number, ToolCall>()

  /**
   * try-catch 包裹整个 read 循环，处理 Agent 进程崩溃导致的 TCP RST：
   *
   * 当 Express 进程被 kill 时，已建立的 TCP 连接被操作系统强制 RST，
   * reader.read() 会抛出 TypeError 或 AbortError。如果不捕获，
   * 异常会冒泡到调用方外层 catch，用户看到的是原始错误信息
   * 而非友好的 "Agent 连接中断" 提示。
   */
  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) break

      // stream: true 让 TextDecoder 缓存跨 chunk 的不完整多字节序列（中文 UTF-8 3字节）
      buffer += decoder.decode(value, { stream: true })

      // buffer 机制防止 SSE 行被 chunk 边界截断
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        // P1-②：SSE 注释行（以 `:` 开头）→ 心跳
        // 后端每 15s 发送 `:heartbeat\n\n`，浏览器 EventSource 会忽略，
        // 但 fetch + ReadableStream 模式下会进入我们的解析循环，需要识别并跳过。
        if (line.startsWith(':')) {
          handlers.onHeartbeat?.()
          continue
        }
        if (!line.startsWith('data: ')) continue
        const jsonStr = line.slice(6).trim()
        if (!jsonStr) continue

        try {
          const data = JSON.parse(jsonStr) as Record<string, unknown>

          // ① 工具调用增量（OpenAI 协议）— 必须先于文本 chunk 判断
          if (Array.isArray(data['tool_calls'])) {
            aggregateToolCallDeltas(data['tool_calls'] as ToolCallDelta[], toolCallBuffer, handlers)
            continue
          }

          // P1-①：ReAct 阶段 progress 事件
          // 后端下发格式：{ type: 'thinking' | 'tool_call' | 'tool_result' | 'streaming', ... }
          if (typeof data['type'] === 'string' && isProgressType(data['type'])) {
            handlers.onProgress?.(data as unknown as ReActProgressEvent)
            continue
          }

          // ② 文本 chunk（content 存在但不是 done 事件）
          if (typeof data['content'] === 'string' && !('sessionId' in data)) {
            handlers.onChunk(data['content'] as string)
            continue
          }

          // ③ 交互式工具请求
          if (typeof data['interactiveId'] === 'string' && Array.isArray(data['options'])) {
            const req: InteractiveRequest = {
              id: data['interactiveId'] as string,
              question: (data['question'] as string) ?? '请选择',
              options: (data['options'] as unknown[]).filter((o): o is string => typeof o === 'string'),
              multiSelect: data['multiSelect'] === true,
              // 后端 schema 默认 type=choice，旧事件缺省时回退 choice 以保持向前兼容
              type: (data['type'] as InteractiveRequest['type']) ?? 'choice',
              category: (data['category'] as string) ?? '',
              meta: (data['meta'] as Record<string, unknown>) ?? {},
              optionImages: Array.isArray(data['optionImages'])
                ? (data['optionImages'] as unknown[]).map((x) => (typeof x === 'string' ? x : null))
                : undefined,
              validation:
                typeof data['validation'] === 'object' && data['validation'] !== null
                  ? (data['validation'] as InteractiveRequest['validation'])
                  : undefined,
            }
            handlers.onInteractiveRequest?.(req)
            continue
          }

          // ④ 流结束（done / tool_calls）
          if (typeof data['sessionId'] === 'string') {
            const finishReason = (data['finish_reason'] as FinishReason) ?? 'stop'
            const full = (data['content'] as string) ?? ''

            if (finishReason === 'tool_calls' && toolCallBuffer.size > 0) {
              const sorted = Array.from(toolCallBuffer.entries())
                .sort(([a], [b]) => a - b)
                .map(([, v]) => v)
              handlers.onToolCalls?.(sorted)
              continue
            }

            if (finishReason === 'length') {
              console.warn('[SSE] ⚠️ 因 max_tokens 截断')
            } else if (finishReason === 'content_filter') {
              console.warn('[SSE] ⚠️ 因内容过滤截断')
            }

            handlers.onDone(full, finishReason)
            continue
          }

          // ⑤ 错误事件
          if (typeof data['error'] === 'string') {
            handlers.onError(new Error(data['error'] as string))
            continue
          }
        } catch {
          // 单行解析失败不影响后续行
        }
      }
    }
  } catch (err) {
    console.error('[SSE] ❌ 连接中断（Agent 可能已崩溃）：', err)
    handlers.onError(new Error('Agent 连接中断，请检查后端服务是否正常运行'))
  }
}

// ─── 内部：工具类型守卫 ────────────────────────────────

function isProgressType(t: string): t is ReActProgressEvent['type'] {
  return t === 'thinking' || t === 'tool_call' || t === 'tool_result' || t === 'streaming'
}

// ─── 内部：聚合工具调用增量 ────────────────────────────────

function aggregateToolCallDeltas(
  deltas: ToolCallDelta[],
  buffer: Map<number, ToolCall>,
  handlers: SSEConsumerHandlers,
): void {
  for (const d of deltas) {
    const idx = typeof d.index === 'number' ? d.index : 0
    const prev: ToolCall = buffer.get(idx) ?? {
      id: '',
      type: 'function',
      function: { name: '', arguments: '' },
    }
    const next: ToolCall = {
      id: d.id ?? prev.id,
      type: d.type ?? prev.type,
      function: {
        name: d.function?.name ?? prev.function.name,
        arguments: (prev.function.arguments ?? '') + (d.function?.arguments ?? ''),
      },
    }
    buffer.set(idx, next)
    handlers.onToolCallDelta?.(d)
  }
}

// ─── 内部：通用 fetch + 错误处理 ───────────────────────────

/**
 * 发起 POST 请求并把错误转给 handler.onError。
 * 真正的网络错误（连接拒绝、DNS 失败、TLS）会被包装为 Error。
 * AbortError 也会传给 onError（与原行为一致）。
 */
export async function postSSE(
  url: string,
  body: unknown,
  handlers: { onError: (err: Error) => void },
  signal?: AbortSignal,
): Promise<Response | null> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    return response
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      handlers.onError(err as Error)
    } else {
      console.error(`[SSE] ❌ POST ${url} 网络请求失败：`, err)
      handlers.onError(err as Error)
    }
    return null
  }
}
