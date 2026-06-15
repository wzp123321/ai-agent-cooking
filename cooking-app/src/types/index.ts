// ─── 消息类型 ─────────────────────────────────────────
export type MessageRole = 'user' | 'assistant'

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  timestamp: number
  streaming?: boolean
  image?: string
  /** LLM 在本轮下发的工具调用（仅 finish_reason=tool_calls 时存在） */
  toolCalls?: ToolCall[]
  /** 当 role='tool' 时，记录对应的 tool_call_id */
  toolCallId?: string
  /**
   * 交互式工具请求（范式 B：人机协作）。
   * 当 LLM 调起 ask_user_choice 时，前端会渲染为可点击按钮/复选框。
   * 用户选择后通过 continueInteractive() 提交选择，Agent 继续 ReAct 循环。
   */
  interactive?: InteractiveRequest
  /** 用户做出的选择（提交后写入，仅作 UI 展示用） */
  interactiveChoice?: string[]
  /** 用户已做出选择（按钮变为只读状态） */
  interactiveResolved?: boolean
}

/**
 * 交互式工具请求
 *
 * 由后端在 LLM 调起 ask_user_choice 时下发，
 * 前端把它渲染为按钮组（单选）/复选框组（多选）。
 *
 * id 与 LLM 下发的 tool_call.id 一一对应，
 * 用户选择回传时也带此 id。
 */
export interface InteractiveRequest {
  id: string
  question: string
  options: string[]
  /** true=多选（复选框）；false=单选（按钮组） */
  multiSelect: boolean
}

// ─── 会话类型 ─────────────────────────────────────────
export interface ChatSession {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
}

export interface SessionMeta {
  id: string
  title: string
  created_at: number
  updated_at: number
}

// ─── API 响应类型 ─────────────────────────────────────
export interface ChatResponse {
  success: boolean
  message: string
  sessionId: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

// ─── SSE 事件类型 ─────────────────────────────────────
export interface SSEChunkData {
  content: string
}

export interface SSEDoneData {
  content: string
  sessionId: string
}

export interface SSEErrorData {
  error: string
}

// ─── 工具调用类型 ─────────────────────────────────────
/**
 * 完整的工具调用（聚合后）
 * 由 LLM 在一次响应中下发，可能并行多个。
 */
export interface ToolCall {
  /** 工具调用的全局唯一 ID（与 tool 角色消息的 tool_call_id 对应） */
  id: string
  /** 固定为 'function'（OpenAI 协议） */
  type: 'function'
  function: {
    /** 工具函数名 */
    name: string
    /** 参数的 JSON 字符串（前端需 JSON.parse 后使用） */
    arguments: string
  }
}

/**
 * 工具调用的增量片段（每个 SSE chunk 携带）
 * 需要按 index 聚合形成完整 ToolCall。
 */
export interface ToolCallDelta {
  /** 用于跨 chunk 聚合的下标 */
  index: number
  /** 仅首个 delta 携带 */
  id?: string
  /** 仅首个 delta 携带 */
  type?: 'function'
  function?: {
    /** 可能跨多个 delta 拼接 */
    name?: string
    /** 可能跨多个 delta 拼接 */
    arguments?: string
  }
}

/**
 * 流结束原因（OpenAI 协议兼容）
 * - stop          : 正常结束
 * - tool_calls    : LLM 要求执行工具，需要客户端回填结果后再次请求
 * - length        : 触发了 max_tokens 截断
 * - content_filter: 内容被安全过滤
 */
export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | null

export interface UserProfile {
  id: string
  allergies: string[]
  diet_type: string
  skill_level: 'beginner' | 'intermediate' | 'expert'
  disliked: string[]
  calorie_goal: number
  created_at: number
  updated_at: number
}
