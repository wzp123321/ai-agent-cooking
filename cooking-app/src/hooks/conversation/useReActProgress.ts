/**
 * ============================================================
 * conversation/useReActProgress.ts — 暴露 ReAct 进度给 UI
 * ============================================================
 *
 * P1-①：把 consumeSSEStream 收到的 progress 事件写入模块级单例，
 * MessageBubble 组件用 ref() 订阅它并渲染"正在思考 / 正在调用工具 XX"指示器。
 *
 * 为什么用模块级单例 + ref 暴露，而不是 reactive() / store？
 *   - 同一时刻只可能有一个 ReAct 流在跑
 *   - progress 事件频率低（每步一次），不需要细粒度响应
 *   - 不想污染 store 概念边界
 */

import { ref, type Ref } from 'vue'
import type { ReActProgressEvent } from '@/types'
import {
  reactProgress,
  setReactProgress as _setRaw,
} from './_state'

/**
 * 暴露一个 Vue ref，UI 模板可以直接 v-if 引用。
 *
 * 注意：返回的是普通 ref，不是 reactive。模板中读 `progress.value` 才能拿到最新值。
 * 写入通过 setReactProgress() 完成，写入后 `progress.value` 自动同步。
 */
const _progressRef = ref<ReActProgressEvent | null>(null)

export function useReActProgress(): Ref<ReActProgressEvent | null> {
  return _progressRef
}

/** 设置当前 progress（onProgress 回调里调用） */
export function setReactProgress(e: ReActProgressEvent | null): void {
  _setRaw(e)
  // 同步到 ref，触发依赖更新
  _progressRef.value = e
}

/** 读取当前 progress（不开模板订阅时使用） */
export function getReactProgress(): ReActProgressEvent | null {
  return reactProgress
}
