/**
 * ============================================================
 * conversation/_state.ts — 共享的模块级状态
 * ============================================================
 *
 * 设计动机：
 *   useConversation() 会被多个组件调用（InputBar / ChatView 等），
 *   abortController / 计时器 / lastEvent 必须是唯一的，否则：
 *     - InputBar 点停止 → 中止的是 InputBar 持有的 controller
 *     - 但 ChatView 起的请求仍在跑
 *
 * 替代方案对比：
 *   ❌ Pinia store —— 会污染 store 概念边界（store 管状态，hook 管流程）
 *   ❌ props 透传 —— MessageList → MessageBubble 链路过长
 *   ✅ 模块级单例 —— 最小改动，符合"hook 内部用模块状态"惯例
 *
 * 注意：
 *   - 内部模块，外部不应该直接 import
 *   - 通过 hooks/conversation/index.ts 暴露受控的 API
 */

import type { ChatMessage, ReActProgressEvent } from '@/types'

// ═══ 当前流式请求的 AbortController ═══
export let abortController: AbortController | null = null
export const setAbortController = (ac: AbortController | null): void => {
  abortController = ac
}

// ═══ 双计时器 + 卡住检测 ═══
export let hardTimer: ReturnType<typeof setTimeout> | null = null
export const setHardTimer = (t: ReturnType<typeof setTimeout> | null): void => {
  hardTimer = t
}

export let inactivityTimer: ReturnType<typeof setTimeout> | null = null
export const setInactivityTimer = (t: ReturnType<typeof setTimeout> | null): void => {
  inactivityTimer = t
}

export let stuckHintTimer: ReturnType<typeof setTimeout> | null = null
export const setStuckHintTimer = (t: ReturnType<typeof setTimeout> | null): void => {
  stuckHintTimer = t
}

// ═══ 最后收到的事件类型 ═══
export type LastEvent = 'start' | 'chunk' | 'tool' | 'interactive' | 'done'
export let lastEvent: LastEvent = 'start'
export const setLastEvent = (e: LastEvent): void => {
  lastEvent = e
}

// ═══ 当前流式接收的 aiMsg 引用 ═══
// 计时器回调是异步上下文，无法直接访问 sendMessage 的局部变量
export let currentAIMsg: ChatMessage | null = null
export const setCurrentAIMsg = (m: ChatMessage | null): void => {
  currentAIMsg = m
}

// ═══ P1-①：当前 ReAct 进度事件 ═══
// UI 通过 useReActProgress() 拿到它，渲染"正在思考 / 调用 XX 工具"指示器。
// 流结束时清空。
export let reactProgress: ReActProgressEvent | null = null
export const setReactProgress = (e: ReActProgressEvent | null): void => {
  reactProgress = e
}
