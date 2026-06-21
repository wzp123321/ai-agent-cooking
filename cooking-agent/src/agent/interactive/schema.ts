/**
 * ============================================================
 * interactive/schema.ts — 交互式工具的类型契约
 * ============================================================
 *
 * 类型来源：从 agent.ts 提取的 InteractiveRequest / InteractiveType
 *
 * 字段说明：
 *   - id              : 与 LLM tool_call.id 一一对应
 *   - question        : 向用户提出的问题
 *   - options         : 候选选项（confirm/slider/text 时由 Agent 自动补全或留空）
 *   - multiSelect     : 是否允许多选
 *   - category        : 类别白名单（用于偏好聚合）
 *   - type            : 交互类型（决定前端渲染）
 *   - meta            : 扩展参数（按 type 决定是否生效）
 *   - optionImages    : 选项配图（与 options 等长）
 *   - validation      : 答案有效性约束
 *
 * 重要的不变量：
 *   - type=choice   → options 长度 ≥ 1
 *   - type=confirm  → options = ['确认', '取消']
 *   - type=slider   → meta.min < meta.max
 *   - type=text     → validation 字段生效
 */

import type { InteractiveType } from './constants'

/**
 * 交互式工具请求 — Agent 在 ReAct 循环中检测到 ask_user_choice 工具时，
 * 不会执行它，而是通过此结构把问题/选项交给前端展示。
 *
 * id 与 LLM 下发的 tool_call.id 一一对应，前端回传选择时也带此 id。
 */
export interface InteractiveRequest {
  id: string
  question: string
  options: string[]
  multiSelect: boolean
  category: string
  type: InteractiveType
  /**
   * P2-9 扩展参数（type 决定是否生效）：
   *   - text    : { placeholder?: string, maxLength?: number }
   *   - confirm : 无（自动 [确认]/[取消]）
   *   - slider  : { min: number, max: number, step?: number, default?: number, unit?: string }
   *   - choice  : 无
   */
  meta: Record<string, unknown>
  /**
   * P2-10：选项对应的图片 URL（与 options 等长）。
   * null 表示该选项无图。LLM 在调用 ask_user_choice 时通过
   * option_images 参数传入，URL 必须通过白名单校验。
   */
  optionImages: (string | null)[]
  /**
   * P2-11：答案有效性约束（LLM 声明）。
   *   - regex: 用户答案必须完整匹配的正则
   *   - minLength / maxLength: 字符串长度限制
   */
  validation: {
    regex?: string
    minLength?: number
    maxLength?: number
  }
}

/**
 * 交互式请求事件 — 从 Agent 通过 SSE 推送到前端时附加的元数据
 *
 * P-3：解决"前端类型落后于后端"问题。前端应使用此结构接收 interactive_request 事件。
 */
export interface InteractiveRequestEvent extends InteractiveRequest {
  /** 是否是恢复轮次（用户已经在前面回答过） */
  isReinteractive: boolean
  /** 同一会话内累计轮次（从 1 开始） */
  round: number
}

/**
 * 解析 ask_user_choice 参数时的中间结构（不直接对外暴露）
 */
export interface RawInteractiveArgs {
  question?: string
  options?: string[]
  multi_select?: boolean
  category?: string
  type?: string
  meta?: Record<string, unknown>
  option_images?: string[]
  validation?: {
    regex?: string
    min_length?: number
    max_length?: number
  }
}
