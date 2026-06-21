import { getPool } from './index'

const SCHEMAS = [
  `CREATE TABLE IF NOT EXISTS sessions (
    id         VARCHAR(36) PRIMARY KEY,
    title      VARCHAR(255) NOT NULL DEFAULT '新对话',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS messages (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    session_id   VARCHAR(36) NOT NULL,
    role         VARCHAR(20) NOT NULL,
    content      TEXT NOT NULL,
    tool_call_id VARCHAR(255) DEFAULT NULL,
    tool_calls   TEXT DEFAULT NULL,
    created_at   BIGINT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    INDEX idx_messages_session (session_id, created_at),
    CONSTRAINT chk_role CHECK (role IN ('system','user','assistant','tool'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS user_profiles (
    id           VARCHAR(36) PRIMARY KEY DEFAULT 'default',
    allergies    TEXT,
    diet_type    VARCHAR(100) DEFAULT '',
    skill_level  VARCHAR(20) DEFAULT 'intermediate',
    disliked     TEXT,
    calorie_goal INT DEFAULT 0,
    created_at   BIGINT NOT NULL,
    updated_at   BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  /**
   * P1-7 新增：用户历史选择记录
   *
   * 用途：让 LLM 知道"用户以前总是选 X" → 主动给出个性化推荐
   *
   * 字段设计：
   *   - session_id  : 关联到具体会话（不直接关联 user，因为现在是单用户）
   *   - question    : 原始问题文本（用于"同问题优先推荐"）
   *   - category    : 问题类别（"diet" / "cuisine" / "skill" / "taste"），由 LLM 在 system prompt 中给出
   *                   留空表示未分类
   *   - option      : 用户选择的选项文本
   *   - chosen_at   : 时间戳
   *
   * 索引：
   *   - 复合 (category, option) 用于快速查"某类别下选 X 的次数"
   *   - 单独 chosen_at 用于按时间窗口过滤（最近 30 天）
   */
  `CREATE TABLE IF NOT EXISTS user_choice_history (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    session_id VARCHAR(36) NOT NULL,
    question   TEXT NOT NULL,
    category   VARCHAR(50) DEFAULT '',
    \`option\`   VARCHAR(255) NOT NULL,
    chosen_at  BIGINT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    INDEX idx_choice_category_option (category, \`option\`),
    INDEX idx_choice_question (question(100)),
    INDEX idx_choice_time (chosen_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
]

export async function runMigrations(): Promise<void> {
  const pool = await getPool()

  for (const sql of SCHEMAS) {
    await pool.execute(sql)
  }

  // 历史 ALTER（保留兼容性）
  const [cols] = await pool.execute('SHOW COLUMNS FROM messages') as [Array<{ Field: string }>, unknown]
  if (!cols.some((c) => c.Field === 'tool_calls')) {
    await pool.execute('ALTER TABLE messages ADD COLUMN tool_calls TEXT')
    console.info('[DB] ✅ 新增 messages.tool_calls 列')
  }

  /**
   * 新增 sessions.pending_interactive 列 — P0-2 修复：上下文截断保护
   *
   * 背景：
   *   旧实现中 `resumeInteractive` 仅在 messages 数组里反查 interactiveId。
   *   当 LLM 调起 ask_user_choice → 用户等 10 分钟 → 期间对话被截断 →
   *   assistant(tool_calls) 消息被移出 → 续点时找不到 → 抛"会话已过期"。
   *
   * 设计：
   *   - 列存 JSON：{ id, name, arguments, created_at }
   *   - handleToolCalls 检测到 paused 时写入
   *   - resumeInteractive 成功完成后清除
   *   - chatStream 正常完成时清除（保险）
   *   - 续点时先查 messages，找不到再回退到本字段
   *
   * 为什么不直接用普通 VARCHAR 存 interactiveId？
   *   resumeInteractive 需要 tool_call.arguments 才能继续拼接 tool 消息，
   *   所以必须存完整结构 → JSON 字段。
   */
  const [sessionCols] = await pool.execute('SHOW COLUMNS FROM sessions') as [Array<{ Field: string }>, unknown]
  if (!sessionCols.some((c) => c.Field === 'pending_interactive')) {
    await pool.execute('ALTER TABLE sessions ADD COLUMN pending_interactive TEXT DEFAULT NULL')
    console.info('[DB] ✅ 新增 sessions.pending_interactive 列')
  }

  console.info('[DB] ✅ 数据库迁移完成')
}
