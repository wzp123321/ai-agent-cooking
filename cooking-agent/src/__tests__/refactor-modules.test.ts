/**
 * 单元级 E2E：runReActLoop + finalize + timeout-watcher 三个抽出的模块
 * 直接调函数，不依赖 LLM，验证：
 *   1. runReActLoop 在 4 种结局下都返回正确结构
 *   2. finalize 在 4 种结局下都正确触发 onDone / 持久化
 *   3. timeout-watcher 的清理逻辑能扫到过期 pending
 */
import { runReActLoop } from '../agent/react-loop'
import { finalize } from '../agent/stream-finalizer'
import { cleanupStaleInteractives } from '../agent/timeout-watcher'
import { sessionRepo } from '../db/session.repository'
import { messageRepo } from '../db/message.repository'
import type { Message } from '../types'

async function testRunReActLoopDone() {
  const messages: Message[] = [{ role: 'user', content: 'test' }]
  const out = await runReActLoop(messages, {
    callLLM: async () => ({ content: 'final answer', tool_calls: undefined }),
    streamLLM: async (m, onC) => {
      onC('final answer')
    },
    handleTools: async () => ({ toolCount: 0, paused: false }),
    maxSteps: 5,
    logTag: 'test-done',
  })
  if (out.kind !== 'done') throw new Error('expected done, got ' + out.kind)
  if (out.fullContent !== 'final answer') throw new Error('wrong content: ' + out.fullContent)
  console.log('✅ testRunReActLoopDone')
}

async function testRunReActLoopEmpty() {
  const messages: Message[] = []
  const out = await runReActLoop(messages, {
    callLLM: async () => ({ content: null, tool_calls: undefined }),
    streamLLM: async () => {},
    handleTools: async () => ({ toolCount: 0, paused: false }),
    maxSteps: 5,
    logTag: 'test-empty',
  })
  if (out.kind !== 'empty') throw new Error('expected empty, got ' + out.kind)
  console.log('✅ testRunReActLoopEmpty')
}

async function testRunReActLoopPaused() {
  const messages: Message[] = []
  let onInteractive: any = () => {}
  const out = await runReActLoop(messages, {
    callLLM: async () => ({
      content: 'I need to ask',
      tool_calls: [
        {
          id: 'tc1',
          type: 'function',
          function: { name: 'ask_user_choice', arguments: '{}' },
        },
      ],
    }),
    streamLLM: async () => {},
    handleTools: async () => ({ toolCount: 1, paused: true }),
    onInteractive: (req) => onInteractive(req),
    maxSteps: 5,
    logTag: 'test-paused',
  })
  if (out.kind !== 'paused') throw new Error('expected paused, got ' + out.kind)
  if (out.totalToolCalls !== 1) throw new Error('wrong tool count: ' + out.totalToolCalls)
  console.log('✅ testRunReActLoopPaused')
}

async function testRunReActLoopCancelled() {
  const controller = new AbortController()
  controller.abort()
  const out = await runReActLoop([], {
    callLLM: async () => ({ content: 'should not reach', tool_calls: undefined }),
    streamLLM: async () => {},
    handleTools: async () => ({ toolCount: 0, paused: false }),
    signal: controller.signal,
    maxSteps: 5,
    logTag: 'test-cancelled',
  })
  if (out.kind !== 'cancelled') throw new Error('expected cancelled, got ' + out.kind)
  console.log('✅ testRunReActLoopCancelled')
}

async function testFinalizeDone() {
  const messages: Message[] = []
  let calledOnDone = ''
  await finalize(
    { kind: 'done', fullContent: 'hello', totalToolCalls: 0, reactLog: [] },
    {
      messages,
      sessionId: 'no-save-test',
      onDone: (s) => (calledOnDone = s),
      persist: async () => {}, // 不实际写 DB
      logTag: 'test-finalize',
    },
  )
  if (calledOnDone !== 'hello') throw new Error('onDone not called: ' + calledOnDone)
  if (messages.length !== 1) throw new Error('messages not pushed')
  if (messages[0].content !== 'hello') throw new Error('wrong pushed content')
  console.log('✅ testFinalizeDone')
}

async function testFinalizePausedNoOnDone() {
  const messages: Message[] = []
  let calledOnDone = false
  const r = await finalize(
    { kind: 'paused', totalToolCalls: 0, reactLog: [] },
    {
      messages,
      sessionId: 'no-save-test',
      onDone: () => (calledOnDone = true),
      persist: async () => {},
      logTag: 'test-paused-finalize',
    },
  )
  if (calledOnDone) throw new Error('onDone should NOT be called on paused')
  if (r.calledOnDone) throw new Error('calledOnDone should be false')
  if (r.finalContent !== '') throw new Error('finalContent should be empty')
  if (messages.length !== 0) throw new Error('paused should not push to messages')
  console.log('✅ testFinalizePausedNoOnDone')
}

async function testFinalizeCancelled() {
  const messages: Message[] = []
  let finalText = ''
  await finalize(
    { kind: 'cancelled', partialContent: 'partial' },
    {
      messages,
      sessionId: 'no-save-test',
      onDone: (s) => (finalText = s),
      persist: async () => {},
      logTag: 'test-cancel-finalize',
    },
  )
  if (!finalText.includes('[已中止]')) throw new Error('expected [已中止] marker, got: ' + finalText)
  if (messages.length !== 1) throw new Error('partial should be pushed')
  console.log('✅ testFinalizeCancelled')
}

async function testTimeoutWatcher() {
  // 准备一个 session 和一条"过期"pending（用旧时间戳注入）
  const sessionId = 'test-timeout-' + Date.now()
  const oldTs = Date.now() - 10 * 60 * 1000 // 10 分钟前（超过 5 分钟阈值）
  await sessionRepo.create(sessionId, 'timeout-test', Date.now())
  await sessionRepo.setPendingInteractive(sessionId, {
    id: 'fake-pending-' + Date.now(),
    name: 'ask_user_choice',
    arguments: '{}',
    created_at: oldTs,
  }, oldTs)
  // 跑清理
  const r = await cleanupStaleInteractives()
  if (r.cleaned < 1) throw new Error('expected at least 1 cleaned, got ' + r.cleaned)
  // 验证 session 上的 pending 已清
  const s = await sessionRepo.findById(sessionId)
  if (s?.pending_interactive) throw new Error('pending should be cleared, got: ' + JSON.stringify(s.pending_interactive))
  // 验证补了 tool 消息
  const msgs = await messageRepo.findBySessionId(sessionId)
  const toolMsg = msgs.find((m) => m.role === 'tool' && m.tool_call_id?.includes('fake-pending'))
  if (!toolMsg) throw new Error('expected tool message with skipped:true')
  const parsed = JSON.parse(toolMsg.content)
  if (!parsed.skipped || parsed.reason !== 'auto_timeout') throw new Error('wrong tool msg: ' + toolMsg.content)
  console.log('✅ testTimeoutWatcher')
  // 清理
  await sessionRepo.deleteById(sessionId, Date.now())
}

/**
 * P-修复测试：updateToolContentByCallId 应能 UPDATE 占位 tool 消息的内容。
 *
 * 验证：写一条 tool 占位消息 → update 它的 content → 内容被替换（不是新增一条）。
 */
async function testUpdateToolContentByCallId() {
  const sessionId = 'test-update-tool-' + Date.now()
  const toolCallId = 'tc-update-' + Date.now()
  await sessionRepo.create(sessionId, 'update-tool-test', Date.now())

  // 1. 写 assistant(tool_calls) 消息
  await messageRepo.insert(
    sessionId,
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: toolCallId, type: 'function', function: { name: 'ask_user_choice', arguments: '{}' } },
      ],
    },
    Date.now(),
  )
  // 2. 写占位 tool 消息
  await messageRepo.insert(
    sessionId,
    {
      role: 'tool',
      tool_call_id: toolCallId,
      content: JSON.stringify({ status: 'pending_user_choice', question: '?' }),
    },
    Date.now(),
  )

  const before = await messageRepo.findBySessionId(sessionId)
  const beforeTool = before.find((m) => m.role === 'tool' && m.tool_call_id === toolCallId)
  if (!beforeTool) throw new Error('placeholder not found')
  if (before.length !== 2) throw new Error('expected 2 messages (assistant+tool), got ' + before.length)

  // 3. UPDATE 占位消息的 content
  const newContent = JSON.stringify({ user_choice: ['A'], updated: true })
  const affected = await messageRepo.updateToolContentByCallId(sessionId, toolCallId, newContent, Date.now())
  if (affected !== 1) throw new Error('expected 1 row updated, got ' + affected)

  // 4. 验证：消息数量不变（仍是 2 条），content 被替换
  const after = await messageRepo.findBySessionId(sessionId)
  if (after.length !== 2) throw new Error('expected still 2 messages (1对1 preserved), got ' + after.length)
  const afterTool = after.find((m) => m.role === 'tool' && m.tool_call_id === toolCallId)
  if (!afterTool) throw new Error('tool msg disappeared after update')
  const parsed = JSON.parse(afterTool.content)
  if (!parsed.updated || parsed.user_choice?.[0] !== 'A') throw new Error('content not updated: ' + afterTool.content)
  // 严格 1对1 关系
  if (after.filter((m) => m.role === 'tool' && m.tool_call_id === toolCallId).length !== 1) {
    throw new Error('multiple tool messages for same tool_call_id (1对1 关系被破坏)')
  }
  console.log('✅ testUpdateToolContentByCallId')

  await sessionRepo.deleteById(sessionId)
}

/**
 * P-修复测试-2：loadMessages 应能为 pre-fix 时代脏数据合成占位 tool 消息。
 *
 * 场景：session 含 assistant(tool_calls) 但 0 条 tool 响应（pre-fix 时代产物）。
 * 验证：loadMessages 加载后，messages 数组里每条 tool_call_id 都有 1 对应 tool 消息。
 */
async function testLoadMessagesSynthesizesMissingToolResponses() {
  const sessionId = 'test-synth-legacy-' + Date.now()
  const toolCallId = 'tc-legacy-' + Date.now()
  await sessionRepo.create(sessionId, 'synth-test', Date.now())

  // 1. 写 system + user + 1 条 assistant(tool_calls) 0 条 tool 响应（脏数据）
  await messageRepo.insert(sessionId, { role: 'system', content: 'sys' }, Date.now())
  await messageRepo.insert(sessionId, { role: 'user', content: 'hi' }, Date.now())
  await messageRepo.insert(
    sessionId,
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: toolCallId, type: 'function', function: { name: 'ask_user_choice', arguments: '{}' } },
      ],
    },
    Date.now(),
  )

  // 2. 用反射调 private loadMessages
  const { CookingAgent } = await import('../agent')
  const agent = new CookingAgent()
  const loaded = await (agent as any).loadMessages(sessionId)

  // 3. 验证：原始 3 条 + 1 条合成占位 = 4 条
  if (loaded.length !== 4) throw new Error('expected 4 messages (3 原始 + 1 合成), got ' + loaded.length)
  // 4. 验证：assistant 消息之后有 1 条 tool 消息
  const assistantIdx = loaded.findIndex((m: any) => m.role === 'assistant' && m.tool_calls)
  const toolAfterAssistant = loaded[assistantIdx + 1]
  if (!toolAfterAssistant || toolAfterAssistant.role !== 'tool') {
    throw new Error('expected tool message right after assistant')
  }
  if (toolAfterAssistant.tool_call_id !== toolCallId) {
    throw new Error('synthesized tool_call_id mismatch: ' + toolAfterAssistant.tool_call_id)
  }
  // 5. 验证：合成消息标记了 synthesized_legacy
  const parsed = JSON.parse(toolAfterAssistant.content)
  if (parsed.status !== 'synthesized_legacy') {
    throw new Error('expected synthesized_legacy status, got: ' + toolAfterAssistant.content)
  }
  // 6. 验证：DB 没动（仍只 3 条原始消息）
  const dbRows = await messageRepo.findBySessionId(sessionId)
  if (dbRows.length !== 3) {
    throw new Error('expected DB untouched (3 messages), got ' + dbRows.length)
  }
  console.log('✅ testLoadMessagesSynthesizesMissingToolResponses')

  await sessionRepo.deleteById(sessionId)
}

async function main() {
  console.log('=== Refactor 模块 E2E 测试 ===')
  await testRunReActLoopDone()
  await testRunReActLoopEmpty()
  await testRunReActLoopPaused()
  await testRunReActLoopCancelled()
  await testFinalizeDone()
  await testFinalizePausedNoOnDone()
  await testFinalizeCancelled()
  await testTimeoutWatcher()
  await testUpdateToolContentByCallId()
  await testLoadMessagesSynthesizesMissingToolResponses()
  console.log('\n=== 全部通过 ===')
  // 主动关闭 MySQL 连接池，避免进程 hang
  const { closePool } = await import('../db')
  await closePool()
}

main().catch((err) => {
  console.error('❌ 测试失败：', err)
  process.exit(1)
})
