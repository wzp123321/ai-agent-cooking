/**
 * ============================================================
 * useConversation — 对话内容发送 Hook
 * ============================================================
 *
 * 职责：
 *   封装消息发送的完整流程（用户消息 → SSE 流式请求 → AI 回复）
 *   操作 store 中的 sessions / messages / loading 状态
 *
 * 使用方式：
 *   const { sendMessage } = useConversation()
 *   await sendMessage('红烧肉怎么做')
 */

import { ElMessage } from 'element-plus'
import { useChatStore } from '@/stores/chat'
import { sendChatStream, sendVisionChat, continueInteractive } from '@/api/chat'
import { MAX_SESSION_TITLE_LENGTH, ERROR_MSG_AGENT_OFFLINE } from '@/constants'
import type { ChatMessage, ToolCall, ToolCallDelta, FinishReason, InteractiveRequest } from '@/types'

/**
 * 流式请求超时间隔（毫秒）
 *
 * 当后端 Agent 卡死或 LLM API 无响应时，
 * 前端不能无限等待。60 秒后自动中止请求，
 * 清理 loading 状态并显示超时提示。
 */
const STREAM_TIMEOUT_MS = 60_000

const genId = (): string => {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

// ════════════════════════════════════════════════════════════
// 关键：abortController / streamTimer / 状态改为模块级变量，
// 保证 useConversation() 无论被多少个组件调用，都共享同一份实例。
//
// 设计动机：
//   - ChatView 调用 useConversation() 拿到 submitInteractiveChoice 向下传递
//   - InputBar  也调用 useConversation() 拿到 sendMessage / stopGeneration
//   - 若不共享实例，会出现「ChatView 持有的 abortController 与 InputBar 不同」，
//     导致 InputBar 点「停止」时无法真正取消 ChatView 起的请求。
//
// 替代方案对比：
//   ❌ 改成 Pinia store：会污染 store 概念边界（store 管状态，hook 管流程）
//   ❌ props 透传：MessageList → MessageBubble 链路过长
//   ✅ 模块级单例：最小改动，符合"hook 内部用模块状态"惯例
// ════════════════════════════════════════════════════════════
let abortController: AbortController | null = null
let streamTimer: ReturnType<typeof setTimeout> | null = null

const clearStreamTimer = (): void => {
  if (streamTimer !== null) {
    clearTimeout(streamTimer)
    streamTimer = null
  }
}

export const useConversation = () => {
  const store = useChatStore()

  const abort = (): void => {
    clearStreamTimer()
    if (abortController) {
      abortController.abort()
      abortController = null
    }
  }

  const stopGeneration = (): void => {
    if (!abortController) return

    console.info('[Conversation] 🛑 用户手动中止生成')
    clearStreamTimer()
    /**
     * 调用 abort() 触发的链路：
     *   1. fetch() 收到 AbortError → catch 中调用 onError
     *   2. sendChatStream 的 catch 中调用外层 catch 的 onError
     *   3. 本方 sendMessage 的 catch(err) 捕获 → 清理状态
     *
     * 但 onError 可能因 AbortError 直接 return 而不被调用，
     * 因此这里也要显式清理 loading / streaming / abortController。
     */
    abortController.abort()
    abortController = null
    store.loading = false

    const session = store.currentSession
    const aiMsg = session.messages[session.messages.length - 1]
    if (aiMsg && aiMsg.streaming) {
      aiMsg.streaming = false
      if (aiMsg.content.length > 0) {
        aiMsg.content += '\n\n[已中止]'
      }
      session.updatedAt = Date.now()
    }
  }

  const sendMessage = async (content: string): Promise<void> => {
    if (store.loading) {
      console.warn('[Conversation] ⚠️ 正在发送中，忽略重复请求')
      return
    }
    if (!content.trim()) {
      console.warn('[Conversation] ⚠️ 收到空消息，忽略')
      return
    }

    abort()

    store.loading = true
    const session = store.currentSession

    console.info(`[Conversation] 📤 发送消息 [${session.id}]：${content.slice(0, 50)}…`)

    if (session.messages.length === 0) {
      session.title = content.slice(0, MAX_SESSION_TITLE_LENGTH) + (content.length > MAX_SESSION_TITLE_LENGTH ? '…' : '')
      console.info(`[Conversation] 📝 会话标题更新为：${session.title}`)
    }

    const userMsg: ChatMessage = {
      id: genId(),
      role: 'user',
      content,
      timestamp: Date.now(),
    }
    session.messages.push(userMsg)
    session.updatedAt = Date.now()

    session.messages.push({
      id: genId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      streaming: true,
    })
    const aiMsg = session.messages[session.messages.length - 1]
    console.info('[Conversation] ⏳ AI 消息已追加，等待流式响应…')

    abortController = new AbortController()

    /**
     * 启动超时计时器 — 防止后端卡死导致前端无限等待
     *
     * 触发场景：
     *   - LLM API 调用卡住（网络拥塞、服务端限流等待）
     *   - Agent 进程进入死循环
     *   - Express 线程被阻塞（同步 IO、JSON 解析大文件等）
     *
     * 超时后：中止 fetch → 清理 loading → 显示超时提示
     *   ① 已有部分内容 → 追加 "[回答超时]" 标记
     *   ② 无任何内容   → 填充完整超时提示文本
     */
    streamTimer = setTimeout(() => {
      if (!abortController) return
      console.warn('[Conversation] ⏰ 流式请求超时')
      abortController.abort()
      abortController = null
      store.loading = false
      if (aiMsg.streaming) {
        aiMsg.streaming = false
        if (!aiMsg.content) {
          aiMsg.content = '回答超时，请稍后重试。'
        } else {
          aiMsg.content += '\n\n[回答超时]'
        }
      }
    }, STREAM_TIMEOUT_MS)

    try {
      await sendChatStream(
        content,
        session.id,
        (chunk) => {
          aiMsg.content += chunk
        },
        (_full, finishReason: FinishReason) => {
          /**
           * 流结束（finish_reason != 'tool_calls'）。
           * 覆盖 stop / length / content_filter 三种情况。
           * length 触发的截断在文案上要明示，避免用户误以为是完整回答。
           */
          clearStreamTimer()
          aiMsg.streaming = false
          if (finishReason === 'length') {
            aiMsg.content = (aiMsg.content || '') + '\n\n[回答因达到长度上限被截断]'
          } else if (finishReason === 'content_filter') {
            aiMsg.content = (aiMsg.content || '') + '\n\n[回答因内容安全被过滤]'
          }
          session.updatedAt = Date.now()
          store.loading = false
          abortController = null
          console.info(
            `[Conversation] ✅ AI 回复完成（finish_reason=${finishReason}），共 ${aiMsg.content.length} 字符`,
          )
        },
        (err) => {
          clearStreamTimer()
          if ((err as any)?.name === 'AbortError') {
            console.info('[Conversation] 🛑 请求已被取消')
            aiMsg.streaming = false
            store.loading = false
            abortController = null
            return
          }
          aiMsg.content = ERROR_MSG_AGENT_OFFLINE
          aiMsg.streaming = false
          store.loading = false
          abortController = null
          ElMessage.error('Agent 服务请求失败，请检查后端是否已启动')
          console.error('[Conversation] ❌ 流式请求失败：', err)
        },
        abortController.signal,
        // 工具调用增量：UI 实时显示"正在调用 XX"，并把聚合中的 toolCalls 挂到消息上
        (delta: ToolCallDelta) => {
          if (!aiMsg.toolCalls) aiMsg.toolCalls = []
          // 占位：依据 index 占位，后续 onToolCalls 聚合后会整体替换
          aiMsg.toolCalls[delta.index] = {
            id: delta.id ?? aiMsg.toolCalls[delta.index]?.id ?? '',
            type: 'function',
            function: {
              name:
                delta.function?.name ??
                aiMsg.toolCalls[delta.index]?.function.name ??
                '',
              arguments:
                (aiMsg.toolCalls[delta.index]?.function.arguments ?? '') +
                (delta.function?.arguments ?? ''),
            },
          }
        },
        // 工具调用聚合完成（finish_reason='tool_calls'）：
        // 后端的多 Agent / AgentExecutor 通常会在同一连接里继续推工具结果 + 最终文本，
        // 因此这里只更新 toolCalls、保持 streaming=true，等待后续 chunk 与下一个 onDone/onToolCalls。
        (calls: ToolCall[]) => {
          console.info(`[Conversation] 🔧 收到 ${calls.length} 个工具调用：`, calls.map((c) => c.function.name).join(', '))
          aiMsg.toolCalls = calls
          aiMsg.content = aiMsg.content || ''
          session.updatedAt = Date.now()
        },
        // 交互式工具请求：把 InteractiveRequest 挂到 aiMsg 上，关闭 streaming 状态。
        // 注意：
        //   1) 不重置 aiMsg.content，LLM 在调用工具前可能输出了过渡文本（如"让我先问您..."）
        //   2) loading=false —— 进入"等待用户"状态，前端的发送按钮可再次点击
        //   3) 等待用户在 MessageBubble 中点击选项后由 submitInteractiveChoice() 接管
        (req: InteractiveRequest) => {
          console.info(
            `[Conversation] 🙋 收到交互式请求 [${session.id}]：${req.question}（${req.options.length} 选项, ${req.multiSelect ? '多选' : '单选'}）`,
          )
          clearStreamTimer()
          aiMsg.interactive = req
          aiMsg.streaming = false
          store.loading = false
          abortController = null
        },
      )
    } catch (err) {
      clearStreamTimer()
      if ((err as any)?.name === 'AbortError') {
        console.info('[Conversation] 🛑 请求已被取消')
        aiMsg.streaming = false
        store.loading = false
        abortController = null
        return
      }
      aiMsg.content = `❌ 未知错误：${(err as Error).message}`
      aiMsg.streaming = false
      store.loading = false
      abortController = null
      console.error('[Conversation] ❌ sendMessage 未捕获的错误：', err)
    }
  }

  /**
   * submitInteractiveChoice — 用户在 MessageBubble 上点击选项后调用
   *
   * 流程：
   *   1) 找到上一条带有 interactive 字段且未 resolved 的 aiMsg，标记为已解决 + 记录选择
   *   2) 追加一条 user 消息（"已选择: X"），让会话自然延续
   *   3) 追加一条新的 aiMsg 占位（用于流式接收继续回答的文本）
   *   4) 调用 continueInteractive() 开启新 SSE 流
   *   5) 期间如果 LLM 又触发 ask_user_choice → onInteractiveRequest 回调（复用）
   *   6) 最终 LLM 给出文本 → onDone 回调
   *
   * 异常处理：
   *   - 如果没有 pending 的 interactive（前端状态被破坏），直接 return
   *   - 网络错误由 onError 处理，与普通流一致
   */
  const submitInteractiveChoice = async (interactiveId: string, choice: string[]): Promise<void> => {
    const session = store.currentSession
    if (!session) {
      console.warn('[Conversation] ⚠️ 没有当前会话，忽略交互选择')
      return
    }

    // 找到上一条 pending 的交互请求
    const targetMsg = session.messages.find(
      (m) => m.role === 'assistant' && m.interactive && !m.interactiveResolved && m.interactive.id === interactiveId,
    )
    if (!targetMsg || !targetMsg.interactive) {
      console.warn(`[Conversation] ⚠️ 未找到 interactiveId=${interactiveId} 的待回答请求`)
      return
    }

    // 标记已解决，避免按钮重复点击
    targetMsg.interactiveResolved = true
    targetMsg.interactiveChoice = choice

    // 追加 user 消息（让用户选择成为会话历史的一部分，符合聊天 UI 习惯）
    const choiceText = choice.join('、')
    const userMsg: ChatMessage = {
      id: genId(),
      role: 'user',
      content: `已选择：${choiceText}`,
      timestamp: Date.now(),
    }
    session.messages.push(userMsg)
    session.updatedAt = Date.now()

    // 追加新的 aiMsg 占位
    session.messages.push({
      id: genId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      streaming: true,
    })
    const resumedMsg = session.messages[session.messages.length - 1]

    // 启动新一轮
    abort()
    store.loading = true
    abortController = new AbortController()
    streamTimer = setTimeout(() => {
      if (!abortController) return
      console.warn('[Conversation] ⏰ 交互恢复流超时')
      abortController.abort()
      abortController = null
      store.loading = false
      if (resumedMsg.streaming) {
        resumedMsg.streaming = false
        if (!resumedMsg.content) {
          resumedMsg.content = '恢复超时，请稍后重试。'
        } else {
          resumedMsg.content += '\n\n[回答超时]'
        }
      }
    }, STREAM_TIMEOUT_MS)

    console.info(`[Conversation] ▶️ 提交交互选择 [${session.id}]：${choiceText}`)

    try {
      await continueInteractive(
        session.id,
        interactiveId,
        choice,
        (chunk) => {
          resumedMsg.content += chunk
        },
        (_full, finishReason: FinishReason) => {
          clearStreamTimer()
          resumedMsg.streaming = false
          if (finishReason === 'length') {
            resumedMsg.content = (resumedMsg.content || '') + '\n\n[回答因达到长度上限被截断]'
          } else if (finishReason === 'content_filter') {
            resumedMsg.content = (resumedMsg.content || '') + '\n\n[回答因内容安全被过滤]'
          }
          session.updatedAt = Date.now()
          store.loading = false
          abortController = null
          console.info(
            `[Conversation] ✅ 交互恢复完成（finish_reason=${finishReason}），共 ${resumedMsg.content.length} 字符`,
          )
        },
        (err) => {
          clearStreamTimer()
          if ((err as any)?.name === 'AbortError') {
            console.info('[Conversation] 🛑 交互恢复已取消')
            resumedMsg.streaming = false
            store.loading = false
            abortController = null
            return
          }
          resumedMsg.content = ERROR_MSG_AGENT_OFFLINE
          resumedMsg.streaming = false
          store.loading = false
          abortController = null
          ElMessage.error('Agent 服务请求失败，请检查后端是否已启动')
          console.error('[Conversation] ❌ 交互恢复失败：', err)
        },
        abortController.signal,
        // 恢复后又遇到新的交互式工具：把新请求挂到当前 resumedMsg 上
        (req: InteractiveRequest) => {
          console.info(`[Conversation] 🙋 恢复后又遇到交互式请求：${req.question}`)
          clearStreamTimer()
          resumedMsg.interactive = req
          resumedMsg.streaming = false
          store.loading = false
          abortController = null
        },
      )
    } catch (err) {
      clearStreamTimer()
      if ((err as any)?.name === 'AbortError') {
        resumedMsg.streaming = false
        store.loading = false
        abortController = null
        return
      }
      resumedMsg.content = `❌ 未知错误：${(err as Error).message}`
      resumedMsg.streaming = false
      store.loading = false
      abortController = null
      console.error('[Conversation] ❌ submitInteractiveChoice 未捕获的错误：', err)
    }
  }

  const sendVisionMessage = async (imageBase64: string, text?: string): Promise<void> => {
    if (store.loading) {
      console.warn('[Conversation] ⚠️ 正在发送中，忽略重复请求')
      return
    }

    abort()

    store.loading = true
    const session = store.currentSession

    const contentText = text || '帮我看看这些食材可以做什么菜？'
    console.info(`[Conversation] 📷 发送图片消息 [${session.id}]`)

    if (session.messages.length === 0) {
      session.title = contentText.slice(0, MAX_SESSION_TITLE_LENGTH) + (contentText.length > MAX_SESSION_TITLE_LENGTH ? '…' : '')
    }

    const userMsg: ChatMessage = {
      id: genId(),
      role: 'user',
      content: text || '📷 拍照识别食材',
      timestamp: Date.now(),
      image: `data:image/jpeg;base64,${imageBase64}`,
    }
    session.messages.push(userMsg)
    session.updatedAt = Date.now()

    session.messages.push({
      id: genId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      streaming: true,
    })
    const aiMsg = session.messages[session.messages.length - 1]

    try {
      const result = await sendVisionChat(imageBase64, text)

      aiMsg.content = result.content
      aiMsg.streaming = false
      session.updatedAt = Date.now()
      store.loading = false
      console.info(`[Conversation] ✅ 图片识别完成，共 ${aiMsg.content.length} 字符`)
    } catch (err) {
      aiMsg.content = `❌ 图片识别失败：${(err as Error).message}`
      aiMsg.streaming = false
      store.loading = false
      ElMessage.error('图片识别失败，请检查 Vision API 配置')
      console.error('[Conversation] ❌ 图片识别失败：', err)
    }
  }

  return { sendMessage, sendVisionMessage, stopGeneration, abort, submitInteractiveChoice }
}