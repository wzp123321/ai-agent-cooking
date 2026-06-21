/**
 * ============================================================
 * agent/react-loop.ts — ReAct 推理循环（chatStream / resumeInteractive 共用）
 * ============================================================
 *
 * 设计目标：
 *   - 把 chatStream 和 resumeInteractive 里的 for-loop 抽出来
 *   - 两条路径共享完全一致的循环体
 *   - 结局（cancelled / paused / empty / done）由调用方通过 return 值处理
 *
 * 循环逻辑（每一步）：
 *   1. 检查 signal.aborted → cancelled
 *   2. callLLMWithRetry(messages) → response
 *   3. if (response.tool_calls.length > 0)
 *        - handleToolCalls
 *        - if paused → break (return paused)
 *      else
 *        - chatCompletionStream 流式输出文本
 *        - if signal.aborted → cancelled
 *        - break
 *
 * 依赖（由调用方注入）：
 *   - callLLM : (messages) => Promise<{content, tool_calls}>
 *   - streamLLM: (messages, onChunk, onDone, onError, signal) => Promise<void>
 *   - handleTools: (assistantContent, toolCalls, step) => Promise<{ toolCount, paused }>
 *   - onInteractive?: 交互式工具回调
 *
 * 注意：
 *   - 不在这里做"中止收尾 / 空回答兜底 / 持久化"——这些交给 stream-finalizer
 *   - 不在这里写 messages.push / persist——调用方持 messages
 */

import type { InteractiveRequest } from './interactive'
import type { Message } from '../types'
import type { ReActStep } from '../tools/types'
import type { ChatCompletionResult } from '../llm/types'

export interface ReActLoopDeps {
  callLLM: (messages: Message[]) => Promise<ChatCompletionResult>
  streamLLM: (
    messages: Message[],
    onChunk: (chunk: string) => void,
    onDone: () => void,
    onError: (err: Error) => void,
    signal?: AbortSignal,
  ) => Promise<void>
  handleTools: (
    assistantContent: string | null,
    toolCalls: ChatCompletionResult['tool_calls'],
    step: number,
  ) => Promise<{ toolCount: number; paused: boolean }>
  onInteractive?: (req: InteractiveRequest) => void
  /**
   * P1-①：ReAct 阶段进度回调。
   * - { type: 'thinking', step }                  : 开始第 N 轮推理
   * - { type: 'tool_call', step, toolNames[] }    : 即将执行工具
   * - { type: 'tool_result', step, count }        : 工具执行完成
   * - { type: 'streaming', step }                 : 进入流式回答阶段
   *
   * 调用方把这条事件直接转发为 SSE `progress` 事件，
   * 前端用它渲染"正在思考 / 正在调用工具 XX"指示器。
   */
  onProgress?: (event: ReActProgressEvent) => void
  signal?: AbortSignal
  maxSteps: number
  logTag: string
}

export type ReActProgressEvent =
  | { type: 'thinking'; step: number; maxSteps: number }
  | { type: 'tool_call'; step: number; toolNames: string[] }
  | { type: 'tool_result'; step: number; count: number }
  | { type: 'streaming'; step: number }

/** P1-①：进度回调签名（agent.ts 注入用） */
export type ReActProgressEventCallback = (event: ReActProgressEvent) => void

export type ReActLoopResult =
  | { kind: 'done'; fullContent: string; totalToolCalls: number; reactLog: ReActStep[] }
  | { kind: 'empty'; totalToolCalls: number; reactLog: ReActStep[] }
  | { kind: 'paused'; totalToolCalls: number; reactLog: ReActStep[] }
  | { kind: 'cancelled'; partialContent: string }

/**
 * 执行 ReAct 循环直到以下任一情况：
 *   - LLM 产出最终回答（done）
 *   - LLM 产出空回答（empty）
 *   - 调起交互式工具（paused）
 *   - 信号被中止（cancelled）
 *   - 达到 maxSteps（视为 done/empty，由调用方判定）
 *
 * @returns ReActLoopResult — 调用方传给 stream-finalizer.finalize()
 */
export async function runReActLoop(
  messages: Message[],
  deps: ReActLoopDeps,
): Promise<ReActLoopResult> {
  let fullContent = ''
  let totalToolCalls = 0
  let cancelled = false
  let paused = false
  const reactLog: ReActStep[] = []

  try {
    for (let step = 1; step <= deps.maxSteps; step++) {
      // 每轮推理前检查中止
      if (deps.signal?.aborted) {
        cancelled = true
        console.info(`[Agent] 🛑 ${deps.logTag} 检测到中止信号，ReAct 第 ${step} 轮前退出`)
        break
      }

      console.info(`[Agent] 🧠 ${deps.logTag} 推理第 ${step} 步…`)
      // P1-①：通知前端"开始第 N 轮思考"
      deps.onProgress?.({ type: 'thinking', step, maxSteps: deps.maxSteps })
      const response = await deps.callLLM(messages)
      const assistantContent = response.content
      const assistantToolCalls = response.tool_calls

      if (assistantToolCalls && assistantToolCalls.length > 0) {
        // P1-①：通知前端"即将执行这些工具"
        const toolNames = assistantToolCalls
          .map((tc) => tc.function.name)
          .filter((n): n is string => typeof n === 'string' && n.length > 0)
        deps.onProgress?.({ type: 'tool_call', step, toolNames })
        const result = await deps.handleTools(assistantContent, assistantToolCalls, step)
        // P1-①：通知前端"工具执行完成"
        deps.onProgress?.({ type: 'tool_result', step, count: result.toolCount })
        totalToolCalls += result.toolCount
        if (result.paused) {
          paused = true
          break
        }
        // 否则继续下一轮 ReAct
      } else {
        // LLM 给出最终回答，进入流式输出
        console.info(`[Agent] 🔄 ${deps.logTag} 第 ${step} 轮 LLM 返回最终回答，进入流式输出`)
        // P1-①：通知前端"开始流式输出最终回答"
        deps.onProgress?.({ type: 'streaming', step })

        await deps.streamLLM(
          messages,
          (chunk) => {
            fullContent += chunk
          },
          () => {
            console.info(`[Agent] ✅ ${deps.logTag} 流式回答完成（${fullContent.length} 字符）`)
          },
          (err) => {
            console.error(`[Agent] ❌ ${deps.logTag} 流式回答出错：${err.message}`)
          },
          deps.signal,
        )

        if (deps.signal?.aborted) {
          cancelled = true
          console.info(`[Agent] 🛑 ${deps.logTag} 流式输出中被中止，已生成 ${fullContent.length} 字符`)
        }
        break
      }
    }

    if (cancelled) {
      return { kind: 'cancelled', partialContent: fullContent }
    }
    if (paused) {
      return { kind: 'paused', totalToolCalls, reactLog }
    }
    if (fullContent.length === 0) {
      return { kind: 'empty', totalToolCalls, reactLog }
    }
    return { kind: 'done', fullContent, totalToolCalls, reactLog }
  } catch (err) {
    // 抛回给调用方，调用方可以做日志/兜底
    console.error(`[Agent] ❌ ${deps.logTag} ReAct 循环异常 [已生成 ${fullContent.length} 字符, ${totalToolCalls} 工具]`)
    throw err
  }
}
