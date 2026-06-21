/**
 * ============================================================
 * CookingAgent — 智能体核心类（数据库持久化版）
 * ============================================================
 *
 * ┌──────────────────────────────────────────────────────┐
 * │                   ReAct 推理循环                      │
 * │  ① Thought  →  分析用户意图，决定下一步行动          │
 * │  ② Action   →  调用工具（或直接回答）               │
 * │  ③ Observe  →  获取工具返回结果                     │
 * │  ④ Loop     →  重复直到有足够信息给出完整回答       │
 * │  ⑤ Answer   →  综合所有信息，给出最终回答           │
 * └──────────────────────────────────────────────────────┘
 *
 * 持久化策略：
 *   - 每次请求从 DB 加载历史消息到内存
 *   - ReAct 循环中每追加一条消息，同步写入 DB
 *   - 会话元信息（标题、时间戳）存储在 sessions 表
 *
 * 容错机制：
 *   - LLM 调用失败自动重试（最多 3 次，指数退避）
 *   - 工具调用失败不中断流程，继续推理
 */

import 'dotenv/config'
import { buildSystemMessage } from './prompts'
import { TOOL_LIST, executeTools, INTERACTIVE_TOOL_NAMES } from './tools'
import { sessionRepo } from './db/session.repository'
import { messageRepo } from './db/message.repository'
import { userProfileRepo } from './db/user-profile.repository'
import { choiceRepo } from './db/choice-history.repository'
import { getProvider, type LLMProvider } from './llm'
import type { Message, ChatResult } from './types'
import type { ToolCall, ReActStep } from './tools/types'
import type { ChatCompletionResult } from './llm/types'
import { parseInteractiveArgs, validateChoice, SKIP_SENTINEL } from './agent/interactive'
import type { InteractiveRequest } from './agent/interactive'
import { buildPreferencesPrompt } from './agent/preferences'
import { runReActLoop, type ReActLoopResult } from './agent/react-loop'
import { finalize } from './agent/stream-finalizer'

// 重新导出交互式类型给上层使用
export type { InteractiveRequest, InteractiveRequestEvent, InteractiveType } from './agent/interactive'

/**
 * 兼容：以下类型/接口已迁移到 agent/interactive 模块
 *   - InteractiveType           → agent/interactive/constants.ts
 *   - InteractiveRequest        → agent/interactive/schema.ts
 *   - parseInteractiveArgs()    → agent/interactive/parser.ts
 *   - validateChoice()          → agent/interactive/validator.ts
 *
 * 这里不再重复定义，从 './agent/interactive' 导入。
 *
 * P-重构：以下逻辑已拆出 agent.ts
 *   - 后台超时清理：   agent/timeout-watcher.ts
 *   - ReAct 循环体：   agent/react-loop.ts
 *   - 流式收尾：       agent/stream-finalizer.ts
 */

const MAX_REACT_STEPS = 5
const MAX_RETRIES = 3

/**
 * LLM 上下文窗口上限（消息条数）
 *
 * DeepSeek 上下文 ~128K tokens。单条消息平均 ~800 tokens（含系统提示），
 * 40 条约 32K tokens，在窗口内留足工具调用和回答的余量。
 *
 * 超出此数量时，只保留 system + 最近 40 条消息，
 * 在 system 后插入一条摘要消息说明上下文已被截断。
 */
const MAX_CONTEXT_MESSAGES = 40
const RETRY_BASE_DELAY_MS = 500

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildToolsParam() {
  return TOOL_LIST.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as unknown as Record<string, unknown>,
    },
  }))
}

export class CookingAgent {
  private readonly llm: LLMProvider

  constructor() {
    this.llm = getProvider()

    console.info(`[CookingAgent] 🤖 模型：${this.llm.model} (${this.llm.name})`)
    console.info(`[CookingAgent] 🛠️  已注册工具：${TOOL_LIST.map((t) => t.name).join('、')}`)
    console.info('[CookingAgent] 💾 持久化：MySQL (localhost:3306/cooking)')
    console.log('[CookingAgent] ✅ CookingAgent 构造完成')
  }

  // ─── 会话管理 ────────────────────────────────────────────

  private async loadMessages(sessionId: string): Promise<Message[]> {
    const now = Date.now()

    if (!(await sessionRepo.findById(sessionId))) {
      console.info(`[Session] 🆕 新建会话 ${sessionId}`)
      await sessionRepo.create(sessionId, '新对话', now)

      const profilePrompt = await userProfileRepo.buildProfilePrompt()
      const preferencesPrompt = await buildPreferencesPrompt(sessionId)
      const systemContent = buildSystemMessage() + profilePrompt + preferencesPrompt

      const systemMsg: Message = { role: 'system', content: systemContent }
      await messageRepo.insert(sessionId, systemMsg, now)
      return [systemMsg]
    }

    const rows = await messageRepo.findBySessionId(sessionId)
    const rawMessages: Message[] = rows.map((r) => ({
      role: r.role as Message['role'],
      content: r.content,
      tool_call_id: r.tool_call_id ?? undefined,
      tool_calls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined,
    }))

    /**
     * P-修复-2：处理 assistant(tool_calls) 缺失 tool 响应的情况。
     *
     * 背景：pre-fix 时代 `handleToolCalls` 只持久化 assistant 消息（带 N 个
     * tool_calls）但 0 条 tool 消息。修复后的版本会写占位 tool 消息，
     * 但**历史脏数据**（pre-fix 时代创建的 session）里已经有 N 个 tool_calls
     * 但 0 条 tool 响应的 assistant 消息。
     *
     * 症状：用户复用这类老 session 时，第一次 LLM 调用即报 400：
     *   "An assistant message with 'tool_calls' must be followed by tool
     *    messages responding to each 'tool_call_id'."
     *
     * 修复：在 loadMessages 阶段，对每条 assistant(tool_calls) 消息扫描其后的
     * tool 响应（直到下一个 assistant/user），缺失的 tool_call_id 在内存中
     * 合成占位 tool 消息插入。**DB 不动**（保留前端 UI 状态，脏数据后续
     * 一次性迁移脚本清理）。
     */
    const seenToolCallIds = new Set<string>()
    const messages: Message[] = []
    let dropped = 0
    let synthesized = 0
    for (const m of rawMessages) {
      if (m.role === 'assistant' && m.tool_calls) {
        for (const tc of m.tool_calls) seenToolCallIds.add(tc.id)
      }
      if (m.role === 'tool' && m.tool_call_id && !seenToolCallIds.has(m.tool_call_id)) {
        dropped++
        continue
      }
      messages.push(m)

      // 检查这条 assistant 消息之后是否所有 tool_call 都有响应，
      // 缺失则在内存中合成占位 tool 消息。
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        const respondedIds = new Set<string>()
        for (let j = messages.length; j < rawMessages.length; j++) {
          const mm = rawMessages[j]
          if (mm.role === 'tool' && mm.tool_call_id) respondedIds.add(mm.tool_call_id)
          else if (mm.role === 'assistant' || mm.role === 'user') break
        }
        for (const tc of m.tool_calls) {
          if (!respondedIds.has(tc.id)) {
            // 内存中合成占位 tool 消息
            const synth: Message = {
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify({
                status: 'synthesized_legacy',
                tool_name: tc.function.name,
                hint: '历史脏数据：pre-fix 时代 assistant(tool_calls) 未补 tool 响应，已在内存中合成占位以保证 LLM 协议合法',
              }),
            }
            messages.push(synth)
            synthesized++
          }
        }
      }
    }
    if (dropped > 0) {
      console.warn(
        `[Session] ⚠️ 加载 [${sessionId}] 时丢弃 ${dropped} 条孤儿 tool 消息（缺对应 assistant(tool_calls)）`,
      )
    }
    if (synthesized > 0) {
      console.warn(
        `[Session] 🛠️ 加载 [${sessionId}] 时为 ${synthesized} 个历史 tool_call_id 合成占位 tool 消息（仅内存，DB 未修改）`,
      )
    }

    console.info(`[Session] 📂 加载会话 ${sessionId}：${messages.length} 条消息`)

    /**
     * 滑动窗口截断 — 防止 LLM 上下文溢出
     *
     * 策略：保留 system + 最近 MAX_CONTEXT_MESSAGES 条
     * 被截断的消息用一条摘要消息替代，包含截断的轮次数
     */
    if (messages.length > MAX_CONTEXT_MESSAGES + 1) {
      const systemMsg = messages[0] // 保留 system 消息
      const numTruncated = messages.length - MAX_CONTEXT_MESSAGES - 1
      const recent = messages.slice(-MAX_CONTEXT_MESSAGES)

      const truncationNote: Message = {
        role: 'system',
        content: `[注意] 对话历史过长，已省略最早的 ${numTruncated} 条消息以保持在上下文窗口内。当前保留最近 ${MAX_CONTEXT_MESSAGES} 条消息。`,
      }

      const truncated = [systemMsg, truncationNote, ...recent]
      console.info(`[Session] ✂️  上下文截断：${messages.length} → ${truncated.length}（省略 ${numTruncated} 条）`)
      return truncated
    }

    return messages
  }

  private async persistMessage(sessionId: string, msg: Message): Promise<void> {
    await messageRepo.insert(sessionId, msg, Date.now())
  }

  /**
   * P1-7：构造"用户偏好"段，注入 system prompt。
   * P3-13：拆分为"本会话" + "跨会话"两段。
   *
   * 行为：
   *   - 本会话：getTopByCategory({sessionId}) — 反映用户在当前会话已表达的偏好
   *   - 跨会话：getTopByCategoryAcrossSessions() — 反映用户在其他会话的历史习惯
   *   - 时间窗口：默认 90 天（避免远古数据干扰）
   *   - 拼接为中文描述，例：
   *       "用户偏好历史：
   *        本会话：饮食目标：减脂(2次), 控糖(1次)
   *        跨会话：菜系偏好：川菜(8次), 粤菜(3次)"
   *
   * 注意事项：
   *   - 不在这里做"个性化过滤"——只把数据交给 LLM，由 LLM 决定如何利用
   *   - 拼接到 system prompt 而非 user prompt，避免污染用户消息历史
   *   - 跨会话部分加"仅供参考"标签，避免 LLM 把历史偏好当成当前命令
   *
   * 实现：已迁移到 ./agent/preferences/prompt.ts（避免 agent.ts 越长越大）
   */

  async listSessions() {
    return sessionRepo.findAll()
  }

  async clearSession(sessionId: string): Promise<void> {
    await messageRepo.deleteBySessionId(sessionId)
    const deleted = await sessionRepo.deleteById(sessionId)
    console.info(`[Session] 🗑️ 清除会话 ${sessionId}：${deleted ? '成功' : '不存在'}`)
  }

  async getHistory(sessionId: string): Promise<Message[]> {
    return messageRepo.findHistoryBySessionId(sessionId)
  }

  /**
   * P1-8 引入：用户主动取消"待回答的交互式请求"。
   *
   * 触发场景：
   *   - 前端交互卡片上显示"跳过"或"不想回答"按钮
   *   - 用户在 10 分钟后直接放弃等答
   *
   * 行为：
   *   - 校验 sessionId + interactiveId 与 pending 一致
   *   - 清除 session.pending_interactive 字段
   *   - 同步写入 tool 消息（content: { skipped: true, reason: 'user_cancelled' }）
   *     让 LLM 在下一轮知道"用户放弃了那个问题"
   *   - 返回 { cancelled, currentPending } 给调用方
   *
   * 失败处理：
   *   - session 不存在 → 抛 404
   *   - pending 不存在 → 返回 { cancelled: false, reason: 'no_pending' }
   *   - pending.id 与请求的 interactiveId 不一致 → 返回 { cancelled: false, reason: 'id_mismatch' }
   */
  async cancelInteractive(
    sessionId: string,
    interactiveId: string,
  ): Promise<{ cancelled: boolean; reason?: string; remaining?: number }> {
    console.info(`[Agent] 🛑 取消交互 [${sessionId}]：interactiveId=${interactiveId}`)

    const session = await sessionRepo.findById(sessionId)
    if (!session) {
      throw new Error(`会话 ${sessionId} 不存在`)
    }

    // P1-4 改动：支持取消数组中任意一项
    const pendingList = await sessionRepo.getPendingInteractiveList(sessionId)
    if (pendingList.length === 0) {
      console.info(`[Agent] ℹ️ 会话 [${sessionId}] 当前无 pending_interactive，无需取消`)
      return { cancelled: false, reason: 'no_pending' }
    }

    const exists = pendingList.some((p) => p.id === interactiveId)
    if (!exists) {
      console.warn(
        `[Agent] ⚠️ 取消的 interactiveId=${interactiveId} 不在 pending 列表中：[${pendingList.map((p) => p.id).join(', ')}]`,
      )
      return { cancelled: false, reason: 'id_mismatch' }
    }

    // 写入 tool 消息，让 LLM 在下次 LLM 调用时知道"用户放弃了那个问题"
    //   注意：这条 tool 消息是必要的，LLM 协议要求 assistant(tool_calls) 后必须跟 tool 消息
    const cancelMsg: Message = {
      role: 'tool',
      tool_call_id: interactiveId,
      content: JSON.stringify({ user_choice: null, skipped: true, reason: 'user_cancelled' }),
    }
    await this.persistMessage(sessionId, cancelMsg)

    // 从 pending 数组中移除（若全部移除则清空）
    await sessionRepo.removePendingInteractive(sessionId, interactiveId, Date.now())

    const remaining = (await sessionRepo.getPendingInteractiveList(sessionId)).length
    console.info(`[Agent] ✅ 交互 [${sessionId}] 已取消：${interactiveId}（剩余 ${remaining} 个）`)
    return { cancelled: true, remaining }
  }

  /**
   * P3-15：撤销最近一次"已回答"的交互式工具。
   *
   * 行为：
   *   1. 找到最近一次 assistant(tool_calls=[ask_user_choice]) + tool 消息对
   *   2. 删除 tool 消息（用户的选择）
   *   3. 把 ask_user_choice 加回 pending_interactive（让前端可以重新选）
   *   4. 返回 interactive_id，前端可调用 /api/chat/resume 或重新渲染
   *
   * 限制：
   *   - 只撤销最近一次
   *   - LLM 不会主动重发问（避免破坏对话节奏）；前端可调 /api/chat/continue 触发
   *   - 撤销后不删除 user_choice_history 中的记录（保留作为历史统计）
   */
  async undoLastInteractive(sessionId: string): Promise<{
    undone: boolean
    interactiveId?: string
    reason?: string
  }> {
    console.info(`[Agent] ↩️ 撤销最近交互 [${sessionId}]`)

    const session = await sessionRepo.findById(sessionId)
    if (!session) {
      throw new Error(`会话 ${sessionId} 不存在`)
    }

    const pair = await messageRepo.findLastAnsweredInteractive(sessionId)
    if (!pair) {
      console.info(`[Agent] ℹ️ 会话 [${sessionId}] 没有可撤销的交互`)
      return { undone: false, reason: 'no_answered_interactive' }
    }

    // 1) 删除 tool 消息
    await messageRepo.deleteById(pair.toolId)
    console.info(`[Agent] 🗑️  删除 tool 消息 id=${pair.toolId}`)

    // 2) 把 ask_user_choice 加回 pending_interactive
    //    需要从 assistant 消息的 tool_calls 中找到对应 args
    const rows = await messageRepo.findBySessionId(sessionId)
    const assistantRow = rows.find((r) => r.id === pair.assistantId)
    if (!assistantRow || !assistantRow.tool_calls) {
      return { undone: false, reason: 'assistant_message_missing' }
    }
    type AskTc = { id?: string; function?: { name?: string; arguments?: string } }
    const tcs = JSON.parse(assistantRow.tool_calls) as AskTc[]
    const askTc = tcs.find((tc) => tc.id === pair.interactiveId)
    if (!askTc || !askTc.function?.arguments) {
      return { undone: false, reason: 'tool_call_args_missing' }
    }

    const interactive = parseInteractiveArgs(pair.interactiveId, askTc.function.arguments)
    if (!interactive) {
      return { undone: false, reason: 'parse_failed' }
    }

    // 追加到 pending_interactive（若已存在则不重复加）
    const now = Date.now()
    const list = await sessionRepo.getPendingInteractiveList(sessionId)
    if (!list.some((p) => p.id === pair.interactiveId)) {
      const updated = [
        ...list,
        {
          id: interactive.id,
          name: 'ask_user_choice',
          arguments: askTc.function.arguments,
          created_at: now,
        },
      ]
      await sessionRepo.setPendingInteractiveList(sessionId, updated, now)
      console.info(`[Agent] ✅ 交互 [${pair.interactiveId}] 已回到 pending 列表`)
    } else {
      console.info(`[Agent] ℹ️ 交互 [${pair.interactiveId}] 已在 pending 列表中，跳过添加`)
    }

    return { undone: true, interactiveId: pair.interactiveId }
  }

  // ─── LLM 调用（带重试）───────────────────────────────────

  private async callLLMWithRetry(messages: Message[]): Promise<ChatCompletionResult> {
    let lastError: Error | null = null

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.llm.chatCompletion({
          messages: messages as any,
          tools: buildToolsParam(),
          tool_choice: 'auto',
          temperature: 0.7,
          max_tokens: 2048,
        })
      } catch (err) {
        lastError = err as Error
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1)
          console.warn(`[Agent] ⚠️ LLM 调用失败（第 ${attempt}/${MAX_RETRIES} 次），${delay}ms 后重试：${lastError.message}`)
          await sleep(delay)
        }
      }
    }

    throw lastError ?? new Error('LLM 调用失败，已达最大重试次数')
  }

  // ─── 用户消息预处理 ──────────────────────────────────────

  private async prependUserMessage(messages: Message[], sessionId: string, userMessage: string): Promise<void> {
    const now = Date.now()
    console.info(`[Agent] 📥 用户消息 [${sessionId}]：${userMessage.slice(0, 60)}${userMessage.length > 60 ? '…' : ''}`)

    const userMsg: Message = { role: 'user', content: userMessage }
    messages.push(userMsg)
    await this.persistMessage(sessionId, userMsg)

    const isFirstUserMessage = (await messageRepo.countBySessionId(sessionId)) === 1
    if (isFirstUserMessage) {
      const title = userMessage.slice(0, 20) + (userMessage.length > 20 ? '…' : '')
      await sessionRepo.updateTitle(sessionId, title, now)
    } else {
      await sessionRepo.touch(sessionId, now)
    }
  }

  // ─── 工具调用处理（chat / chatStream 共用）───────────────

  /**
   * 工具调用统一处理入口
   *
   * 行为分两类：
   *   ① 非交互式工具 → 同步执行、追加 tool 消息、累积到 reactLog
   *   ② 交互式工具（ask_user_choice）→ 跳过执行，发出 onInteractive 事件，标记 paused
   *
   * 一次 LLM 响应里可以同时存在两类工具，混合处理：
   *   - 助手消息（带全部 tool_calls）先持久化
   *   - 非交互式的先执行并写入 tool 消息
   *   - 交互式的在内存里登记，但不写 tool 消息（等用户选择后由 resume 阶段补）
   *   - 若存在任何交互式工具 → 返回 paused=true，调用方应结束本轮 ReAct 循环
   *
   * @returns { toolCount, paused, interactiveRequests }
   *   - toolCount             : 已实际执行的工具数（不含交互式）
   *   - paused                : 是否因为交互式工具而暂停
   *   - interactiveRequests   : 本轮需要前端展示的交互式请求（按 tool_call 顺序）
   */
  private async handleToolCalls(
    messages: Message[],
    sessionId: string,
    assistantContent: string | null,
    assistantToolCalls: ChatCompletionResult['tool_calls'],
    reactLog: ReActStep[],
    step: number,
    onInteractive?: (req: InteractiveRequest) => void,
  ): Promise<{ toolCount: number; paused: boolean; interactiveRequests: InteractiveRequest[] }> {
    if (!assistantToolCalls || assistantToolCalls.length === 0) {
      return { toolCount: 0, paused: false, interactiveRequests: [] }
    }

    console.info(`[Agent] 🔧 LLM 请求调用 ${assistantToolCalls.length} 个工具`)

    // ── 1. 助手消息（包含全部 tool_calls）持久化 ──
    const toolMsg: Message = {
      role: 'assistant',
      content: assistantContent ?? '',
      tool_calls: assistantToolCalls.map((c) => ({
        id: c.id,
        type: 'function' as const,
        function: {
          name: c.function.name,
          arguments: c.function.arguments,
        },
      })),
    }
    messages.push(toolMsg)
    await this.persistMessage(sessionId, toolMsg)

    // ── 2. 拆分交互式 vs 非交互式 ──
    const interactiveRequests: InteractiveRequest[] = []
    const executableCalls: ToolCall[] = []

    for (const c of assistantToolCalls) {
      if (INTERACTIVE_TOOL_NAMES.has(c.function.name)) {
        const req = parseInteractiveArgs(c.id, c.function.arguments)
        if (req) {
          interactiveRequests.push(req)
        }
      } else {
        executableCalls.push({
          id: c.id,
          name: c.function.name,
          arguments: c.function.arguments,
        })
      }
    }

    // ── 3. 执行非交互式工具（如有） ──
    if (executableCalls.length > 0) {
      console.info(`[Agent] ⚡ 执行 ${executableCalls.length} 个非交互式工具`)

      const toolResults = await executeTools(executableCalls, sessionId)

      for (const { id, result } of toolResults) {
        const obsContent = result.success
          ? JSON.stringify(result.data)
          : `【工具执行失败】${result.error}`

        const obsMsg: Message = {
          role: 'tool' as const,
          tool_call_id: id,
          content: obsContent,
        }
        messages.push(obsMsg)
        await this.persistMessage(sessionId, obsMsg)
      }

      reactLog.push({
        step,
        thought: `调用工具获取准确信息：${executableCalls.map((c) => c.name).join(', ')}`,
        action: executableCalls.map((c) => c.name).join(' + '),
        actionInput: executableCalls.map((c): Record<string, unknown> => {
          try { return JSON.parse(c.arguments) } catch { return {} }
        }),
        observation: `✅ ${executableCalls.length} 个工具执行完成`,
      })
    }

    // ── 4. 处理交互式工具（如果有，触发 onInteractive 并标记 paused） ──
    if (interactiveRequests.length > 0) {
      console.info(`[Agent] 🙋 检测到 ${interactiveRequests.length} 个交互式工具调用，暂停等待用户选择`)

      reactLog.push({
        step,
        thought: `需要用户先回答：${interactiveRequests.map((r) => r.question).join('；')}`,
        action: interactiveRequests.map((r) => r.question).join('；'),
        actionInput: { options: interactiveRequests.map((r) => r.options) },
        observation: '⏸️ 已暂停，等待用户在前端选择',
      })

      /**
       * P0-2 修复：把待回答的交互式工具写入 session 级别。
       * P1-4 改动：写为数组，支持同轮多个交互式工具。
       *
       * 原因：loadMessages 在 messages.length > MAX_CONTEXT_MESSAGES 时会截断，
       * 原 assistant(tool_calls) 消息可能被移除，resumeInteractive 反查不到。
       * 把 { id, name, arguments } 额外存到 session 行，保证续点时能找回。
       *
       * 多交互式工具场景（P1-4）：
       *   - LLM 同轮调起 2 个 ask_user_choice
       *   - 全部写入数组
       *   - 前端收到多个 interactive_request 事件，渲染多张卡片
       *   - 用户逐个回答，每答一个 → 调一次 /api/chat/continue
       *   - 全部答完后数组清空，ReAct 继续
       */
      const pendingList = interactiveRequests
        .map((req) => {
          const tc = assistantToolCalls.find((c) => c.id === req.id)
          if (!tc) return null
          return {
            id: req.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
            created_at: Date.now(),
          }
        })
        .filter((p): p is NonNullable<typeof p> => p !== null)

      if (pendingList.length > 0) {
        try {
          await sessionRepo.setPendingInteractiveList(sessionId, pendingList, Date.now())
          console.info(`[Agent] 💾 已写入 ${pendingList.length} 个 pending_interactive [${sessionId}]`)
        } catch (err) {
          console.warn(`[Agent] ⚠️ 写入 pending_interactive 失败（不影响主流程）：`, (err as Error).message)
        }
      }

      // 依次通过回调下发到前端（前端会为每个请求渲染一个交互卡片）
      for (const req of interactiveRequests) {
        onInteractive?.(req)
      }

      /**
       * P-修复：为每个交互式 tool_call_id 立即写一条"占位" tool 消息。
       *
       * OpenAI 协议要求：assistant(tool_calls) 中每个 tool_call_id 必须有 1 条
       * 对应的 tool 消息响应，否则 LLM 会 400 报错：
       *   "An assistant message with 'tool_calls' must be followed by tool
       *    messages responding to each 'tool_call_id'."
       *
       * 多交互式工具场景：LLM 同轮调起 N 个 ask_user_choice 时，
       * 之前的实现只持久化 assistant 消息（带 N 个 tool_calls）但 0 条 tool 消息，
       * 用户回答 1 个时 resume 追加 1 条 → 仍然有 N-1 个 tool_call_id 悬空 → 400。
       *
       * 现在：handleToolCalls 阶段就为每个交互式 tool_call 写占位消息，
       * 用户回答时 resumeInteractive 用 updateToolContentByCallId 把占位
       * 消息的 content 替换为最终选择（保持 1对1 关系）。
       */
      for (const req of interactiveRequests) {
        const placeholderMsg: Message = {
          role: 'tool',
          tool_call_id: req.id,
          content: JSON.stringify({
            status: 'pending_user_choice',
            question: req.question,
            hint: '等待用户在前端做出选择',
          }),
        }
        messages.push(placeholderMsg)
        await this.persistMessage(sessionId, placeholderMsg)
      }
      console.info(
        `[Agent] 📝 [fix] 为 ${interactiveRequests.length} 个交互式 tool_call 写占位 tool 消息`,
      )

      // #region debug-point check-tool-pairing
      console.info(`[Agent] 🔎 [debug] handleToolCalls 退出前 messages 校验：`)
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i]
        if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
          const callIds = m.tool_calls.map((tc) => tc.id)
          const respondedIds = new Set<string>()
          for (let j = i + 1; j < messages.length; j++) {
            const mm = messages[j]
            if (mm.role === 'tool' && mm.tool_call_id) respondedIds.add(mm.tool_call_id)
            else if (mm.role === 'assistant') break
          }
          const missing = callIds.filter((id) => !respondedIds.has(id))
          if (missing.length > 0) {
            console.warn(
              `[Agent] ❌ [debug] assistant 消息 (i=${i}) ${callIds.length} 个 tool_calls，缺失响应：${missing.join(',')}`,
            )
          } else {
            console.info(
              `[Agent] ✅ [debug] assistant 消息 (i=${i}) ${callIds.length} 个 tool_calls 全部有响应`,
            )
          }
        }
      }
      // #endregion
    }

    return {
      toolCount: executableCalls.length,
      paused: interactiveRequests.length > 0,
      interactiveRequests,
    }
  }

  // ─── ReAct 循环日志 ──────────────────────────────────────

  private logReActSummary(reactLog: ReActStep[], totalToolCalls: number): void {
    if (reactLog.length === 0) return
    console.info(`[Agent] 📋 ReAct 执行摘要（${reactLog.length} 步，调用 ${totalToolCalls} 个工具）：`)
    for (const s of reactLog) {
      console.info(`       步${s.step}: ${s.action} → ${s.observation}`)
    }
  }

  // ─── 普通对话 ────────────────────────────────────────────

  async chat(userMessage: string, sessionId: string = 'default'): Promise<ChatResult> {
    const messages = await this.loadMessages(sessionId)
    await this.prependUserMessage(messages, sessionId, userMessage)

    const reactLog: ReActStep[] = []
    let totalToolCalls = 0

    try {
      for (let step = 1; step <= MAX_REACT_STEPS; step++) {
        console.info(`[Agent] 🧠 ReAct 推理第 ${step} 步...`)

        const response = await this.callLLMWithRetry(messages)

        const assistantContent = response.content
        const assistantToolCalls = response.tool_calls

        if (assistantToolCalls && assistantToolCalls.length > 0) {
          const { toolCount, paused } = await this.handleToolCalls(
            messages, sessionId, assistantContent, assistantToolCalls, reactLog, step,
          )
          totalToolCalls += toolCount
          if (paused) {
            // 非流式场景下：交互式工具需要流式通道推送事件，chat() 不支持。
            // 此处走兜底：把交互式问题直接拼进兜底回答，由前端引导用户使用 /chat/stream 重新提问。
            console.warn('[Agent] ⚠️ 非流式 chat() 检测到交互式工具，回退到兜底文案')
            return await this.fallbackAnswer(messages, sessionId)
          }
        } else {
          const finalContent = assistantContent ?? ''
          console.info(`[Agent] ✅ LLM 直接回答（${finalContent.length} 字符）`)

          const answerMsg: Message = { role: 'assistant', content: finalContent }
          messages.push(answerMsg)
          await this.persistMessage(sessionId, answerMsg)

          this.logReActSummary(reactLog, totalToolCalls)

          const result: ChatResult = {
            success: true,
            message: finalContent,
            sessionId,
            usage: response.usage
              ? {
                  prompt_tokens: response.usage.prompt_tokens,
                  completion_tokens: response.usage.completion_tokens,
                  total_tokens: response.usage.total_tokens,
                }
              : undefined,
          }

          if (result.usage) {
            console.info(
              `[Agent] 📈 Token 消耗 - 输入：${result.usage.prompt_tokens}，` +
              `输出：${result.usage.completion_tokens}，` +
              `总计：${result.usage.total_tokens}`,
            )
          }

          return result
        }
      }

      return await this.fallbackAnswer(messages, sessionId)

    } catch (error) {
      console.error(`[Agent] ❌ 调用失败 [${sessionId}]：${(error as Error).message}`)
      throw error
    }
  }

  // ─── 流式对话 ────────────────────────────────────────────

  /**
   * chatStream — 流式对话（SSE 推送）
   *
   * 这是 Agent 最核心的对外接口，完成 ReAct 推理循环 + 流式回答生成。
   *
   * P-重构：循环体已抽到 agent/react-loop.ts，收尾抽到 agent/stream-finalizer.ts。
   *         本方法只负责：
   *           ① 加载历史 / 追加用户消息 / 清理残留 pending
   *           ② 把方法（callLLM/streamLLM/handleTools）注入到 ReAct 循环
   *           ③ 把 ReAct 结果转给 finalize
   *
   * @param userMessage   — 用户输入文本
   * @param sessionId     — 会话 ID
   * @param onChunk       — 逐 token 回调
   * @param onDone        — 完成回调
   * @param signal        — 中止信号
   * @param onInteractive — 交互式工具触发回调（可选）
   */
  async chatStream(
    userMessage: string,
    sessionId: string = 'default',
    onChunk: (delta: string) => void,
    onDone: (fullContent: string) => void,
    signal?: AbortSignal,
    onInteractive?: (req: InteractiveRequest) => void,
    /**
     * P1-①：ReAct 阶段进度回调（前端用它渲染"正在思考/调用工具"指示器）。
     * 不传则降级为不发送（向后兼容）。
     */
    onProgress?: import('./agent/react-loop').ReActProgressEventCallback,
  ): Promise<void> {
    const messages = await this.loadMessages(sessionId)
    await this.prependUserMessage(messages, sessionId, userMessage)

    /**
     * P0-2 修复：用户发起新一轮 chatStream 时，清除任何残留的 pending_interactive。
     * （注释略，详见原版本）
     */
    try {
      const oldPending = await sessionRepo.getPendingInteractive(sessionId)
      if (oldPending) {
        console.info(`[Agent] 🧹 新一轮对话开始，清除残留 pending_interactive [${sessionId}]：${oldPending.id}`)
        await sessionRepo.clearPendingInteractive(sessionId, Date.now())
      }
    } catch (err) {
      console.warn(`[Agent] ⚠️ 清除残留 pending_interactive 失败（不影响主流程）：`, (err as Error).message)
    }

    const outcome = await runReActLoop(messages, {
      callLLM: (m) => this.callLLMWithRetry(m),
      streamLLM: (m, onC, onD, onE, sig) =>
        this.llm.chatCompletionStream(
          { messages: m as any, temperature: 0.7, max_tokens: 2048 },
          (chunk) => {
            onC(chunk)
            onChunk(chunk)
          },
          onD,
          onE,
          sig,
        ),
      handleTools: (assistantContent, toolCalls, step) =>
        this.handleToolCalls(
          messages, sessionId, assistantContent, toolCalls, [], step, onInteractive,
        ).then((r) => ({ toolCount: r.toolCount, paused: r.paused })),
      onInteractive,
      onProgress,
      signal,
      maxSteps: MAX_REACT_STEPS,
      logTag: 'stream',
    })

    await finalize(this.toFinalizeOutcome(outcome), {
      messages,
      sessionId,
      onDone,
      persist: (sid, msg) => this.persistMessage(sid, msg),
      logTag: 'stream',
    })
  }

  /**
   * 把 ReActLoopResult 转成 FinalizeOutcome
   * （小工具方法，类型层桥接）
   */
  private toFinalizeOutcome(r: ReActLoopResult): import('./agent/stream-finalizer').FinalizeOutcome {
    switch (r.kind) {
      case 'done':
        return { kind: 'done', fullContent: r.fullContent, totalToolCalls: r.totalToolCalls, reactLog: r.reactLog }
      case 'empty':
        return { kind: 'empty', totalToolCalls: r.totalToolCalls, reactLog: r.reactLog }
      case 'paused':
        return { kind: 'paused', totalToolCalls: r.totalToolCalls, reactLog: r.reactLog }
      case 'cancelled':
        return { kind: 'cancelled', partialContent: r.partialContent }
    }
  }

  // ─── 兜底回答 ────────────────────────────────────────────

  private async fallbackAnswer(messages: Message[], sessionId: string): Promise<ChatResult> {
    console.warn(`[Agent] ⚠️ 达到最大推理步数 ${MAX_REACT_STEPS}，强制结束`)
    const fallback = '抱歉，这个问题比较复杂，我已经尽力思考了。请您换个更具体的问题，或者我可以为您查询具体的菜谱、营养数据或食品安全信息。'
    const fallbackMsg: Message = { role: 'assistant', content: fallback }
    messages.push(fallbackMsg)
    await this.persistMessage(sessionId, fallbackMsg)
    return { success: true, message: fallback, sessionId }
  }

  // ─── 交互式工具：用户回答后恢复 ReAct 循环 ───────────────

  /**
   * resumeInteractive — 用户在前端点击选项后，调用此方法恢复 ReAct 循环
   *
   * P-重构：循环体 / 收尾都抽到了 agent/react-loop.ts + agent/stream-finalizer.ts。
   *         本方法只负责"恢复前的上下文准备"：
   *           ① 加载历史
   *           ② 找到上一轮的 tool_call（messages / session.pending 双路兜底）
   *           ③ 校验 choice（防脏数据 / 跳过支持）
   *           ④ 记录偏好历史
   *           ⑤ 移除 pending、追加 tool 消息
   *           ⑥ 调 runReActLoop + finalize
   *
   * @param sessionId      — 会话 ID
   * @param interactiveId  — 上一轮 ask_user_choice 的 tool_call_id
   * @param choice         — 用户选择的选项
   * @param onChunk        — 流式输出回调
   * @param onDone         — 流结束回调
   * @param onInteractive  — 再次触发交互式工具时的回调
   * @param signal         — AbortSignal
   */
  async resumeInteractive(
    sessionId: string,
    interactiveId: string,
    choice: string[],
    onChunk: (delta: string) => void,
    onDone: (fullContent: string) => void,
    onInteractive: (req: InteractiveRequest) => void,
    signal?: AbortSignal,
    /**
     * P1-①：ReAct 阶段进度回调（与 chatStream 同义）。
     */
    onProgress?: import('./agent/react-loop').ReActProgressEventCallback,
  ): Promise<void> {
    console.info(`[Agent] ▶️ 恢复交互 [${sessionId}]：interactiveId=${interactiveId}, choice=${JSON.stringify(choice)}`)

    // 1. 加载历史
    const messages = await this.loadMessages(sessionId)

    // 2. 找到上一轮 assistant 消息中的对应 tool_call
    let targetCall: { id: string; name: string; arguments: string } | null = null
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'assistant' && m.tool_calls) {
        for (const tc of m.tool_calls) {
          if (tc.id === interactiveId) {
            targetCall = { id: tc.id, name: tc.function.name, arguments: tc.function.arguments }
            break
          }
        }
        if (targetCall) break
      }
    }

    // P0-2 修复：messages 找不到时回退到 session.pending 数组
    if (!targetCall) {
      console.warn(`[Agent] ⚠️ messages 中未找到 interactiveId=${interactiveId}，尝试从 session 级别恢复...`)
      const pendingList = await sessionRepo.getPendingInteractiveList(sessionId)
      const pending = pendingList.find((p) => p.id === interactiveId)
      if (pending) {
        targetCall = { id: pending.id, name: pending.name, arguments: pending.arguments }
        console.info(`[Agent] ✅ 从 session.pending_interactive 恢复：${pending.id}`)
      } else if (pendingList.length > 0) {
        throw new Error(
          `会话 ${sessionId} 当前待回答的是另一组交互（${pendingList.map((p) => p.id).join(', ')}），与请求的 ${interactiveId} 不一致。可能使用了旧的 interactiveId。`,
        )
      }
    }

    // P0-3 修复：找到 targetCall 后立即校验 choice
    if (!targetCall) {
      throw new Error(`未找到 interactiveId=${interactiveId} 对应的工具调用，会话 ${sessionId} 可能已过期`)
    }
    if (!INTERACTIVE_TOOL_NAMES.has(targetCall.name)) {
      throw new Error(`工具 ${targetCall.name} 不是交互式工具，无法用 resumeInteractive 恢复`)
    }

    // 解析 + 校验 choice
    const originalRequest = parseInteractiveArgs(targetCall.id, targetCall.arguments)
    let isSkip = false
    if (originalRequest) {
      try {
        validateChoice(choice, originalRequest)
      } catch (err) {
        throw err
      }
      isSkip = choice.length === 1 && choice[0] === SKIP_SENTINEL
    } else {
      isSkip = choice.length === 1 && choice[0] === SKIP_SENTINEL
      if (!isSkip) {
        throw new Error(`会话 ${sessionId} 的交互式工具参数已损坏，无法校验选择`)
      }
    }

    // P1-7：记录用户选择到 history 表
    if (!isSkip && originalRequest && originalRequest.category) {
      try {
        const now = Date.now()
        for (const opt of choice) {
          await choiceRepo.insert({
            session_id: sessionId,
            question: originalRequest.question,
            category: originalRequest.category,
            option: opt,
            chosen_at: now,
          })
        }
        console.info(`[Agent] 📝 已记录选择历史 [${sessionId}]：${originalRequest.category} → ${choice.join(', ')}`)
      } catch (err) {
        console.warn(`[Agent] ⚠️ 记录选择历史失败（不影响主流程）：`, (err as Error).message)
      }
    }

    // P0-2 修复：从 pending 数组中移除本条
    try {
      await sessionRepo.removePendingInteractive(sessionId, interactiveId, Date.now())
    } catch (err) {
      console.warn(`[Agent] ⚠️ 移除 pending_interactive 失败（不影响主流程）：`, (err as Error).message)
    }

    // 3. 更新占位 tool 消息（不是追加！）
    //
    // P-修复：handleToolCalls 已经为每个交互式 tool_call_id 写了一条"占位"tool 消息。
    // 现在用户做出选择后，必须 UPDATE 已有占位消息的 content 为最终选择结果，
    // 严格保持 assistant(tool_calls) 与 tool 消息的 1对1 关系（OpenAI 协议要求）。
    //
    // 兜底：若占位消息不存在（异常路径，比如 cleanup 已经把它 update 为 timeout，
    // 或者历史脏数据），则插入新 tool 消息并以 messages 数组中的占位消息为锚点。
    const now = Date.now()
    const newContent = isSkip
      ? JSON.stringify({ user_choice: null, skipped: true, hint: '用户未提供选择，请自行决定最合适的方案' })
      : JSON.stringify({ user_choice: choice })

    const updated = await messageRepo.updateToolContentByCallId(
      sessionId,
      interactiveId,
      newContent,
      now,
    )

    if (updated > 0) {
      // 同步更新内存中的 messages 数组
      const targetIdx = messages.findIndex(
        (m) => m.role === 'tool' && m.tool_call_id === interactiveId,
      )
      if (targetIdx >= 0) {
        messages[targetIdx] = { ...messages[targetIdx], content: newContent }
      }
      console.info(`[Agent] 🔄 [fix] 更新占位 tool 消息为最终选择：${interactiveId}`)
    } else {
      // 兜底：占位消息不存在 → 插入新 tool 消息
      const toolResultMsg: Message = {
        role: 'tool',
        tool_call_id: interactiveId,
        content: newContent,
      }
      messages.push(toolResultMsg)
      await this.persistMessage(sessionId, toolResultMsg)
      console.warn(
        `[Agent] ⚠️ [fix] 占位 tool 消息不存在（已 insert 兜底）：${interactiveId}`,
      )
    }

    // 4. 继续 ReAct 循环 —— 复用 runReActLoop
    const outcome = await runReActLoop(messages, {
      callLLM: (m) => this.callLLMWithRetry(m),
      streamLLM: (m, onC, onD, onE, sig) =>
        this.llm.chatCompletionStream(
          { messages: m as any, temperature: 0.7, max_tokens: 2048 },
          (chunk) => {
            onC(chunk)
            onChunk(chunk)
          },
          onD,
          onE,
          sig,
        ),
      handleTools: (assistantContent, toolCalls, step) =>
        this.handleToolCalls(
          messages, sessionId, assistantContent, toolCalls, [], step, onInteractive,
        ).then((r) => ({ toolCount: r.toolCount, paused: r.paused })),
      onInteractive,
      onProgress,
      signal,
      maxSteps: MAX_REACT_STEPS,
      logTag: '恢复后stream',
    })

    await finalize(this.toFinalizeOutcome(outcome), {
      messages,
      sessionId,
      onDone,
      persist: (sid, msg) => this.persistMessage(sid, msg),
      logTag: '恢复后stream',
    })
  }
}