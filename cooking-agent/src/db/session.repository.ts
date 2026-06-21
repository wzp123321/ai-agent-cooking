import { getPool } from './index'

/**
 * sessions 表行类型
 *
 * pending_interactive：存当前会话"待回答"的交互式工具列表（P1-4 改为数组）。
 *   典型结构（JSON 数组）：
 *     [
 *       { id, name, arguments, created_at },
 *       { id, name, arguments, created_at }
 *     ]
 *   - id        : 工具调用 ID（与 messages.tool_calls[].id 对应）
 *   - name      : 工具名（通常为 ask_user_choice）
 *   - arguments : 工具参数 JSON 字符串（保留 LLM 当初传入的完整参数）
 *   - created_at: 写入时间戳（用于排查卡死会话）
 *
 * 生命周期：
 *   - handleToolCalls 检测到 paused 时整体覆盖（支持多交互）
 *   - resumeInteractive 处理完一个后从数组中移除
 *   - chatStream 正常完成 / 中止时清除（保险）
 *   - 跨对话自然消失：clearSession 删 session 行
 *
 * 历史：
 *   - v1 (P0-2)：存单条 { id, name, arguments, created_at }
 *   - v2 (P1-4)：改为数组，支持 LLM 同轮调用多个 ask_user_choice
 */
export interface SessionRow {
  id: string
  title: string
  created_at: number
  updated_at: number
  pending_interactive: string | null
}

/**
 * 单个待回答的交互式工具信息
 */
export interface PendingInteractive {
  id: string
  name: string
  arguments: string
  created_at: number
}

export class SessionRepository {
  async create(id: string, title: string, now: number): Promise<SessionRow> {
    const pool = await getPool()
    await pool.execute(
      `INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      [id, title, now, now],
    )
    return { id, title, created_at: now, updated_at: now, pending_interactive: null }
  }

  async findById(id: string): Promise<SessionRow | undefined> {
    const pool = await getPool()
    const [rows] = await pool.execute(
      'SELECT * FROM sessions WHERE id = ?',
      [id],
    )
    const list = rows as SessionRow[]
    return list[0]
  }

  async findAll(): Promise<SessionRow[]> {
    const pool = await getPool()
    const [rows] = await pool.execute(
      'SELECT * FROM sessions ORDER BY updated_at DESC',
    )
    return rows as SessionRow[]
  }

  async updateTitle(id: string, title: string, now: number): Promise<void> {
    const pool = await getPool()
    await pool.execute(
      `UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`,
      [title, now, id],
    )
  }

  async touch(id: string, now: number): Promise<void> {
    const pool = await getPool()
    await pool.execute(
      'UPDATE sessions SET updated_at = ? WHERE id = ?',
      [now, id],
    )
  }

  async deleteById(id: string): Promise<boolean> {
    const pool = await getPool()
    const [result] = await pool.execute('DELETE FROM sessions WHERE id = ?', [id])
    return (result as any).affectedRows > 0
  }

  // ─── pending_interactive 字段管理（P0-2 新增，P1-4 改为数组）────

  /**
   * 写入/覆盖整个 pending_interactive 数组。
   * 在 handleToolCalls 检测到交互式工具暂停时调用。
   * 同一 session 多次暂停时直接覆盖（同一时刻只会有一个 pending 交互集合）。
   *
   * P1-4 改动：参数改为数组，支持 LLM 同轮调用多个 ask_user_choice。
   */
  async setPendingInteractiveList(id: string, pendingList: PendingInteractive[], now: number): Promise<void> {
    const pool = await getPool()
    await pool.execute(
      'UPDATE sessions SET pending_interactive = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(pendingList), now, id],
    )
  }

  /**
   * 兼容旧版：写入单条 pending（P0-2 行为）。
   * 实际内部仍存为数组（长度为 1），保证新旧逻辑统一。
   */
  async setPendingInteractive(id: string, pending: PendingInteractive, now: number): Promise<void> {
    return this.setPendingInteractiveList(id, [pending], now)
  }

  /**
   * 清除 pending_interactive。
   * 在以下场景调用：
   *   - resumeInteractive 成功完成（done / paused / fallback 任意分支）
   *   - chatStream 正常完成（保险）
   *   - clearSession 已被 deleteById 隐式清除
   */
  async clearPendingInteractive(id: string, now: number): Promise<void> {
    const pool = await getPool()
    await pool.execute(
      'UPDATE sessions SET pending_interactive = NULL, updated_at = ? WHERE id = ?',
      [now, id],
    )
  }

  /**
   * P1-4 引入：从 pending 数组中移除已回答的某项。
   *
   * 用法：
   *   - resumeInteractive 成功处理一个 interactiveId 后调用
   *   - 若移除后数组为空，则等价于 clear
   *
   * 为什么不直接 clear？
   *   - LLM 可能同轮调了 2 个 ask_user_choice
   *   - 用户先回答了第 1 个
   *   - 此时第 2 个仍是 pending，不能误清
   */
  async removePendingInteractive(id: string, targetId: string, now: number): Promise<void> {
    const list = await this.getPendingInteractiveList(id)
    if (list.length === 0) return
    const filtered = list.filter((p) => p.id !== targetId)
    if (filtered.length === 0) {
      await this.clearPendingInteractive(id, now)
    } else {
      await this.setPendingInteractiveList(id, filtered, now)
    }
  }

  /**
   * 读取整个 pending_interactive 数组。
   * 返回反序列化后的数组；若没有则返回 []。
   */
  async getPendingInteractiveList(id: string): Promise<PendingInteractive[]> {
    const row = await this.findById(id)
    if (!row || !row.pending_interactive) return []
    try {
      const parsed = JSON.parse(row.pending_interactive)
      if (Array.isArray(parsed)) return parsed as PendingInteractive[]
      // 兼容旧版（v1 单条对象）
      if (typeof parsed === 'object' && parsed !== null) return [parsed as PendingInteractive]
      return []
    } catch (err) {
      console.error(`[Session] ❌ 解析 pending_interactive 失败 [${id}]：`, (err as Error).message)
      return []
    }
  }

  /**
   * 兼容旧版：从数组中查第一个匹配的（用于 P0-2 兼容）。
   * 推荐改用 getPendingInteractiveList。
   */
  async getPendingInteractive(id: string): Promise<PendingInteractive | null> {
    const list = await this.getPendingInteractiveList(id)
    return list[0] ?? null
  }
}

export const sessionRepo = new SessionRepository()
