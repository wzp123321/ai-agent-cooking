import { getPool } from './index'
import type { Message } from '../types'

export interface MessageRow {
  id: number
  session_id: string
  role: string
  content: string
  tool_call_id: string | null
  tool_calls: string | null
  created_at: number
}

export class MessageRepository {
  async insert(sessionId: string, msg: Message, now: number): Promise<MessageRow> {
    const pool = await getPool()
    const toolCallsJson = msg.tool_calls ? JSON.stringify(msg.tool_calls) : null
    const [result] = await pool.execute(
      `INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [sessionId, msg.role, msg.content, msg.tool_call_id ?? null, toolCallsJson, now],
    )
    return {
      id: (result as any).insertId as number,
      session_id: sessionId,
      role: msg.role,
      content: msg.content,
      tool_call_id: msg.tool_call_id ?? null,
      tool_calls: toolCallsJson,
      created_at: now,
    }
  }

  async findBySessionId(sessionId: string): Promise<MessageRow[]> {
    const pool = await getPool()
    const [rows] = await pool.execute(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC',
      [sessionId],
    )
    return rows as MessageRow[]
  }

  async findHistoryBySessionId(sessionId: string): Promise<Message[]> {
    const rows = await this.findBySessionId(sessionId)
    return rows
      .filter((r) => r.role !== 'system')
      .map((r) => ({
        role: r.role as Message['role'],
        content: r.content,
        tool_call_id: r.tool_call_id ?? undefined,
        tool_calls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined,
      }))
  }

  async deleteBySessionId(sessionId: string): Promise<number> {
    const pool = await getPool()
    const [result] = await pool.execute(
      'DELETE FROM messages WHERE session_id = ?',
      [sessionId],
    )
    return (result as any).affectedRows
  }

  async countBySessionId(sessionId: string): Promise<number> {
    const pool = await getPool()
    const [rows] = await pool.execute(
      'SELECT COUNT(*) as cnt FROM messages WHERE session_id = ? AND role != ?',
      [sessionId, 'system'],
    )
    const list = rows as Array<{ cnt: number }>
    return list[0].cnt
  }

  /**
   * P1-6：统计会话历史中已下发的交互式工具数量。
   * 通过 assistant 消息中 tool_calls 包含 ask_user_choice 来计数。
   * 用于计算 interactive round。
   */
  async countInteractiveToolCalls(sessionId: string): Promise<number> {
    const pool = await getPool()
    const [rows] = await pool.execute(
      `SELECT tool_calls FROM messages WHERE session_id = ? AND role = 'assistant' AND tool_calls IS NOT NULL`,
      [sessionId],
    )
    const list = rows as Array<{ tool_calls: string }>
    let count = 0
    for (const row of list) {
      try {
        const tcs = JSON.parse(row.tool_calls) as Array<{ function?: { name?: string } }>
        if (tcs.some((tc) => tc.function?.name === 'ask_user_choice')) {
          count++
        }
      } catch { /* 忽略非法 JSON */ }
    }
    return count
  }

  /**
   * P3-15：查找最近一次"已回答"的交互式工具对。
   *
   * 匹配规则（从新到旧）：
   *   - 找到一条 role='assistant' 的消息，其 tool_calls 包含 ask_user_choice
   *   - 该消息之后紧跟一条 role='tool' 的消息，tool_call_id 对应该 ask_user_choice 的 id
   *
   * 返回：{ assistantId, toolId, interactiveId } 或 null
   *   注意：可能存在多个 ask_user_choice 在同一条 assistant 消息中（P1-4 多交互并行），
   *        返回最后一个（id 最大）以支持"撤销最后选择"。
   */
  async findLastAnsweredInteractive(sessionId: string): Promise<{
    assistantId: number
    toolId: number
    interactiveId: string
  } | null> {
    const pool = await getPool()
    // 找到所有 assistant 消息含 ask_user_choice 的，按 created_at DESC 取最新
    const [assistantRows] = await pool.execute(
      `SELECT id, tool_calls, created_at FROM messages
       WHERE session_id = ? AND role = 'assistant' AND tool_calls IS NOT NULL
       ORDER BY created_at DESC, id DESC LIMIT 50`,
      [sessionId],
    )
    const assistants = assistantRows as Array<{ id: number; tool_calls: string; created_at: number }>

    for (const a of assistants) {
      let tcs: Array<{ id?: string; function?: { name?: string } }> = []
      try {
        tcs = JSON.parse(a.tool_calls)
      } catch {
        continue
      }
      // 仅看 ask_user_choice
      const askTcs = tcs.filter((tc) => tc.function?.name === 'ask_user_choice' && typeof tc.id === 'string')
      if (askTcs.length === 0) continue

      // 检查每条 ask_user_choice 是否已有对应的 tool 消息
      for (let i = askTcs.length - 1; i >= 0; i--) {
        const askId = askTcs[i].id!
        const [toolRows] = await pool.execute(
          `SELECT id FROM messages
           WHERE session_id = ? AND role = 'tool' AND tool_call_id = ?
           ORDER BY id DESC LIMIT 1`,
          [sessionId, askId],
        )
        const toolList = toolRows as Array<{ id: number }>
        if (toolList.length > 0) {
          return {
            assistantId: a.id,
            toolId: toolList[0].id,
            interactiveId: askId,
          }
        }
      }
    }
    return null
  }

  /**
   * P-修复：判断指定 session 中是否存在某 tool_call_id 对应的 assistant(tool_calls) 消息。
   * 用于 timeout-watcher 在补 tool 消息前先确保成对存在。
   */
  async hasAssistantToolCall(sessionId: string, toolCallId: string): Promise<boolean> {
    const pool = await getPool()
    const [rows] = await pool.execute(
      `SELECT COUNT(*) as cnt FROM messages
       WHERE session_id = ? AND role = 'assistant' AND tool_calls IS NOT NULL
         AND JSON_SEARCH(tool_calls, 'one', ?) IS NOT NULL`,
      [sessionId, toolCallId],
    )
    const list = rows as Array<{ cnt: number }>
    return list[0]?.cnt > 0
  }

  /**
   * P-修复：更新某条 tool 消息的内容（用 tool_call_id 定位）。
   * 用于 resumeInteractive 把"占位 tool 消息"更新为"用户选择结果"，
   * 严格保持 assistant(tool_calls) 与 tool 消息的 1对1 关系（OpenAI 协议要求）。
   *
   * @returns 实际更新的行数（0 表示占位消息不存在，可能要走 insert 兜底）
   */
  async updateToolContentByCallId(
    sessionId: string,
    toolCallId: string,
    newContent: string,
    now: number,
  ): Promise<number> {
    const pool = await getPool()
    const [result] = await pool.execute(
      `UPDATE messages
       SET content = ?, created_at = ?
       WHERE session_id = ? AND role = 'tool' AND tool_call_id = ?`,
      [newContent, now, sessionId, toolCallId],
    )
    return (result as any).affectedRows as number
  }

  /**
   * P3-15：删除指定消息。
   */
  async deleteById(messageId: number): Promise<boolean> {
    const pool = await getPool()
    const [result] = await pool.execute(
      'DELETE FROM messages WHERE id = ?',
      [messageId],
    )
    return ((result as any).affectedRows) > 0
  }
}

export const messageRepo = new MessageRepository()
