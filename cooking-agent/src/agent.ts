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
import { getProvider, type LLMProvider } from './llm'
import type { Message, ChatResult } from './types'
import type { ToolCall, ReActStep } from './tools/types'
import type { ChatCompletionResult } from './llm/types'

/**
 * 交互式请求 — Agent 在 ReAct 循环中检测到 ask_user_choice 工具时，
 * 不会执行它，而是通过此结构把问题/选项交给前端展示。
 *
 * id 与 LLM 下发的 tool_call.id 一一对应，前端回传选择时也带此 id。
 */
export interface InteractiveRequest {
  id: string
  question: string
  options: string[]
  multiSelect: boolean
}

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
      const systemContent = buildSystemMessage() + profilePrompt

      const systemMsg: Message = { role: 'system', content: systemContent }
      await messageRepo.insert(sessionId, systemMsg, now)
      return [systemMsg]
    }

    const rows = await messageRepo.findBySessionId(sessionId)
    const messages: Message[] = rows.map((r) => ({
      role: r.role as Message['role'],
      content: r.content,
      tool_call_id: r.tool_call_id ?? undefined,
      tool_calls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined,
    }))

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
        const req = this.parseInteractiveArgs(c.id, c.function.arguments)
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

      // 依次通过回调下发到前端（前端会为每个请求渲染一个交互卡片）
      for (const req of interactiveRequests) {
        onInteractive?.(req)
      }
    }

    return {
      toolCount: executableCalls.length,
      paused: interactiveRequests.length > 0,
      interactiveRequests,
    }
  }

  /**
   * 解析 ask_user_choice 的参数为结构化 InteractiveRequest。
   * 容错：参数缺失、JSON 解析失败时退化为"无选项"的占位请求，
   * 避免因 LLM 输出不规范导致整条 SSE 流崩掉。
   */
  private parseInteractiveArgs(id: string, argsStr: string): InteractiveRequest | null {
    try {
      const args = JSON.parse(argsStr) as {
        question?: string
        options?: string[]
        multi_select?: boolean
      }
      const question = typeof args.question === 'string' ? args.question : '请选择'
      const options = Array.isArray(args.options)
        ? args.options.filter((o): o is string => typeof o === 'string')
        : []
      const multiSelect = args.multi_select === true

      if (options.length === 0) {
        console.warn(`[Agent] ⚠️ 交互式工具 ${id} 选项为空，跳过`)
        return null
      }

      return { id, question, options, multiSelect }
    } catch (err) {
      console.error(`[Agent] ❌ 解析交互式工具参数失败 [${id}]：`, (err as Error).message)
      return null
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
   * @param userMessage   — 用户输入文本
   * @param sessionId     — 会话 ID，用于加载/持久化消息历史
   * @param onChunk       — 逐 token 回调，每个 delta 触发一次（前端实现打字机效果）
   * @param onDone        — 完成回调，包含完整回答文本（前端停止 streaming 状态）
   * @param signal        — 中止信号，由 index.ts 的 AbortController 传入。
   *                        检测时机：① ReAct 每轮循环开始前 ② LLM 流式输出的每个 chunk 之间
   * @param onInteractive — 交互式工具触发回调（可选，接收 InteractiveRequest）
   *                        当 LLM 调起 ask_user_choice 时触发，调用方应通过 SSE 下发到前端
   *                        并结束本轮流（不调 onDone），等 /api/chat/continue 端点接管
   *
   * 流程概览：
   *   1. 加载历史消息 → 追加用户消息
   *   2. 进入 ReAct 循环（最多 MAX_REACT_STEPS 轮）
   *      a. 每轮开始前检查 signal.aborted
   *      b. 调用 LLM（带 3 次重试）
   *      c. 如有 tool_calls → 执行非交互式工具 + 处理交互式工具 → 继续或暂停
   *      d. 如无 tool_calls → 进入流式回答阶段 → break
   *   3. 流式回答阶段
   *      a. 调用 llm.chatCompletionStream({ stream: true })
   *      b. 每个 chunk 检查 signal.aborted
   *      c. 通过 onChunk 回调推送增量文本
   *   4. 后处理
   *      a. 中止 → 保存部分结果 + onDone
   *      b. 暂停（等待用户）→ 不调 onDone，调用方应 res.end()
   *      c. 空回答 → 发送兜底文案
   *      d. 正常 → 持久化完整消息 + onDone
   */
  async chatStream(
    userMessage: string,
    sessionId: string = 'default',
    onChunk: (delta: string) => void,
    onDone: (fullContent: string) => void,
    signal?: AbortSignal,
    onInteractive?: (req: InteractiveRequest) => void,
  ): Promise<void> {
    const messages = await this.loadMessages(sessionId)
    await this.prependUserMessage(messages, sessionId, userMessage)

    let fullContent = ''
    let totalToolCalls = 0
    let cancelled = false
    let paused = false
    const reactLog: ReActStep[] = []

    try {
      for (let step = 1; step <= MAX_REACT_STEPS; step++) {
        // 每轮推理前检查中止信号
        if (signal?.aborted) {
          cancelled = true
          console.info(`[Agent] 🛑 检测到中止信号，ReAct 第 ${step} 轮前退出`)
          break
        }

        console.info(`[Agent] 🧠 ReAct 推理第 ${step} 步...`)

        const response = await this.callLLMWithRetry(messages)

        const assistantContent = response.content
        const assistantToolCalls = response.tool_calls

        if (assistantToolCalls && assistantToolCalls.length > 0) {
          const result = await this.handleToolCalls(
            messages, sessionId, assistantContent, assistantToolCalls, reactLog, step,
            onInteractive,
          )
          totalToolCalls += result.toolCount
          if (result.paused) {
            paused = true
            console.info('[Agent] ⏸️  因交互式工具暂停，等待 /api/chat/continue 恢复')
            break
          }
        } else {
          console.info(`[Agent] 🔄 第 ${step} 轮 LLM 返回最终回答，进入流式输出阶段`)

          await this.llm.chatCompletionStream(
            {
              messages: messages as any,
              temperature: 0.7,
              max_tokens: 2048,
            },
            (chunk) => {
              fullContent += chunk
              onChunk(chunk)
            },
            () => {
              console.info(`[Agent] ✅ 流式回答完成（${fullContent.length} 字符）`)
            },
            (err) => {
              console.error(`[Agent] ❌ 流式回答出错：${err.message}`)
            },
            signal,
          )

          if (signal?.aborted) {
            cancelled = true
            console.info(`[Agent] 🛑 流式输出中被中止，已生成 ${fullContent.length} 字符`)
          }

          break
        }
      }

      // ── 处理中止场景 ─────────────────────────────────────
      // ① 有部分内容 → 追加 [已中止] 标记
      // ② 无任何内容 → 发送友好提示语，避免前端收到空回答
      // 两种情况下均持久化消息，确保刷新后仍可见
      if (cancelled) {
        console.info(`[Agent] 🛑 流式对话已中止 [${sessionId}]，已生成 ${fullContent.length} 字符`)

        if (fullContent.length > 0) {
          fullContent += '\n\n[已中止]'
        } else {
          fullContent = '请求已被中断，请重试。'
        }

        const partialMsg: Message = { role: 'assistant', content: fullContent }
        messages.push(partialMsg)
        await this.persistMessage(sessionId, partialMsg)

        onDone(fullContent)
        return
      }

      // ── 处理交互式工具暂停场景 ───────────────────────────
      // 进入此分支说明 LLM 调起了 ask_user_choice，工具结果（用户的选项）尚未到达。
      // 不调 onDone —— 调用方（index.ts）收到 onInteractive 事件后应 res.end()，
      // 等前端调用 /api/chat/continue 时再由 resumeInteractive() 恢复。
      if (paused) {
        this.logReActSummary(reactLog, totalToolCalls)
        console.info(`[Agent] ⏸️  流式对话已暂停 [${sessionId}]，等待用户选择后由 /api/chat/continue 接管`)
        return
      }

      // ── 处理空回答场景 ───────────────────────────────────
      // 触发条件：LLM 未生成任何文本（极少见，通常由 API 异常导致）
      // 处理方式：返回兜底文案，避免前端显示空消息
      if (fullContent.length === 0) {
        console.warn(`[Agent] ⚠️ 流式回答无内容 [${sessionId}]，使用兜底文案`)
        const fallback = '抱歉，这个问题比较复杂，我已经尽力思考了。请您换个更具体的问题。'
        const fallbackMsg: Message = { role: 'assistant', content: fallback }
        messages.push(fallbackMsg)
        await this.persistMessage(sessionId, fallbackMsg)
        onDone(fallback)
        return
      }

      // ── 正常完成 ──────────────────────────────────────────
      const answerMsg: Message = { role: 'assistant', content: fullContent }
      messages.push(answerMsg)
      await this.persistMessage(sessionId, answerMsg)

      this.logReActSummary(reactLog, totalToolCalls)
      console.info(`[Agent] ✅ 流式对话已完成 [${sessionId}]（${fullContent.length} 字符，${totalToolCalls} 次工具调用）`)
      onDone(fullContent)

    } catch (error) {
      console.error(`[Agent] ❌ 流式调用失败 [${sessionId}]：${(error as Error).message}`)
      console.error(`[Agent] 📋 失败时已生成 ${fullContent.length} 字符，${totalToolCalls} 次工具调用`)
      throw error
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
   * 流程：
   *   1. 加载历史消息（与 chatStream 一致，会触发 system prompt 初始化与上下文截断）
   *   2. 找到上一轮助手消息中 tool_call_id === interactiveId 的那个调用
   *   3. 追加一条 role='tool' 的消息，content 包含用户的选择
   *   4. 继续 ReAct 循环（最多 MAX_REACT_STEPS 步）—— 这是 chatStream 内层循环的复用
   *   5. 期间如果再次遇到 ask_user_choice → 再次通过 onInteractive 暂停
   *   6. 期间如果 LLM 产出最终文本 → 走流式输出 + onDone
   *
   * @param sessionId      — 会话 ID
   * @param interactiveId  — 上一轮 ask_user_choice 的 tool_call_id（用于定位）
   * @param choice         — 用户选择的选项（字符串数组，单选时只有一个元素）
   * @param onChunk        — 流式输出回调
   * @param onDone         — 流结束回调
   * @param onInteractive  — 再次触发交互式工具时的回调（用户可能再被问一次）
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
            // tool_calls 元素是 OpenAI 协议结构 { id, type, function: { name, arguments } }
            // 展平为 { id, name, arguments } 方便后续拼接 tool 消息
            targetCall = { id: tc.id, name: tc.function.name, arguments: tc.function.arguments }
            break
          }
        }
        if (targetCall) break
      }
    }

    if (!targetCall) {
      throw new Error(`未找到 interactiveId=${interactiveId} 对应的工具调用，会话 ${sessionId} 可能已过期`)
    }
    if (!INTERACTIVE_TOOL_NAMES.has(targetCall.name)) {
      throw new Error(`工具 ${targetCall.name} 不是交互式工具，无法用 resumeInteractive 恢复`)
    }

    // 3. 追加 tool 消息（这是 LLM 期待的工具结果）
    const toolResultMsg: Message = {
      role: 'tool',
      tool_call_id: interactiveId,
      content: JSON.stringify({ user_choice: choice }),
    }
    messages.push(toolResultMsg)
    await this.persistMessage(sessionId, toolResultMsg)

    // 4. 继续 ReAct 循环 —— 复用 chatStream 主体逻辑
    let fullContent = ''
    let totalToolCalls = 0
    let cancelled = false
    let paused = false
    const reactLog: ReActStep[] = []

    try {
      for (let step = 1; step <= MAX_REACT_STEPS; step++) {
        if (signal?.aborted) {
          cancelled = true
          break
        }

        console.info(`[Agent] 🧠 恢复后 ReAct 推理第 ${step} 步...`)
        const response = await this.callLLMWithRetry(messages)
        const assistantContent = response.content
        const assistantToolCalls = response.tool_calls

        if (assistantToolCalls && assistantToolCalls.length > 0) {
          const result = await this.handleToolCalls(
            messages, sessionId, assistantContent, assistantToolCalls, reactLog, step,
            onInteractive,
          )
          totalToolCalls += result.toolCount
          if (result.paused) {
            paused = true
            console.info('[Agent] ⏸️  恢复后又遇到交互式工具，再次暂停')
            break
          }
        } else {
          console.info(`[Agent] 🔄 恢复后 LLM 返回最终回答，进入流式输出阶段`)
          await this.llm.chatCompletionStream(
            {
              messages: messages as any,
              temperature: 0.7,
              max_tokens: 2048,
            },
            (chunk) => {
              fullContent += chunk
              onChunk(chunk)
            },
            () => {
              console.info(`[Agent] ✅ 恢复后的流式回答完成（${fullContent.length} 字符）`)
            },
            (err) => {
              console.error(`[Agent] ❌ 恢复后的流式回答出错：${err.message}`)
            },
            signal,
          )

          if (signal?.aborted) {
            cancelled = true
          }
          break
        }
      }

      // ── 中止处理 ──
      if (cancelled) {
        if (fullContent.length > 0) {
          fullContent += '\n\n[已中止]'
        } else {
          fullContent = '请求已被中断，请重试。'
        }
        const partialMsg: Message = { role: 'assistant', content: fullContent }
        messages.push(partialMsg)
        await this.persistMessage(sessionId, partialMsg)
        onDone(fullContent)
        return
      }

      // ── 再次暂停（用户被问了第二个问题） ──
      if (paused) {
        this.logReActSummary(reactLog, totalToolCalls)
        console.info(`[Agent] ⏸️  恢复后再次暂停 [${sessionId}]，等待用户继续选择`)
        return
      }

      // ── 空回答兜底 ──
      if (fullContent.length === 0) {
        const fallback = '抱歉，我已经尽力思考了。请换个更具体的问题试试。'
        const fallbackMsg: Message = { role: 'assistant', content: fallback }
        messages.push(fallbackMsg)
        await this.persistMessage(sessionId, fallbackMsg)
        onDone(fallback)
        return
      }

      // ── 正常完成 ──
      const answerMsg: Message = { role: 'assistant', content: fullContent }
      messages.push(answerMsg)
      await this.persistMessage(sessionId, answerMsg)
      this.logReActSummary(reactLog, totalToolCalls)
      console.info(`[Agent] ✅ 恢复后的流式对话已完成 [${sessionId}]（${fullContent.length} 字符）`)
      onDone(fullContent)
    } catch (error) {
      console.error(`[Agent] ❌ 恢复阶段失败 [${sessionId}]：${(error as Error).message}`)
      throw error
    }
  }
}