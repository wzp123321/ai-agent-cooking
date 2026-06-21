/**
 * ============================================================
 * agent/stream-finalizer.ts — 流式对话收尾
 * ============================================================
 *
 * 抽离原 chatStream / resumeInteractive 内重复的"四种结局"收尾逻辑：
 *   1. cancelled — 中止（有内容追加 [已中止]，无内容用兜底语）
 *   2. paused    — 交互式工具暂停（不调 onDone，等待 /continue）
 *   3. empty     — LLM 零回答（用兜底语）
 *   4. done      — 正常完成
 *
 * 调用方提供：
 *   - messages   - 当前消息数组（用于就地追加最终 assistant 消息）
 *   - sessionId  - 用于持久化
 *   - onDone     - 流结束回调
 *   - persist    - 持久化函数（一般是 this.persistMessage 的绑定）
 *   - logTag     - 日志标签，便于区分 chatStream / resumeInteractive
 *
 * 设计目标：
 *   - 消除 4 段几乎重复的"if-else + push + persistMessage + onDone"代码
 *   - 统一日志格式
 *   - 让 chatStream / resumeInteractive 主体只关注 ReAct 循环本身
 */

import type { Message } from '../types'

export type FinalizeOutcome =
  | { kind: 'done'; fullContent: string; totalToolCalls: number; reactLog: unknown[] }
  | { kind: 'empty'; totalToolCalls: number; reactLog: unknown[] }
  | { kind: 'paused'; reactLog: unknown[]; totalToolCalls: number }
  | { kind: 'cancelled'; partialContent: string }

const FALLBACK_EMPTY = '抱歉，这个问题比较复杂，我已经尽力思考了。请您换个更具体的问题。'
const FALLBACK_RESUMED_EMPTY = '抱歉，我已经尽力思考了。请换个更具体的问题试试。'
const CANCEL_MARK = '\n\n[已中止]'
const CANCEL_EMPTY_MSG = '请求已被中断，请重试。'

export interface FinalizeContext {
  messages: Message[]
  sessionId: string
  onDone: (fullContent: string) => void
  /** 把 assistant 消息写入 DB（一般是 CookingAgent.persistMessage 的绑定） */
  persist: (sessionId: string, msg: Message) => Promise<void>
  /** 日志标签，区分 chatStream / resumeInteractive */
  logTag: string
}

export interface FinalizeResult {
  /** 是否调用了 onDone（paused 时为 false） */
  calledOnDone: boolean
  /** 最终交给 onDone 的文本（paused 时为空串） */
  finalContent: string
}

/**
 * 统一处理 ReAct 循环结束后的四种结局。
 *
 * 用法：
 *   const result = await finalize(outcome, {
 *     messages, sessionId, onDone, persist: (sid, m) => this.persistMessage(sid, m),
 *     logTag: 'stream',
 *   })
 *   if (result.calledOnDone) ... // 正常结束
 */
export async function finalize(
  outcome: FinalizeOutcome,
  ctx: FinalizeContext,
): Promise<FinalizeResult> {
  switch (outcome.kind) {
    case 'cancelled': {
      const { partialContent } = outcome
      console.info(
        `[Agent] 🛑 ${ctx.logTag} 已中止 [${ctx.sessionId}]，已生成 ${partialContent.length} 字符`,
      )

      const final =
        partialContent.length > 0
          ? partialContent + CANCEL_MARK
          : CANCEL_EMPTY_MSG

      const msg: Message = { role: 'assistant', content: final }
      ctx.messages.push(msg)
      await ctx.persist(ctx.sessionId, msg)
      ctx.onDone(final)
      return { calledOnDone: true, finalContent: final }
    }

    case 'paused': {
      console.info(
        `[Agent] ⏸️  ${ctx.logTag} 已暂停 [${ctx.sessionId}]，等待用户选择后由 /continue 接管`,
      )
      return { calledOnDone: false, finalContent: '' }
    }

    case 'empty': {
      console.warn(`[Agent] ⚠️ ${ctx.logTag} 回答无内容 [${ctx.sessionId}]，使用兜底文案`)
      // resume 路径用稍微不同的兜底文案
      const fallback = ctx.logTag.includes('恢复') ? FALLBACK_RESUMED_EMPTY : FALLBACK_EMPTY
      const msg: Message = { role: 'assistant', content: fallback }
      ctx.messages.push(msg)
      await ctx.persist(ctx.sessionId, msg)
      ctx.onDone(fallback)
      return { calledOnDone: true, finalContent: fallback }
    }

    case 'done': {
      const { fullContent, totalToolCalls, reactLog } = outcome
      const msg: Message = { role: 'assistant', content: fullContent }
      ctx.messages.push(msg)
      await ctx.persist(ctx.sessionId, msg)
      logReactSummary(reactLog, totalToolCalls, ctx.logTag, ctx.sessionId, fullContent.length)
      ctx.onDone(fullContent)
      return { calledOnDone: true, finalContent: fullContent }
    }
  }
}

function logReactSummary(
  _reactLog: unknown[],
  totalToolCalls: number,
  logTag: string,
  sessionId: string,
  contentLength: number,
): void {
  console.info(
    `[Agent] ✅ ${logTag} 完成 [${sessionId}]（${contentLength} 字符，${totalToolCalls} 次工具调用）`,
  )
}
