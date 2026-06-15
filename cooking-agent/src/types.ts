/**
 * ============================================================
 * cooking-agent 类型定义文件
 * ============================================================
 * 定义整个 Agent 服务中使用的核心 TypeScript 类型。
 * 所有类型均导出给 agent.ts / index.ts 使用。
 */

// ─── 消息类型 ────────────────────────────────────────────
// 直接复用 OpenAI SDK 中定义的消息格式（role / content / name 字段），
// 保持与 DeepSeek API 的消息结构完全一致，避免手动定义产生偏差。
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: {
      name: string
      arguments: string
    }
  }>
}

// ─── 普通对话返回值 ────────────────────────────────────────
export interface ChatResult {
  /** 请求是否成功 */
  success: boolean
  /** AI 返回的文本内容 */
  message: string
  /** 所属会话 ID */
  sessionId: string
  /** 本次调用的 token 消耗（API 有返回时才有） */
  usage?: {
    prompt_tokens: number      // 输入消耗的 token 数
    completion_tokens: number  // 输出消耗的 token 数
    total_tokens: number      // 总 token 数
  }
}

// ─── HTTP 请求 Body ──────────────────────────────────────
export interface ChatRequestBody {
  /** 用户发送的消息内容 */
  message: string
  /** 会话 ID，默认为 'default'（可选） */
  sessionId?: string
}

/**
 * /api/chat/continue 请求 Body
 * 由前端在用户点击 ask_user_choice 选项后调用
 */
export interface ContinueRequestBody {
  sessionId: string
  /** 上一轮 ask_user_choice 的 tool_call_id */
  interactiveId: string
  /** 用户选择的选项（始终是数组，单选时只有一个元素） */
  choice: string[]
}
