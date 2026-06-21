/**
 * ============================================================
 * interactive/validator.ts — 校验用户对交互式工具的答案
 * ============================================================
 *
 * 行为：按 type 分支校验 choice 数组
 *   - choice : 必须在原 options 中
 *   - text   : 单个字符串、长度符合 validation
 *   - slider : 单个数值，落在 [min, max] 范围内
 *   - confirm: 必须是 '确认' 或 '取消'
 *
 * 特殊值 SKIP_SENTINEL：跳过校验
 *   - 仅在 choice 模式下生效
 *   - 校验逻辑里 isSkip=true 时直接 return，不做任何检查
 *   - 调用方负责把它转换为 { user_choice: null, skipped: true }
 *
 * 设计：
 *   - 校验失败抛 Error，由 SSE 流 emit error 事件
 *   - 校验成功：返回 void
 *   - 不返回 parsed 值（parsed 值与 choice 数组相同）
 */

import type { InteractiveRequest } from './schema'
import { SKIP_SENTINEL, MAX_MULTI_SELECT } from './constants'

/**
 * 校验用户选择是否有效
 *
 * @param choice   - 前端回传的选项（字符串数组）
 * @param request  - 原始 InteractiveRequest
 * @throws Error 当 choice 校验失败
 */
export function validateChoice(choice: string[], request: InteractiveRequest): void {
  const isSkip = choice.length === 1 && choice[0] === SKIP_SENTINEL
  if (isSkip) {
    // 跳过不校验任何项
    return
  }

  if (choice.length === 0) {
    throw new Error('choice 不能为空（若想跳过请传 ["__skip__"]）')
  }

  switch (request.type) {
    case 'text':
      validateTextChoice(choice, request)
      return
    case 'slider':
      validateSliderChoice(choice, request)
      return
    case 'confirm':
      validateConfirmChoice(choice)
      return
    case 'choice':
    default:
      validateChoiceList(choice, request)
      return
  }
}

// ─── type=text 校验 ───────────────────────────────────────

function validateTextChoice(choice: string[], request: InteractiveRequest): void {
  if (choice.length > 1) {
    throw new Error('text 类型只能接受 1 个输入')
  }
  const text = choice[0]
  if (typeof text !== 'string') {
    throw new Error('text 类型必须是字符串')
  }

  const maxLength = typeof request.meta.maxLength === 'number' ? request.meta.maxLength : 200
  if (text.length > maxLength) {
    throw new Error(`text 类型超过最大长度 ${maxLength}（实际 ${text.length}）`)
  }

  if (request.validation.minLength !== undefined && text.length < request.validation.minLength) {
    throw new Error(`text 长度不足 ${request.validation.minLength}（实际 ${text.length}）`)
  }
  if (request.validation.maxLength !== undefined && text.length > request.validation.maxLength) {
    throw new Error(`text 长度超限 ${request.validation.maxLength}（实际 ${text.length}）`)
  }
  if (request.validation.regex !== undefined) {
    try {
      const re = new RegExp(request.validation.regex)
      if (!re.test(text)) {
        throw new Error(`text 不符合格式 ${request.validation.regex}`)
      }
    } catch (e) {
      // 校验逻辑自身失败时，记录但不阻塞（防御性）
      if (e instanceof Error && e.message.startsWith('text ')) throw e
      console.warn(`[Agent] ⚠️ validation.regex 应用失败：${(e as Error).message}`)
    }
  }
}

// ─── type=slider 校验 ─────────────────────────────────────

function validateSliderChoice(choice: string[], request: InteractiveRequest): void {
  if (choice.length > 1) {
    throw new Error('slider 类型只能接受 1 个值')
  }
  const val = Number(choice[0])
  if (Number.isNaN(val)) {
    throw new Error('slider 类型必须是数字')
  }
  const min = typeof request.meta.min === 'number' ? request.meta.min : 0
  const max = typeof request.meta.max === 'number' ? request.meta.max : 100
  if (val < min || val > max) {
    throw new Error(`slider 类型值 ${val} 超出范围 [${min}, ${max}]`)
  }
}

// ─── type=confirm 校验 ────────────────────────────────────

function validateConfirmChoice(choice: string[]): void {
  if (choice.length > 1 || !['确认', '取消'].includes(choice[0])) {
    throw new Error('confirm 类型只能选 [确认] 或 [取消]')
  }
}

// ─── type=choice 校验 ─────────────────────────────────────

function validateChoiceList(choice: string[], request: InteractiveRequest): void {
  // 单选限制
  if (!request.multiSelect && choice.length > 1) {
    throw new Error(`该问题为单选（multiSelect=false），但收到 ${choice.length} 个选项`)
  }
  // 多选上限
  if (request.multiSelect && choice.length > MAX_MULTI_SELECT) {
    throw new Error(`多选上限为 ${MAX_MULTI_SELECT} 项，收到 ${choice.length} 个选项`)
  }
  // 选项必须在原列表中
  for (const c of choice) {
    if (typeof c !== 'string' || !request.options.includes(c)) {
      throw new Error(
        `choice 包含无效选项：${JSON.stringify(c)}。可选：${JSON.stringify(request.options)}`,
      )
    }
  }
  // 去重
  if (new Set(choice).size !== choice.length) {
    throw new Error('choice 包含重复项')
  }
}
