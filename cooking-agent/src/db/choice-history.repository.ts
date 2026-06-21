import { getPool } from './index'

/**
 * P1-7 新增：用户历史选择记录 Repository
 *
 * 用法：
 *   - 每次用户做出选择 → choiceRepo.insert(...)
 *   - 系统 prompt 构建时 → choiceRepo.getTopByCategory('diet', 3) → ["减脂 (5次)", "增肌 (2次)"]
 *   - 渲染交互卡片时   → choiceRepo.findSimilar(question) → 上次你选了 X
 */
export interface ChoiceHistoryRow {
  id: number
  session_id: string
  question: string
  category: string
  option: string
  chosen_at: number
}

export interface ChoiceStats {
  option: string
  count: number
  last_chosen_at: number
}

export class ChoiceHistoryRepository {
  async insert(row: Omit<ChoiceHistoryRow, 'id'>): Promise<void> {
    const pool = await getPool()
    await pool.execute(
      `INSERT INTO user_choice_history (session_id, question, category, option, chosen_at) VALUES (?, ?, ?, ?, ?)`,
      [row.session_id, row.question, row.category, row.option, row.chosen_at],
    )
  }

  /**
   * 按 category 聚合统计，limit 限制返回条数。
   * 典型用法：getTopByCategory('diet', 3)
   *   → [
   *       { option: '减脂', count: 5, last_chosen_at: 1716000000000 },
   *       { option: '增肌', count: 2, last_chosen_at: 1715900000000 }
   *     ]
   *
   * 注意：默认跨所有会话统计。如果只想看本会话，传 sessionId 参数。
   */
  async getTopByCategory(
    category: string,
    limit: number = 3,
    options?: { sessionId?: string; sinceTimestamp?: number },
  ): Promise<ChoiceStats[]> {
    if (!category) return []
    const pool = await getPool()
    const conditions: string[] = ['category = ?']
    const params: Array<string | number> = [category]

    if (options?.sessionId) {
      conditions.push('session_id = ?')
      params.push(options.sessionId)
    }
    if (typeof options?.sinceTimestamp === 'number') {
      conditions.push('chosen_at >= ?')
      params.push(options.sinceTimestamp)
    }

    params.push(limit)
    const [rows] = await pool.execute(
      `SELECT option, COUNT(*) AS cnt, MAX(chosen_at) AS last_chosen_at
       FROM user_choice_history
       WHERE ${conditions.join(' AND ')}
       GROUP BY option
       ORDER BY cnt DESC, last_chosen_at DESC
       LIMIT ?`,
      params,
    )
    return rows as ChoiceStats[]
  }

  /**
   * P3-13：跨会话聚合（排除当前 session）。
   *
   * 用途：让"用户过去在别的会话里选过什么"作为隐式偏好，
   *      不会污染当前会话的明确选择。
   *
   * 例如：当前 session 是"做减脂餐"，
   *      但用户在另一会话里常选"川菜" → 系统 prompt 提示
   *      "用户在其他场景下偏好：川菜(8次) — 适当尊重但不过度优先"
   */
  async getTopByCategoryAcrossSessions(
    category: string,
    excludeSessionId: string,
    limit: number = 3,
    options?: { sinceTimestamp?: number },
  ): Promise<ChoiceStats[]> {
    if (!category) return []
    const pool = await getPool()
    const conditions: string[] = ['category = ?', 'session_id != ?']
    const params: Array<string | number> = [category, excludeSessionId]

    if (typeof options?.sinceTimestamp === 'number') {
      conditions.push('chosen_at >= ?')
      params.push(options.sinceTimestamp)
    }

    params.push(limit)
    const [rows] = await pool.execute(
      `SELECT option, COUNT(*) AS cnt, MAX(chosen_at) AS last_chosen_at
       FROM user_choice_history
       WHERE ${conditions.join(' AND ')}
       GROUP BY option
       ORDER BY cnt DESC, last_chosen_at DESC
       LIMIT ?`,
      params,
    )
    return rows as ChoiceStats[]
  }

  /**
   * 查"相似问题"的历史选择。
   * 这里用 LIKE 模糊匹配 question 前 30 字符作为简化方案，
   * 后续可改为向量检索。
   */
  async findSimilar(question: string, limit: number = 1): Promise<ChoiceHistoryRow[]> {
    if (!question) return []
    const pool = await getPool()
    const prefix = question.slice(0, 30).replace(/[%_]/g, '\\$&')
    const [rows] = await pool.execute(
      `SELECT * FROM user_choice_history
       WHERE question LIKE ?
       ORDER BY chosen_at DESC
       LIMIT ?`,
      [`${prefix}%`, limit],
    )
    return rows as ChoiceHistoryRow[]
  }

  /**
   * 清理过期记录（保留最近 90 天）
   * 建议每月定时跑一次（不在此处自动调用）。
   */
  async cleanOld(beforeTimestamp: number): Promise<number> {
    const pool = await getPool()
    const [result] = await pool.execute(
      `DELETE FROM user_choice_history WHERE chosen_at < ?`,
      [beforeTimestamp],
    )
    return (result as any).affectedRows
  }
}

export const choiceRepo = new ChoiceHistoryRepository()
