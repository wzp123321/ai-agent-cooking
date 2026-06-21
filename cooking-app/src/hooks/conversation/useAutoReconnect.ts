/**
 * ============================================================
 * conversation/useAutoReconnect.ts — SSE 网络异常自动重连
 * ============================================================
 *
 * P1-③：SSE 流可能在以下场景断开：
 *   - 弱网：fetch 阶段就 TCP reset
 *   - 移动端切后台：OS 杀 socket
 *   - 代理超时：Nginx/Vite 默认 60s 切断
 *   - DNS 抖动
 *
 * 自动重连策略：
 *   - 退避：1s → 2s → 4s（指数退避，base=1s, factor=2）
 *   - 上限：最多 3 次
 *   - 区分错误：
 *       AbortError         → 不重试（用户主动取消）
 *       重连 3 次仍失败     → 抛出最后一次错误
 *   - 重连期间 aiMsg 文本保留不重置
 *   - 重连期间通过 setReconnecting(true) 让 UI 显示提示
 *
 * ⚠️ 服务端的 ReAct 循环是有状态的——重连意味着重新建立 SSE 连接
 *    并触发新的 chatStream。已写入 aiMsg 的内容会保留，agent 重新
 *    处理时从 session 历史读取，所以会基于完整历史给出新回答。
 */

import { ref, type Ref } from 'vue'

const MAX_RETRY = 3
const BASE_DELAY_MS = 1_000
const FACTOR = 2

export interface AutoReconnectOptions {
  /** AbortSignal：用户在重连期间点停止则中止 */
  signal: AbortSignal
  /** 第 N 次重连时调用（1-based），用于 UI 显示 "重连中 (2/3)..." */
  onRetry?: (attempt: number, delayMs: number) => void
}

export interface AutoReconnectResult {
  /** 是否正处于重连等待中 */
  isReconnecting: Ref<boolean>
  /** 当前重试次数（1-based；0 表示未重试） */
  retryCount: Ref<number>
  /**
   * 包裹一个异步流式调用，自动处理重连。
   * 调用方传入的 fn 内部应：
   *   - 已经创建好 AbortController / POST 请求
   *   - 内部调用 consumeSSEStream
   *   - 出错时 throw Error
   */
  withReconnect<T>(fn: () => Promise<T>, opts: AutoReconnectOptions): Promise<T>
}

export function useAutoReconnect(): AutoReconnectResult {
  const isReconnecting = ref(false)
  const retryCount = ref(0)

  const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      const t = setTimeout(resolve, ms)
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t)
          reject(new DOMException('Aborted', 'AbortError'))
        },
        { once: true },
      )
    })

  async function withReconnect<T>(
    fn: () => Promise<T>,
    opts: AutoReconnectOptions,
  ): Promise<T> {
    let lastErr: unknown = null
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      if (opts.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }
      try {
        retryCount.value = attempt
        if (attempt > 0) isReconnecting.value = true
        return await fn()
      } catch (err) {
        const e = err as Error
        // 用户中止 → 不重试
        if (e.name === 'AbortError') {
          isReconnecting.value = false
          throw err
        }
        lastErr = err
        if (attempt >= MAX_RETRY) {
          isReconnecting.value = false
          break
        }
        const delay = BASE_DELAY_MS * Math.pow(FACTOR, attempt)
        console.warn(
          `[AutoReconnect] ⚠️ SSE 异常（${e.message}），${delay}ms 后第 ${attempt + 1}/${MAX_RETRY} 次重连…`,
        )
        opts.onRetry?.(attempt + 1, delay)
        try {
          await sleep(delay, opts.signal)
        } catch (sleepErr) {
          isReconnecting.value = false
          throw sleepErr
        }
      }
    }
    isReconnecting.value = false
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  return { isReconnecting, retryCount, withReconnect }
}
