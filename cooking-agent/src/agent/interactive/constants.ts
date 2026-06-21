/**
 * ============================================================
 * interactive/constants.ts — 交互式工具的常量/白名单（单一真理源）
 * ============================================================
 *
 * P-1：消除 agent.ts 中"两处白名单硬编码"问题。
 *   - 原本 allowedCategories / allowedTypes 在 parseInteractiveArgs() 和
 *     resumeInteractive() 中各写了一份，新增 type 时容易漏改。
 *   - 现统一在此处定义常量与 Set，前后引用。
 *
 * 涉及字段：
 *   - 类别白名单（category）：用于历史偏好聚合
 *   - 类型白名单（type）：决定前端渲染方式
 *   - skip 哨兵：用户选择"跳过此交互"时的特殊值
 *   - 多选上限：LLM 未声明时的兜底上限
 */

// ─── 类别白名单 ───────────────────────────────────────────

/** 类别：用于历史选择聚合（'allergy' = 过敏回避，'' = 一次性/无法分类） */
export const ALLOWED_CATEGORIES: ReadonlySet<string> = new Set([
  '',
  'diet',
  'cuisine',
  'taste',
  'skill',
  'scene',
  'allergy',
])

// ─── 类型白名单 ───────────────────────────────────────────

/** 交互类型：决定前端渲染方式 */
export const INTERACTIVE_TYPES = ['choice', 'text', 'confirm', 'slider'] as const
export type InteractiveType = (typeof INTERACTIVE_TYPES)[number]

/** 交互类型白名单 Set（运行时校验用） */
export const ALLOWED_INTERACTIVE_TYPES: ReadonlySet<string> = new Set(INTERACTIVE_TYPES)

// ─── 跳过的哨兵值 ──────────────────────────────────────────

/**
 * 用户选择"跳过此交互，让 AI 自己决定"时传递的特殊值
 *
 * 含义：
 *   - P1-5 引入
 *   - 仅在 choice 模式生效（text/slider/confirm 不允许跳过）
 *   - 校验时跳过 options 比对
 *   - 写入 history 时也跳过（避免"跳过"污染统计）
 */
export const SKIP_SENTINEL = '__skip__'

// ─── 多选上限 ─────────────────────────────────────────────

/**
 * 多选硬上限（防御 LLM 没在 args 里声明时无限选）
 * 实际产品里 4-5 个已经足够，过多会破坏 UI
 */
export const MAX_MULTI_SELECT = 4

// ─── 图片 URL 白名单正则 ──────────────────────────────────

/** P2-10：option_images URL 白名单（仅允许 https 与 data:image 内联） */
export const OPTION_IMAGE_URL_REGEX = /^(https:\/\/|data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,)/i

// ─── validation 限制 ──────────────────────────────────────

/** P2-11：validation.regex 长度上限（防 ReDoS） */
export const MAX_REGEX_LENGTH = 200
