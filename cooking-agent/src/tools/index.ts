/**
 * ============================================================
 * tools/index.ts — 工具体系统一导出与注册
 * ============================================================
 *
 * 所有工具的元信息（Tool）和实现函数（ToolImpl）在此集中注册。
 *
 * 注册表结构：
 *   tools[toolName] = { tool: Tool元信息, impl: ToolImpl实现 }
 *
 * Agent 在构造 Function Calling 参数时，从 TOOL_LIST 遍历生成。
 * 执行工具时，通过 TOOL_IMPLS 映射表查找对应实现。
 */

import type { Tool, ToolImpl, ToolCall, ToolResult } from './types'
import { recipe_tool, recipe_impl } from './recipe'
import { nutrition_tool, nutrition_impl } from './nutrition'
import { safety_tool, safety_impl } from './safety'
import { technique_tool, technique_impl } from './technique'
import { suggest_tool, suggest_impl } from './suggest'
import { substitute_tool, substitute_impl } from './substitute'
import { diet_tool, diet_impl } from './diet'
import { knowledge_tool, knowledge_impl } from './knowledge'
import { ask_user_tool, ask_user_impl, INTERACTIVE_TOOL_NAMES } from './ask-user'

// ─── 工具注册表 ────────────────────────────────────────────

/**
 * 所有可用工具的元信息（供 OpenAI Function Calling 使用）
 * 顺序：recipe → nutrition → safety → technique → suggest → substitute → diet → knowledge → ask_user
 *
 * 最后一名的 ask_user_choice 是"交互式工具"：
 *   Agent 在执行前会通过 INTERACTIVE_TOOL_NAMES 识别它，
 *   命中后走 pause-and-wait 流程（不下发到 LLM 工具调用执行层），
 *   而是发送 SSE interactive_request 事件给前端，等待用户选择后由 /api/chat/continue 恢复。
 */
export const TOOL_LIST: Tool[] = [
  recipe_tool,
  nutrition_tool,
  safety_tool,
  technique_tool,
  suggest_tool,
  substitute_tool,
  diet_tool,
  knowledge_tool,
  ask_user_tool,
]

/**
 * 所有工具的实现函数映射表
 * key = tool.name，value = 对应的实现函数
 */
const TOOL_IMPLS: Record<string, ToolImpl<Record<string, unknown>>> = {
  [recipe_tool.name]:     recipe_impl     as ToolImpl<Record<string, unknown>>,
  [nutrition_tool.name]:  nutrition_impl  as ToolImpl<Record<string, unknown>>,
  [safety_tool.name]:     safety_impl     as ToolImpl<Record<string, unknown>>,
  [technique_tool.name]:  technique_impl  as ToolImpl<Record<string, unknown>>,
  [suggest_tool.name]:    suggest_impl    as ToolImpl<Record<string, unknown>>,
  [substitute_tool.name]: substitute_impl as ToolImpl<Record<string, unknown>>,
  [diet_tool.name]:       diet_impl       as ToolImpl<Record<string, unknown>>,
  [knowledge_tool.name]:  knowledge_impl  as ToolImpl<Record<string, unknown>>,
  [ask_user_tool.name]:   ask_user_impl   as ToolImpl<Record<string, unknown>>,
}

// 重新导出交互式工具名称集合（供 agent.ts 使用）
export { INTERACTIVE_TOOL_NAMES }

// ─── 工具执行函数 ─────────────────────────────────────────

/**
 * 执行单个工具调用
 *
 * @param call  - LLM 请求的工具调用信息
 * @param sessionId - 当前会话 ID（用于日志）
 * @returns 工具执行结果
 */
export async function executeTool(call: ToolCall, sessionId: string): Promise<ToolResult> {
  const { id: _id, name, arguments: argsStr } = call

  console.info(`[Tools] 🔧 执行工具 [${sessionId}]：${name}`)
  console.debug(`[Tools] 📦 参数：${argsStr}`)

  const impl = TOOL_IMPLS[name]

  if (!impl) {
    console.error(`[Tools] ❌ 工具不存在：${name}`)
    return {
      success: false,
      error: `工具 "${name}" 不存在，请检查工具名称。`,
    }
  }

  // ── 解析参数 ──
  let args: Record<string, unknown>

  try {
    args = JSON.parse(argsStr)
  } catch {
    console.error(`[Tools] ❌ 参数解析失败：${argsStr}`)
    return {
      success: false,
      error: `工具参数格式错误，无法解析 JSON：${argsStr}`,
    }
  }

  // ── 执行工具 ──
  try {
    const result = await impl(args as Parameters<typeof impl>[0])
    console.info(
      `[Tools] ✅ 工具 ${name} 执行完成，耗时 ${result.duration ?? '?'}ms，成功：${result.success}`,
    )
    return result
  } catch (error) {
    console.error(`[Tools] ❌ 工具 ${name} 执行异常：`, error)
    return {
      success: false,
      error: (error as Error).message,
    }
  }
}

/**
 * 执行多个工具调用
 *
 * 场景：LLM 可能一次请求多个工具（parallel tool calls）
 * 会按顺序执行，返回结果数组（顺序与请求一致）
 *
 * @param calls - 工具调用列表
 * @param sessionId - 当前会话 ID
 */
export async function executeTools(
  calls: ToolCall[],
  sessionId: string,
): Promise<Array<{ id: string; result: ToolResult }>> {
  console.info(`[Tools] ⚡ 并行执行 ${calls.length} 个工具调用 [${sessionId}]`)

  const results = await Promise.all(
    calls.map(async (call) => ({
      id: call.id,
      result: await executeTool(call, sessionId),
    })),
  )

  const successCount = results.filter((r) => r.result.success).length
  console.info(`[Tools] 📊 工具执行统计：成功 ${successCount}/${calls.length}`)

  return results
}

// ─── 工具列表（供 Agent 直接引用）─────────────────────────
export { recipe_tool, nutrition_tool, safety_tool, technique_tool, suggest_tool, substitute_tool, diet_tool, knowledge_tool, ask_user_tool }
