/**
 * ============================================================
 * cooking-app API 客户端
 * ============================================================
 *
 * 功能概述：
 *   封装与 cooking-agent 后端服务的 HTTP 通信，包括：
 *   - 普通对话（完整返回）
 *   - 流式对话（SSE，逐字接收）
 *   - 会话管理（列表、历史、清除）
 *   - 健康检查
 *   - 用户画像（获取、更新）
 *
 * 技术选型：
 *   - REST 接口：使用 Axios 实例（统一拦截器、错误处理、日志）
 *   - SSE 流式：使用原生 fetch（Axios 不支持 ReadableStream）
 *   - BASE_URL 由 Vite 代理到 http://localhost:9000（见 vite.config.js）
 *
 * 错误处理：
 *   - Axios 响应拦截器统一处理 HTTP 错误并弹出提示
 *   - SSE 解析失败行直接跳过，不中断后续处理
 */

import request from './request'
import { BASE_URL } from '@/constants'
import type {
  ChatResponse,
  SessionMeta,
  ChatMessage,
  UserProfile,
  ToolCall,
  ToolCallDelta,
  FinishReason,
  InteractiveRequest,
} from '@/types'

// ─── 普通对话 ──────────────────────────────────────────────

/**
 * 发送普通对话请求（非流式，一次性返回完整结果）
 *
 * 使用场景：
 *   - 简单快速问答
 *   - 调试/测试接口
 *
 * @param message   - 用户输入的消息
 * @param sessionId - 会话 ID（默认 'default'）
 * @returns 包含 AI 回复的结构化对象
 */
export const sendChat = async (message: string, sessionId: string): Promise<ChatResponse> => {
  console.info(`[API] POST /chat [${sessionId}]`)

  const { data } = await request.post<ChatResponse>('/chat', { message, sessionId })

  console.info(`[API] ✅ /chat [${sessionId}] 收到回复：${data.message.length} 字符`)
  return data
}

// ─── 流式对话（SSE，保留原生 fetch）───────────────────────

/**
 * 发送流式对话请求（SSE — Server-Sent Events）
 *
 * 注意：此函数使用原生 fetch 而非 Axios，
 * 因为 Axios 不支持 ReadableStream 流式读取。
 *
 * SSE 事件类型（后端约定）：
 *   - { content }                   : 文本 token 片段 → onChunk
 *   - { tool_calls: [...] }         : 工具调用增量   → onToolCallDelta
 *   - { sessionId, finish_reason }  : 流结束         → onDone / onToolCalls
 *   - { error }                     : 后端错误        → onError
 *
 * finish_reason 分发规则（OpenAI 协议兼容）：
 *   - 'stop' / 'length' / 'content_filter' : 调用 onDone（最终文本已包含）
 *   - 'tool_calls'                         : 调用 onToolCalls（聚合后的完整列表），不调 onDone
 *   - null / undefined                     : 兜底按 onDone 处理
 *
 * 工具调用聚合：
 *   OpenAI 协议下，工具调用以 delta 形式跨多个 chunk 下发，
 *   需要按 tool_calls[].index 聚合成完整的 ToolCall[]。
 *
 * @param message          - 用户输入
 * @param sessionId        - 会话 ID
 * @param onChunk          - 文本片段回调
 * @param onDone           - 文本流结束回调（仅 finish_reason != 'tool_calls'）
 * @param onError          - 出错回调
 * @param signal           - AbortSignal，用于取消请求
 * @param onToolCallDelta  - 工具调用增量回调（可选，UI 实时显示"正在调用 XX"）
 * @param onToolCalls      - 工具调用聚合完成回调（可选，finish_reason='tool_calls' 时触发）
 */
/**
 * sendChatStream — 发送流式对话请求（SSE — Server-Sent Events）
 *
 * 注意：此函数使用原生 fetch 而非 Axios，
 * 因为 Axios 不支持 ReadableStream 流式读取。
 *
 * SSE 事件类型（后端约定）：
 *   - { content }                      : 文本 token 片段 → onChunk
 *   - { tool_calls: [...] }            : 工具调用增量   → onToolCallDelta
 *   - { interactiveId, question, ... } : 交互式工具请求 → onInteractiveRequest
 *   - { sessionId, finish_reason }     : 流结束         → onDone / onToolCalls
 *   - { error }                        : 后端错误        → onError
 *
 * finish_reason 分发规则（OpenAI 协议兼容）：
 *   - 'stop' / 'length' / 'content_filter' : 调用 onDone（最终文本已包含）
 *   - 'tool_calls'                         : 调用 onToolCalls（聚合后的完整列表），不调 onDone
 *   - null / undefined                     : 兜底按 onDone 处理
 *
 * 工具调用聚合：
 *   OpenAI 协议下，工具调用以 delta 形式跨多个 chunk 下发，
 *   需要按 tool_calls[].index 聚合成完整的 ToolCall[]。
 *
 * 交互式工具（范式 B）：
 *   当 LLM 调起 ask_user_choice 时，agent 不调 onDone 而是先发 interactive_request。
 *   收到此事件后调用方应渲染按钮，**不**重启流。
 *   用户选择后调用 continueInteractive() 重新开启流。
 *
 * @param message                 - 用户输入
 * @param sessionId               - 会话 ID
 * @param onChunk                 - 文本片段回调
 * @param onDone                  - 文本流结束回调（仅 finish_reason != 'tool_calls'）
 * @param onError                 - 出错回调
 * @param signal                  - AbortSignal，用于取消请求
 * @param onToolCallDelta         - 工具调用增量回调（可选，UI 实时显示"正在调用 XX"）
 * @param onToolCalls             - 工具调用聚合完成回调（可选，finish_reason='tool_calls' 时触发）
 * @param onInteractiveRequest    - 交互式工具请求回调（可选，ask_user_choice 触发时）
 */
export const sendChatStream = async (
  message: string,
  sessionId: string,
  onChunk: (chunk: string) => void,
  onDone: (full: string, finishReason: FinishReason) => void,
  onError: (err: Error) => void,
  signal?: AbortSignal,
  onToolCallDelta?: (delta: ToolCallDelta) => void,
  onToolCalls?: (calls: ToolCall[]) => void,
  onInteractiveRequest?: (req: InteractiveRequest) => void,
): Promise<void> => {
  console.info(`[API] POST /chat/stream [${sessionId}] 建立 SSE 连接…`)

  let response: Response

  try {
    response = await fetch(`${BASE_URL}/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, sessionId }),
      signal,
    })
  } catch (err) {
    /**
     * AbortError 不是真正的网络错误，而是用户主动中止或超时的预期行为。
     * 必须调用 onError 回调，确保上层的 sendMessage 能够正确清理
     * loading 状态、streaming 标记和 AbortController 引用。
     */
    if ((err as Error).name === 'AbortError') {
      console.info(`[API] 🛑 SSE [${sessionId}] 请求已取消`)
      onError(err as Error)
      return
    }
    /**
     * 真正的网络异常：
     *   - Agent 进程崩溃（ECONNREFUSED）
     *   - DNS 解析失败
     *   - 网络超时
     *   - TLS 握手失败
     */
    console.error('[API] ❌ /chat/stream 网络请求失败：', err)
    onError(err as Error)
    return
  }

  if (!response.ok) {
    console.error(`[API] ❌ /chat/stream HTTP ${response.status}`)
    onError(new Error(`HTTP ${response.status}`))
    return
  }

  console.info('[API] 🔗 SSE 连接已建立，开始接收流…')

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
   * 异常会冒泡到 sendMessage 的外层 catch，用户看到的是原始错误信息
   * 而非友好的 "Agent 连接中断" 提示。
   */
  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        console.info('[API] ✅ SSE 流读取完毕')
        break
      }

      /**
       * TextDecoder.decode(value, { stream: true }) 的关键参数 stream: true：
       * 多字节字符（如中文 UTF-8 编码的 3 字节字符）可能跨 chunk 边界被截断，
       * stream: true 让 TextDecoder 缓存不完整的多字节序列，等待下一个 chunk 拼接。
       * 省略此参数会导致乱码。
       */
      buffer += decoder.decode(value, { stream: true })

      /**
       * buffer 机制防止 SSE 行被 chunk 边界截断：
       *   - split('\n') 分割后，最后一行可能不完整
       *   - lines.pop() 保留最后一行到 buffer，等待下一个 chunk 拼接
       *   - 只有完整的行（以 \n 结尾）才进入解析循环
       */
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue

        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6).trim()
          if (!jsonStr) continue

          try {
            const data = JSON.parse(jsonStr) as Record<string, unknown>

            // ─── 1) 工具调用增量（OpenAI 协议） ──────────
            if (Array.isArray(data['tool_calls'])) {
              const deltas = data['tool_calls'] as ToolCallDelta[]
              for (const d of deltas) {
                // 防御：index 缺失时退化为 0
                const idx = typeof d.index === 'number' ? d.index : 0

                /**
                 * 累加规则：
                 *   - id / type / function.name：首段非空覆盖（避免后段空串清空）
                 *   - function.arguments      ：真正的"增量追加"
                 *   - 字段缺失时保持原值不变
                 */
                const prev: ToolCall = toolCallBuffer.get(idx) ?? {
                  id: '',
                  type: 'function',
                  function: { name: '', arguments: '' },
                }

                const next: ToolCall = {
                  id: d.id ?? prev.id,
                  type: d.type ?? prev.type,
                  function: {
                    name: d.function?.name ?? prev.function.name,
                    arguments:
                      (prev.function.arguments ?? '') + (d.function?.arguments ?? ''),
                  },
                }

                toolCallBuffer.set(idx, next)
                onToolCallDelta?.(d)
              }
              continue
            }

            // ─── 2) 文本 chunk ───────────────────────────
            if (typeof data['content'] === 'string' && !('sessionId' in data)) {
              onChunk(data['content'] as string)
              continue
            }

            // ─── 2.5) 交互式工具请求（ask_user_choice） ─────
            // 后端在 LLM 决定调起交互式工具时下发，事件 data 形如：
            //   { interactiveId, question, options: string[], multiSelect: boolean }
            // 注意：interactiveId 与 LLM tool_call.id 一一对应；
            // 前端回传选择时用此 id 关联到上一轮的 ask_user_choice。
            if (typeof data['interactiveId'] === 'string' && Array.isArray(data['options'])) {
              const req: InteractiveRequest = {
                id: data['interactiveId'] as string,
                question: (data['question'] as string) ?? '请选择',
                options: (data['options'] as unknown[]).filter((o): o is string => typeof o === 'string'),
                multiSelect: data['multiSelect'] === true,
              }
              console.info(
                `[API] 🙋 SSE [${sessionId}] 收到交互式请求：${req.question}（${req.options.length} 选项, ${req.multiSelect ? '多选' : '单选'}）`,
              )
              onInteractiveRequest?.(req)
              continue
            }

            // ─── 3) 流结束（done / tool_calls） ──────────
            if (typeof data['sessionId'] === 'string') {
              const finishReason = (data['finish_reason'] as FinishReason) ?? 'stop'
              const full = (data['content'] as string) ?? ''

              console.info(
                `[API] ✅ SSE done [${data['sessionId']}] ` +
                  `finish_reason=${finishReason} ` +
                  `tool_calls=${toolCallBuffer.size}`,
              )

              if (finishReason === 'tool_calls' && toolCallBuffer.size > 0) {
                /**
                 * 场景 A：LLM 决定调用工具（不产出最终文本）
                 * 把所有按 index 聚合好的完整 ToolCall 按下标升序交付。
                 * 上层在收到此回调后应当：
                 *   1) 把 assistant 的 tool_calls 写回 history
                 *   2) 执行工具
                 *   3) 把工具结果以 role='tool' 写回 history
                 *   4) 再次调用 sendChatStream 发起下一轮
                 *
                 * 此处不调 onDone —— 因为本轮没有"最终文本"。
                 */
                const sorted = Array.from(toolCallBuffer.entries())
                  .sort(([a], [b]) => a - b)
                  .map(([, v]) => v)

                onToolCalls?.(sorted)
                continue
              }

              if (finishReason === 'length') {
                console.warn('[API] ⚠️  SSE 因 max_tokens 截断')
              } else if (finishReason === 'content_filter') {
                console.warn('[API] ⚠️  SSE 因内容过滤截断')
              }

              onDone(full, finishReason)
              continue
            }

            // ─── 4) 错误事件 ─────────────────────────────
            if (typeof data['error'] === 'string') {
              console.error('[API] ❌ SSE error 事件：', data['error'])
              onError(new Error(data['error'] as string))
              continue
            }
          } catch {
            console.warn('[API] ⚠️  SSE 行解析失败，跳过：', jsonStr.slice(0, 50))
          }
        }
      }
    }
  } catch (err) {
    console.error('[API] ❌ SSE 连接中断（Agent 可能已崩溃）：', err)
    onError(new Error('Agent 连接中断，请检查后端服务是否正常运行'))
  }
}

/**
 * continueInteractive — 用户在交互式工具上做出选择后，调用此函数恢复流
 *
 * 与 sendChatStream 流程几乎相同，唯一区别：
 *   - POST /api/chat/continue（而非 /api/chat/stream）
 *   - 请求体携带 interactiveId 与 choice
 *   - 不再需要 onToolCallDelta（用户已经选过了）
 *
 * 复用场景：
 *   恢复后 LLM 又触发新的交互式工具 → 通过 onInteractiveRequest 回调再次弹按钮
 *   恢复后 LLM 进入最终回答 → 通过 onChunk / onDone 正常完成
 *
 * 复用此函数代替 sendChatStream 的原因：
 *   - 避免在 useConversation.ts 中复制 SSE 解析代码
 *   - 接口对调用方完全一致（onChunk / onDone / onError / onInteractiveRequest）
 */
export const continueInteractive = async (
  sessionId: string,
  interactiveId: string,
  choice: string[],
  onChunk: (chunk: string) => void,
  onDone: (full: string, finishReason: FinishReason) => void,
  onError: (err: Error) => void,
  signal?: AbortSignal,
  onInteractiveRequest?: (req: InteractiveRequest) => void,
): Promise<void> => {
  console.info(`[API] POST /chat/continue [${sessionId}] 恢复 interactiveId=${interactiveId}`)

  let response: Response

  try {
    response = await fetch(`${BASE_URL}/chat/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, interactiveId, choice }),
      signal,
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      console.info(`[API] 🛑 continue [${sessionId}] 请求已取消`)
      onError(err as Error)
      return
    }
    console.error('[API] ❌ /chat/continue 网络请求失败：', err)
    onError(err as Error)
    return
  }

  if (!response.ok) {
    console.error(`[API] ❌ /chat/continue HTTP ${response.status}`)
    onError(new Error(`HTTP ${response.status}`))
    return
  }

  console.info('[API] 🔗 continue SSE 连接已建立，开始接收流…')

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        console.info('[API] ✅ continue SSE 流读取完毕')
        break
      }

      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue

        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6).trim()
          if (!jsonStr) continue

          try {
            const data = JSON.parse(jsonStr) as Record<string, unknown>

            // 文本 chunk
            if (typeof data['content'] === 'string' && !('sessionId' in data)) {
              onChunk(data['content'] as string)
              continue
            }

            // 交互式工具请求（恢复后又触发了新的 ask_user_choice）
            if (typeof data['interactiveId'] === 'string' && Array.isArray(data['options'])) {
              const req: InteractiveRequest = {
                id: data['interactiveId'] as string,
                question: (data['question'] as string) ?? '请选择',
                options: (data['options'] as unknown[]).filter((o): o is string => typeof o === 'string'),
                multiSelect: data['multiSelect'] === true,
              }
              console.info(`[API] 🙋 continue [${sessionId}] 又收到交互式请求：${req.question}`)
              onInteractiveRequest?.(req)
              continue
            }

            // 流结束
            if (typeof data['sessionId'] === 'string') {
              const finishReason = (data['finish_reason'] as FinishReason) ?? 'stop'
              const full = (data['content'] as string) ?? ''
              console.info(`[API] ✅ continue SSE done [${data['sessionId']}] finish_reason=${finishReason}`)
              onDone(full, finishReason)
              continue
            }

            // 错误
            if (typeof data['error'] === 'string') {
              console.error('[API] ❌ continue SSE error 事件：', data['error'])
              onError(new Error(data['error'] as string))
              continue
            }
          } catch {
            console.warn('[API] ⚠️  continue SSE 行解析失败，跳过：', jsonStr.slice(0, 50))
          }
        }
      }
    }
  } catch (err) {
    console.error('[API] ❌ continue SSE 连接中断：', err)
    onError(new Error('Agent 连接中断，请检查后端服务是否正常运行'))
  }
}

// ─── 会话管理 ──────────────────────────────────────────────

/**
 * 清除指定会话（服务端删除消息历史）
 *
 * 调用时机：用户点击"新对话"或"清空当前对话"按钮
 * 注意：即使请求失败也不 throw，前端已同步清除了本地状态
 */
export const clearSession = async (sessionId: string): Promise<void> => {
  console.info(`[API] DELETE /session/${sessionId}`)

  try {
    await request.delete(`/session/${sessionId}`)
    console.info(`[API] ✅ 会话 ${sessionId} 已清除`)
  } catch (err) {
    console.error(`[API] ❌ 清除会话 ${sessionId} 失败：`, err)
  }
}

// ─── 健康检查 ──────────────────────────────────────────────

/**
 * 健康检查 — 判断 Agent 服务是否在线
 *
 * 调用时机：
 *   - App.vue 挂载时（onMounted）
 *   - SidebarPanel 每 30 秒轮询一次
 *
 * 注意：健康检查使用原生 fetch（不走 /api 代理），
 * 直接请求 /health 端点，避免被 Axios 拦截器误报错误。
 *
 * @returns true = Agent 在线，false = Agent 离线或网络不可达
 */
export const healthCheck = async (): Promise<boolean> => {
  try {
    const res = await fetch('/health')
    const online = res.ok

    console.info(`[API] 🔍 健康检查：${online ? '✅ Agent 在线' : '❌ Agent 离线'}`)
    return online
  } catch {
    console.warn('[API] ⚠️  健康检查网络错误：Agent 服务不可达')
    return false
  }
}

// ─── 会话列表 & 历史 ──────────────────────────────────────

/**
 * 获取所有会话列表（用于侧边栏展示）
 */
export const getSessions = async (): Promise<SessionMeta[]> => {
  console.info('[API] GET /sessions')

  const { data } = await request.get<SessionMeta[]>('/sessions')

  console.info(`[API] ✅ 获取到 ${data.length} 个会话`)
  return data
}

/**
 * 获取指定会话的对话历史（不含 system prompt）
 *
 * 返回时过滤掉 system/tool 消息，只保留 user/assistant 对话
 */
export const getHistory = async (sessionId: string): Promise<ChatMessage[]> => {
  console.info(`[API] GET /history/${sessionId}`)

  const { data } = await request.get<{
    sessionId: string
    history: { role: string; content: string; tool_call_id?: string }[]
  }>(`/history/${sessionId}`)

  const messages = data.history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m, i) => ({
      id: `${sessionId}_${i}`,
      role: m.role as 'user' | 'assistant',
      content: m.content,
      timestamp: Date.now(),
    }))

  console.info(`[API] ✅ 加载会话 ${sessionId} 历史：${messages.length} 条`)
  return messages
}

// ─── 用户画像 ──────────────────────────────────────────────

/**
 * 获取用户画像（偏好设置）
 */
export const getProfile = async (): Promise<UserProfile> => {
  console.info('[API] GET /profile')

  const { data } = await request.get<UserProfile>('/profile')

  console.info(`[API] ✅ 获取用户画像：${data.diet_type || '无特殊膳食'} | ${data.skill_level}`)
  return data
}

/**
 * 更新用户画像
 *
 * @param updates - 部分画像字段（只传需要更新的字段）
 */
export const updateProfile = async (updates: Partial<UserProfile>): Promise<UserProfile> => {
  console.info('[API] PUT /profile', updates)

  const { data } = await request.put<UserProfile>('/profile', updates)

  console.info(`[API] ✅ 用户画像已更新`)
  return data
}

// ─── 图片识别 ──────────────────────────────────────────────

export interface VisionResponse {
  success: boolean
  content: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export const sendVisionChat = async (
  imageBase64: string,
  message?: string,
): Promise<VisionResponse> => {
  console.info('[API] POST /vision/chat')

  const { data } = await request.post<VisionResponse>('/vision/chat', {
    image: imageBase64,
    message: message || undefined,
  })

  console.info(`[API] ✅ 图片识别完成，${data.content.length} 字符`)
  return data
}