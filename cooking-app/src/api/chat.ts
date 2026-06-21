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
 *   - SSE 流式：使用原生 fetch + api/sse.ts 的 consumeSSEStream 通用解析器
 *   - BASE_URL 由 Vite 代理到 http://localhost:9000（见 vite.config.js）
 *
 * 错误处理：
 *   - Axios 响应拦截器统一处理 HTTP 错误并弹出提示
 *   - SSE 解析失败行直接跳过，不中断后续处理
 *
 * P-重构：原 sendChatStream / continueInteractive 各自内联 ~150 行 SSE 解析
 *         已统一抽到 api/sse.ts，调用方只需关注 handlers。
 */

import request from './request'
import { BASE_URL } from '@/constants'
import { consumeSSEStream, postSSE } from './sse'
import type {
  ChatResponse,
  SessionMeta,
  ChatMessage,
  UserProfile,
  ToolCall,
  FinishReason,
  InteractiveRequest,
  ReActProgressEvent,
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

// ─── 流式对话 ──────────────────────────────────────────────

/**
 * 发送流式对话请求（SSE — Server-Sent Events）
 *
 * 实现已抽到 api/sse.ts：
 *   - 工具调用按 index 聚合
 *   - text chunk / interactive_request / done 事件分发
 *   - AbortError、网络错误统一处理
 *
 * finish_reason 分发规则：
 *   - 'tool_calls' : 调用 onToolCalls（聚合后的完整 ToolCall[]），不调 onDone
 *   - 其它        : 调用 onDone（full, finishReason）
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
  onToolCallDelta?: (delta: import('@/types').ToolCallDelta) => void,
  onToolCalls?: (calls: ToolCall[]) => void,
  onInteractiveRequest?: (req: InteractiveRequest) => void,
  /**
   * P1-①：ReAct 阶段进度事件。
   */
  onProgress?: (event: ReActProgressEvent) => void,
  /**
   * P1-②：后端心跳（每 15s 一次）。用于重置静默计时器。
   */
  onHeartbeat?: () => void,
): Promise<void> => {
  console.info(`[API] POST /chat/stream [${sessionId}] 建立 SSE 连接…`)

  const response = await postSSE(
    `${BASE_URL}/chat/stream`,
    { message, sessionId },
    { onError },
    signal,
  )
  if (!response) return

  console.info('[API] 🔗 SSE 连接已建立，开始接收流…')

  await consumeSSEStream(
    response,
    { onChunk, onDone, onError, onToolCallDelta, onToolCalls, onInteractiveRequest, onProgress, onHeartbeat },
    signal,
  )
}

/**
 * continueInteractive — 用户在交互式工具上做出选择后，调用此函数恢复流
 *
 * 与 sendChatStream 流程几乎相同，唯一区别：
 *   - POST /api/chat/continue（而非 /api/chat/stream）
 *   - 请求体携带 interactiveId 与 choice
 *   - 不再需要 onToolCallDelta（用户已经选过了）
 *
 * 复用 api/sse.ts 的 consumeSSEStream，零重复代码。
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
  onProgress?: (event: ReActProgressEvent) => void,
  onHeartbeat?: () => void,
): Promise<void> => {
  console.info(`[API] POST /chat/continue [${sessionId}] 恢复 interactiveId=${interactiveId}`)

  const response = await postSSE(
    `${BASE_URL}/chat/continue`,
    { sessionId, interactiveId, choice },
    { onError },
    signal,
  )
  if (!response) return

  console.info('[API] 🔗 continue SSE 连接已建立，开始接收流…')

  await consumeSSEStream(
    response,
    { onChunk, onDone, onError, onInteractiveRequest, onProgress, onHeartbeat },
    signal,
  )
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
