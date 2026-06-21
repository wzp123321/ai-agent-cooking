/**
 * ============================================================
 * interactive/parser.ts — 解析 ask_user_choice 的 LLM 参数
 * ============================================================
 *
 * 行为：把 LLM 返回的 JSON 字符串解析为结构化 InteractiveRequest
 *   - 容错：参数缺失、JSON 解析失败、字段类型错误时降级处理
 *   - 白名单：category / type / option_images / validation 全部走白名单
 *   - 防御性：ReDoS、长正则、矛盾约束全部拦截
 *
 * 注意：原 agent.ts 中有两处几乎重复的解析逻辑（parseInteractiveArgs 与
 *      resumeInteractive 中的内联解析）。此文件作为单一解析入口。
 */

import type { InteractiveRequest, RawInteractiveArgs } from './schema'
import {
  ALLOWED_CATEGORIES,
  ALLOWED_INTERACTIVE_TYPES,
  OPTION_IMAGE_URL_REGEX,
  MAX_REGEX_LENGTH,
  type InteractiveType,
} from './constants'

/**
 * 解析 ask_user_choice 的参数为结构化 InteractiveRequest
 *
 * @returns 成功返回 InteractiveRequest；解析失败或参数无效返回 null
 */
export function parseInteractiveArgs(id: string, argsStr: string): InteractiveRequest | null {
  let args: RawInteractiveArgs
  try {
    args = JSON.parse(argsStr) as RawInteractiveArgs
  } catch (err) {
    console.error(`[Agent] ❌ 解析交互式工具参数失败 [${id}]：`, (err as Error).message)
    return null
  }

  // ── 基础字段 ──
  const question = typeof args.question === 'string' ? args.question : '请选择'
  const options = Array.isArray(args.options)
    ? args.options.filter((o): o is string => typeof o === 'string')
    : []
  const multiSelect = args.multi_select === true

  // ── category 白名单 ──
  const category = typeof args.category === 'string' && ALLOWED_CATEGORIES.has(args.category)
    ? args.category
    : ''

  // ── type 白名单 ──
  const type: InteractiveType = ALLOWED_INTERACTIVE_TYPES.has(args.type as string)
    ? (args.type as InteractiveType)
    : 'choice'

  // ── meta：仅在 type 生效时记录 ──
  const meta = (type !== 'choice' && typeof args.meta === 'object' && args.meta !== null)
    ? args.meta
    : {}

  // ── optionImages：仅 type=choice 时生效，URL 白名单校验 ──
  const optionImages: (string | null)[] = options.map(() => null)
  if (type === 'choice' && Array.isArray(args.option_images)) {
    const imgs = args.option_images
    for (let i = 0; i < options.length && i < imgs.length; i++) {
      const url = imgs[i]
      if (typeof url === 'string' && OPTION_IMAGE_URL_REGEX.test(url)) {
        optionImages[i] = url
      }
    }
  }

  // ── validation：仅 type=text 时生效，防御 ReDoS 与矛盾约束 ──
  const validation: InteractiveRequest['validation'] = {}
  if (type === 'text' && typeof args.validation === 'object' && args.validation !== null) {
    const v = args.validation

    if (typeof v.regex === 'string' && v.regex.length > 0 && v.regex.length <= MAX_REGEX_LENGTH) {
      try {
        new RegExp(v.regex)
        validation.regex = v.regex
      } catch {
        console.warn(`[Agent] ⚠️ validation.regex 非法，已丢弃：${v.regex}`)
      }
    }
    if (typeof v.min_length === 'number' && v.min_length >= 0) {
      validation.minLength = Math.floor(v.min_length)
    }
    if (typeof v.max_length === 'number' && v.max_length > 0) {
      validation.maxLength = Math.floor(v.max_length)
    }
    if (
      validation.minLength !== undefined &&
      validation.maxLength !== undefined &&
      validation.maxLength < validation.minLength
    ) {
      // 自相矛盾的约束，全部丢弃
      delete validation.minLength
      delete validation.maxLength
    }
  }

  // ── 按 type 分支返回结构化请求 ──
  if (type === 'choice') {
    if (options.length === 0) {
      console.warn(`[Agent] ⚠️ 交互式工具 ${id} 选项为空，跳过`)
      return null
    }
    return { id, question, options, multiSelect, category, type, meta, optionImages, validation: {} }
  }

  if (type === 'confirm') {
    return {
      id, question, options: ['确认', '取消'], multiSelect: false, category, type, meta,
      optionImages: [null, null],
      validation: {},
    }
  }

  if (type === 'slider') {
    const min = typeof meta.min === 'number' ? meta.min : 0
    const max = typeof meta.max === 'number' ? meta.max : 100
    if (max <= min) {
      console.warn(`[Agent] ⚠️ slider 工具 ${id} 的 min/max 非法（min=${min}, max=${max}），跳过`)
      return null
    }
    return {
      id, question, options: [], multiSelect: false, category, type,
      meta: { min, max, step: meta.step ?? 1, default: meta.default ?? min, unit: meta.unit ?? '' },
      optionImages: [],
      validation: {},
    }
  }

  // type === 'text'
  return {
    id, question, options: [], multiSelect: false, category, type,
    meta: {
      placeholder: typeof meta.placeholder === 'string' ? meta.placeholder : '',
      maxLength: typeof meta.maxLength === 'number' ? meta.maxLength : 200,
    },
    optionImages: [],
    validation,
  }
}
