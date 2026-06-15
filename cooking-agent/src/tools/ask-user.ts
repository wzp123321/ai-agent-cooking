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
