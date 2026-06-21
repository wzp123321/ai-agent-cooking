/**
 * ============================================================
 * hooks/conversation — 对话流程管理
 * ============================================================
 *
 * 模块化拆分：
 *   - useConversation         : 公共入口（推荐使用）
 *   - useSendMessage          : 发送文本
 *   - useSendVisionMessage    : 发送图片
 *   - useInteractiveSubmit    : 提交交互式工具选择
 *   - useStopGeneration       : 停止 / 中止
 *   - useStreamTimers         : 双计时器 + 卡住检测
 *   - useStreamEvents         : SSE 回调工厂
 *   - useAutoReconnect        : 网络异常自动重连
 *
 * 内部模块（不应直接 import）：
 *   - _state                  : 共享模块级状态
 */

export { useConversation } from './useConversation'
export { useAutoReconnect } from './useAutoReconnect'
