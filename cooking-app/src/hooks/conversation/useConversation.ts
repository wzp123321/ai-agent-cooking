/**
 * ============================================================
 * conversation/useConversation.ts — 统一对外接口
 * ============================================================
 *
 * 组合 4 个子 hook：
 *   - useSendMessage         ：发送文本
 *   - useSendVisionMessage   ：发送图片
 *   - useInteractiveSubmit   ：提交交互式工具选择
 *   - useStopGeneration      ：停止生成
 *
 * 为什么还要这个聚合 hook？
 *   - 保持向后兼容：ChatView / InputBar 直接 useConversation() 拿所有方法
 *   - 共享模块级状态：所有子 hook 操作的 abortController / 计时器是同一份
 */

import { useSendMessage } from './useSendMessage'
import { useSendVisionMessage } from './useSendVisionMessage'
import { useInteractiveSubmit } from './useInteractiveSubmit'
import { useStopGeneration } from './useStopGeneration'

export const useConversation = () => {
  const { sendMessage } = useSendMessage()
  const { sendVisionMessage } = useSendVisionMessage()
  const { submitInteractiveChoice } = useInteractiveSubmit()
  const { stopGeneration, abort } = useStopGeneration()

  return {
    sendMessage,
    sendVisionMessage,
    submitInteractiveChoice,
    stopGeneration,
    abort,
  }
}
