/**
 * ============================================================
 * preferences/prompt.ts — 构造"用户偏好历史"段，注入 system prompt
 * ============================================================
 *
 * 行为：
 *   - 本会话：getTopByCategory({sessionId}) — 反映用户在当前会话已表达的偏好
 *   - 跨会话：getTopByCategoryAcrossSessions() — 反映用户在其他会话的历史习惯
 *   - 时间窗口：默认 90 天（避免远古数据干扰）
 *
 * 输出示例：
 *   "\n\n## 用户偏好历史\n本会话：\n- 饮食目标：减脂(2次), 控糖(1次)\n\n跨会话（仅供参考）：\n- 菜系偏好：川菜(8次), 粤菜(3次)"
 *
 * 注意事项：
 *   - 不在这里做"个性化过滤"——只把数据交给 LLM，由 LLM 决定如何利用
 *   - 拼接到 system prompt 而非 user prompt，避免污染用户消息历史
 *   - 跨会话部分加"仅供参考"标签，避免 LLM 把历史偏好当成当前命令
 */

import { choiceRepo } from '../../db/choice-history.repository'
import { PREFERENCE_CATEGORIES, PREFERENCE_WINDOW_MS } from './categories'

/**
 * 构造"用户偏好历史"段。
 *
 * @param sessionId 当前会话 ID
 * @returns  拼接好的 prompt 片段（若无任何偏好则返回空字符串）
 */
export async function buildPreferencesPrompt(sessionId: string): Promise<string> {
  const ninetyDaysAgo = Date.now() - PREFERENCE_WINDOW_MS

  const sessionLines: string[] = []
  const crossLines: string[] = []

  for (const cat of PREFERENCE_CATEGORIES) {
    try {
      // 本会话
      const sessionTop = await choiceRepo.getTopByCategory(cat.key, 3, {
        sessionId,
        sinceTimestamp: ninetyDaysAgo,
      })
      if (sessionTop.length > 0) {
        const items = sessionTop
          .filter((s) => s.count > 0)
          .map((s) => `${s.option}(${s.count}次)`)
          .join(', ')
        if (items) sessionLines.push(`- ${cat.label}：${items}`)
      }

      // 跨会话（排除当前 session）
      const crossTop = await choiceRepo.getTopByCategoryAcrossSessions(
        cat.key,
        sessionId,
        3,
        { sinceTimestamp: ninetyDaysAgo },
      )
      if (crossTop.length > 0) {
        const items = crossTop
          .filter((s) => s.count > 0)
          .map((s) => `${s.option}(${s.count}次)`)
          .join(', ')
        if (items) crossLines.push(`- ${cat.label}：${items}`)
      }
    } catch (err) {
      console.warn(`[Agent] ⚠️ 查询偏好 [${cat.key}] 失败：`, (err as Error).message)
    }
  }

  const parts: string[] = []
  if (sessionLines.length > 0) {
    parts.push('本会话：\n' + sessionLines.join('\n'))
  }
  if (crossLines.length > 0) {
    parts.push('跨会话（仅供参考）：\n' + crossLines.join('\n'))
  }

  if (parts.length === 0) return ''
  return '\n\n## 用户偏好历史\n' + parts.join('\n\n')
}
