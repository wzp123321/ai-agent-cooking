/**
 * ============================================================
 * ask-user.ts — 交互式工具：让 LLM 把决策权交还给用户
 * ============================================================
 *
 * 这是范式 B（人机协作）的入口工具。
 *
 * 与普通工具的区别：
 *   - 不会被 LLM 直接执行
 *   - 工具调用一旦出现，Agent 立即暂停流式输出，向前端发送 interactive_request 事件
 *   - 等待用户在前端点击选项后，由 /api/chat/continue 端点接管，恢复 ReAct 循环
 *
 * 参数 schema：
 *   - question     : 向用户提出的问题（必填）
 *   - options      : 2-4 个候选选项（必填）
 *   - multi_select : 是否允许多选，默认 false
 *
 * 触发场景示例：
 *   "今天吃什么好？" → LLM 不确定场景，调用 ask_user_choice 收集偏好
 *   "红烧肉怎么做"   → LLM 直接调 search_recipe，不需要交互
 *
 * 实现函数的处理：
 *   工具执行在 handleInteractiveToolCalls() 处被拦截，
 *   这个 impl 仅作为兜底，正常流程不会调用。
 */

import type { Tool, ToolImpl } from './types'

export const ask_user_tool: Tool = {
  name: 'ask_user_choice',
  description:
    '当用户意图不明确、或 LLM 需要先收集关键偏好（场景/口味/饮食限制）才能给出准确回答时调用此工具。' +
    '调用后系统会自动暂停回答，将选项交给用户在前端界面选择。' +
    '不要用于：① 答案已经明确可查的情况（用 search_recipe 等查询工具）② 工具参数收集（用对应工具的参数）' +
    'options 必须是 2-4 个候选，每个不超过 20 字。',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: '向用户提出的问题，例如"你今天想吃什么场景的菜？"',
      },
      options: {
        type: 'array',
        description: '2-4 个候选选项，用户将在前端按钮中点击选择',
        items: { type: 'string', description: '选项文本' },
      },
      multi_select: {
        type: 'boolean',
        description: '是否允许多选，默认 false（单选）',
      },
      /**
       * P1-7 引入：问题分类标签。
       *
       * 作用：
       *   - 同一类问题（如 "diet"）的历史选择会聚合成偏好
       *   - 后续可被系统 prompt 引用："用户最常选的 diet 类别是：减脂(5次) > 增肌(2次)"
       *
       * 推荐值（不强制）：
       *   - "diet"      饮食目标（减脂/增肌/控糖/均衡…）
       *   - "cuisine"   菜系偏好（川菜/粤菜/西餐…）
       *   - "taste"     口味偏好（麻辣/清淡/酸甜…）
       *   - "skill"     技能等级（新手/进阶/熟练）
       *   - "scene"     用餐场景（早餐/午餐/宴客/便当…）
       *   - "allergy"   过敏回避（花生/海鲜/乳制品…）
       *   - ""          留空表示一次性/无法分类
       */
      category: {
        type: 'string',
        description: '问题分类标签，用于聚合用户偏好。可留空。',
        enum: ['', 'diet', 'cuisine', 'taste', 'skill', 'scene', 'allergy'],
      },
      /**
       * P2-9 引入：交互类型
       *   - choice  : 选项按钮（默认），options 字段必填
       *   - text    : 自由文本输入，前端用 textarea
       *   - confirm : 确认弹窗，自动渲染 [确认]/[取消] 两个按钮
       *   - slider  : 数值滑块，meta 字段必填且包含 min/max
       */
      type: {
        type: 'string',
        description: '交互类型。默认 choice。',
        enum: ['choice', 'text', 'confirm', 'slider'],
      },
      /**
       * P2-9 扩展参数（仅 type 为 text/slider 时生效）：
       *   - text    : { placeholder?: string, maxLength?: number }
       *   - slider  : { min: number, max: number, step?: number, default?: number, unit?: string }
       *
       * 注意：当前的 ToolParameterProperty 不支持嵌套 properties，
       * 这里只声明类型为 object，LLM 根据 type 自行决定 meta 内部结构。
       * 实际解析逻辑在 agent.ts 的 parseInteractiveArgs 中处理。
       */
      meta: {
        type: 'object',
        description: '扩展参数，依 type 而定。type=text 时支持 {placeholder, maxLength}；type=slider 时支持 {min, max, step, default, unit}。',
      },
      /**
       * P2-10：选项配图（仅 type=choice 生效）。
       * 数组，长度与 options 一致；缺位用 null。
       * URL 必须以 https:// 开头，或 data:image/;base64, 的内联图。
       * Agent 会做白名单校验，非法 URL 会被丢弃。
       */
      option_images: {
        type: 'array',
        description: '选项对应的图片 URL 列表，与 options 等长。',
        items: { type: 'string' },
      },
      /**
       * P2-11：答案有效性约束（仅 type=text 生效）。
       *   - regex       : 用户答案必须完整匹配的正则字符串
       *   - min_length  : 最小长度
       *   - max_length  : 最大长度
       *
       * 注意：当前 schema 不支持嵌套 properties，LLM 自行决定内部字段，
       * Agent 做防御性处理：长度限制 ≤ 200 字符，编译失败的正则会被丢弃。
       */
      validation: {
        type: 'object',
        description: '对用户答案的格式约束。type=text 时生效。可包含 {regex, min_length, max_length}。',
      },
    },
    required: ['question', 'options'],
  },
}

/**
 * 兜底实现 —— 正常流程不会执行到这里。
 * 实际处理逻辑在 agent.ts 的 handleInteractiveToolCalls() 中。
 */
export const ask_user_impl: ToolImpl<{
  question: string
  options: string[]
  multi_select?: boolean
  category?: string
  type?: 'choice' | 'text' | 'confirm' | 'slider'
  meta?: Record<string, unknown>
  option_images?: string[]
  validation?: {
    regex?: string
    min_length?: number
    max_length?: number
  }
}> = async () => {
  return {
    success: false,
    error: 'ask_user_choice 工具由 Agent 拦截处理，不应通过 executeTool() 直接执行',
  }
}

/**
 * 交互式工具名称集合
 *
 * Agent 在工具执行前会检查调用是否命中此集合：
 *   - 命中 → 拦截，不执行 impl，直接发送 interactive_request 事件
 *   - 未命中 → 走正常的 executeTool() 流程
 */
export const INTERACTIVE_TOOL_NAMES: ReadonlySet<string> = new Set([ask_user_tool.name])
