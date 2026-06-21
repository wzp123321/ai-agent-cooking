/**
 * ============================================================
 * preferences/categories.ts — 偏好类别定义
 * ============================================================
 *
 * 单一真理源：
 *   - 在 system prompt 中注入偏好时使用
 *   - 在 choice-history 聚合时使用
 *   - 增加新类别时只需改这里
 *
 * 行为：
 *   - key  : 数据库 category 字段值（小写英文）
 *   - label: 中文友好名称（用于提示 LLM）
 */

export interface CategoryDef {
  key: string
  label: string
}

export const PREFERENCE_CATEGORIES: readonly CategoryDef[] = [
  { key: 'diet', label: '饮食目标' },
  { key: 'cuisine', label: '菜系偏好' },
  { key: 'taste', label: '口味偏好' },
  { key: 'skill', label: '技能等级' },
  { key: 'scene', label: '用餐场景' },
  { key: 'allergy', label: '过敏回避' },
] as const

/** 90 天时间窗口（毫秒）— 避免远古数据干扰当前推荐 */
export const PREFERENCE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000
