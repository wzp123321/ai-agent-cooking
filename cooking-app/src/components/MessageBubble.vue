<template>
  <div class="message" :class="message.role">
    <!--
      头像设计 — SVG 矢量图标，替代原来的 emoji 👤/👨‍🍳
        用户：圆形人物剪影（person icon），琥珀渐变背景
        助手：五角星剪影（star icon），暖灰白渐变背景
        助手生成中：外围叠加 avatarPulse 呼吸光晕，提示用户 AI 正在工作
    -->
    <div class="avatar" :class="`${message.role}-avatar`">
      <svg v-if="message.role === 'user'" class="avatar-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="1.6" />
        <path d="M5 21c0-3.9 3.1-7 7-7s7 3.1 7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </svg>
      <svg v-else class="avatar-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="m12 2 2.4 5.2L20 9.5l-4 3.6 1 5.4L12 16l-5 2.5 1-5.4L4 9.5l5.6-2.3L12 2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
      </svg>
      <div v-if="message.role === 'assistant' && message.streaming" class="avatar-pulse" />
    </div>

    <div class="bubble-wrapper">
      <div class="bubble" :class="[message.role, { thinking: isThinking }]">
        <template v-if="message.role === 'user'">
          <img v-if="message.image" :src="message.image" class="user-image" alt="用户上传图片" />
          <span v-if="message.content" class="user-text">{{ message.content }}</span>
        </template>
        <template v-else>
          <!--
            工具调用列表 — 当 finish_reason='tool_calls' 时渲染
            每个工具调用以可展开卡片形式展示：
              - 头部：🔧 工具名 + 参数摘要（默认折叠）
              - 展开后：完整 JSON 参数
              - 流式聚合中显示"调用中…"动效
          -->
          <div v-if="message.toolCalls && message.toolCalls.length > 0" class="tool-calls">
            <div
              v-for="(tc, i) in message.toolCalls"
              :key="tc.id || i"
              class="tool-call"
              :class="{ expanded: expandedTools[i], 'is-streaming': message.streaming && !message.content }"
            >
              <button class="tool-call-header" @click="toggleTool(i)" type="button">
                <span class="tool-icon">🔧</span>
                <span class="tool-name">{{ tc.function.name || '调用中…' }}</span>
                <span v-if="message.streaming && !message.content" class="tool-streaming">调用中…</span>
                <span v-else class="tool-summary">{{ summarizeArgs(tc.function.arguments) }}</span>
                <span class="tool-toggle">{{ expandedTools[i] ? '▾' : '▸' }}</span>
              </button>
              <pre v-if="expandedTools[i]" class="tool-args">{{ formatArgs(tc.function.arguments) }}</pre>
            </div>
          </div>
          <!--
            思考中指示器 — AI 开始生成但尚无内容时的过渡 UI
              显示 "思考中" 文字 + 三个弹跳点动画
              每个点的动画错开 0.2s，产生波浪式弹跳效果
              气泡边框在 thinking 状态下变为琥珀色（accent）
          -->
          <div v-if="isThinking" class="thinking-indicator">
            <span class="thinking-label">思考中</span>
            <span class="thinking-dots">
              <span class="dot" /><span class="dot" /><span class="dot" />
            </span>
          </div>
          <div v-if="message.content" class="markdown-body" v-html="renderedContent" />
          <span v-if="message.streaming && message.content" class="typing-cursor" />
          <!--
            交互式工具请求（ask_user_choice） — 范式 B
            渲染位置：在主内容之后，不打乱已有的 markdown 区域。
            状态机：
              pending  (!interactiveResolved) : 渲染可点击按钮/复选框
              resolved ( interactiveResolved) : 替换为 "已选择: X" 灰字提示
            多选模式：每个选项独立复选框，"提交" 按钮始终可点；
                    至少勾选一项才能提交。
            单选模式：点击即提交，无需额外按钮。
            提交中：禁用所有按钮，避免重复点击。
          -->
          <InteractiveChoiceCard
            v-if="message.interactive"
            :request="message.interactive"
            :resolved="!!message.interactiveResolved"
            :choice="message.interactiveChoice"
            :submitting="isSubmitting"
            @select="onSelect"
          />
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue'
import { marked } from 'marked'
import InteractiveChoiceCard from '@/components/InteractiveChoiceCard.vue'
import type { ChatMessage } from '@/types'

const props = defineProps<{
  message: ChatMessage
  submitInteractiveChoice: (id: string, choice: string[]) => Promise<void>
}>()

// 提交中状态：控制按钮 disabled 状态，避免用户重复点击。
// 注意：此状态是本地（per-message）的，关闭后会自动重置。
const isSubmitting = ref(false)

const onSelect = async (choice: string[]): Promise<void> => {
  if (!props.message.interactive || isSubmitting.value) return
  isSubmitting.value = true
  try {
    await props.submitInteractiveChoice(props.message.interactive.id, choice)
  } catch (err) {
    // submitInteractiveChoice 内部已处理错误，这里只是兜底
    console.error('[MessageBubble] ❌ 提交交互选择失败：', err)
  } finally {
    isSubmitting.value = false
  }
}

const isThinking = computed(
  () =>
    props.message.role === 'assistant' &&
    props.message.streaming &&
    !props.message.content &&
    (!props.message.toolCalls || props.message.toolCalls.length === 0),
)

// 工具调用展开/折叠状态（按 index 索引）
const expandedTools = ref<Record<number, boolean>>({})
const toggleTool = (i: number): void => {
  expandedTools.value[i] = !expandedTools.value[i]
}

/**
 * 解析并格式化工具参数。
 * 工具参数是 LLM 流式追加的 JSON 字符串，常见问题：
 *   - 还没追加完：JSON.parse 会抛错
 *   - 不是合法 JSON：同上
 *   - 嵌套对象/数组：直接 JSON.stringify 即可
 * 用 try-catch 兜底，解析失败时返回原始字符串（带类型标注）。
 */
const formatArgs = (raw: string): string => {
  if (!raw) return '(空参数)'
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

/**
 * 工具参数摘要 — 折叠态展示，避免长 JSON 撑爆气泡宽度。
 * 策略：截取 key/value 拼成简短列表。
 */
const summarizeArgs = (raw: string): string => {
  if (!raw) return ''
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    const parts = Object.entries(obj).map(([k, v]) => {
      const value = typeof v === 'string' ? v : JSON.stringify(v)
      const short = value.length > 16 ? value.slice(0, 16) + '…' : value
      return `${k}=${short}`
    })
    return parts.join(' · ')
  } catch {
    // 流式追加中 JSON 还不完整时，截前 24 字符作为占位
    return raw.length > 24 ? raw.slice(0, 24) + '…' : raw
  }
}

const renderedContent = ref<string>('')
let parseTimer: ReturnType<typeof setTimeout> | null = null
let lastParsedLength = 0

const parseMarkdown = () => {
  const text = props.message.content
  if (!text) {
    renderedContent.value = ''
    lastParsedLength = 0
    return
  }
  const len = text.length
  if (len !== lastParsedLength) {
    renderedContent.value = marked.parse(text) as string
    lastParsedLength = len
  }
}

parseMarkdown()

watch(
  () => props.message.content,
  () => {
    if (props.message.streaming) {
      if (!parseTimer) {
        parseTimer = setTimeout(() => {
          parseTimer = null
          parseMarkdown()
        }, 60)
      }
    } else {
      if (parseTimer) {
        clearTimeout(parseTimer)
        parseTimer = null
      }
      parseMarkdown()
    }
  },
)

onUnmounted(() => {
  if (parseTimer) clearTimeout(parseTimer)
})
</script>

<style scoped>
.message {
  display: flex;
  gap: clamp(10px, 2vw, 14px);
  animation: messageSlideIn var(--duration-slow) var(--ease-out-back) both;
  max-width: min(860px, 100%);
  /**
   * CSS 虚拟滚动 — content-visibility: auto
   *
   * 原理：浏览器跳过视口外元素的渲染（paint + layout），
   *      仅在元素接近视口时才渲染。对 DOM 树本身无影响，
   *      因此 v-for 不需要修改。
   *
   * contain-intrinsic-size 提供预估高度，防止滚动条跳动。
   * 每条消息大约 80-300px，取 120px 作为估算基准。
   *
   * 兼容性：Chrome 85+, Edge 85+。Firefox 不支持但会忽略。
   */
  content-visibility: auto;
  contain-intrinsic-size: auto 120px;
}

.message.user {
  flex-direction: row-reverse;
  margin-inline-start: auto;
}

@keyframes messageSlideIn {
  from {
    opacity: 0;
    transform: translateY(16px) scale(0.97);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.avatar {
  --avatar-size: clamp(34px, 5vw, 40px);
  width: var(--avatar-size);
  height: var(--avatar-size);
  border-radius: var(--radius-full);
  flex-shrink: 0;
  display: grid;
  place-items: center;
  align-self: flex-end;
  position: relative;
  transition:
    transform var(--duration-fast) var(--ease-out-back),
    box-shadow var(--duration-fast) var(--ease-out-expo);
}

.avatar-icon {
  width: 52%;
  height: 52%;
}

.user-avatar {
  background: linear-gradient(145deg, #f0a030, #e88a1a);
  color: #fff;
  box-shadow:
    0 2px 8px rgba(232, 138, 26, 0.28),
    inset 0 1px 0 rgba(255, 255, 255, 0.2);
}

.assistant-avatar {
  background: linear-gradient(145deg, #f5f3ef, #eae7e0);
  color: var(--accent-cool);
  box-shadow:
    0 2px 8px rgba(0, 0, 0, 0.06),
    inset 0 1px 0 rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(0, 0, 0, 0.05);
}

.avatar-pulse {
  position: absolute;
  inset: -3px;
  border-radius: inherit;
  border: 2px solid var(--accent);
  opacity: 0;
  animation: avatarPulse 2s ease-in-out infinite;
}

@keyframes avatarPulse {
  0%, 100% { opacity: 0; transform: scale(1); }
  50%      { opacity: 0.35; transform: scale(1.08); }
}

.bubble-wrapper {
  max-width: calc(100% - var(--avatar-size) - clamp(10px, 2vw, 14px));
  display: flex;
  flex-direction: column;
}

.bubble {
  padding: 12px 16px;
  border-radius: var(--radius-md);
  font-size: 14px;
  line-height: 1.72;
  overflow-wrap: break-word;
  word-break: break-word;
  transition:
    box-shadow var(--duration-fast) var(--ease-out-expo),
    border-color var(--duration-fast) var(--ease-out-expo);
  position: relative;
}

.bubble.user {
  background: linear-gradient(145deg, #f0a030, #e07b1e);
  color: #fff;
  border-end-end-radius: 5px;
  box-shadow: 0 4px 16px rgba(232, 138, 26, 0.2);
}

.bubble.assistant {
  background: var(--bg-card);
  border: 1px solid var(--border);
  color: var(--text-primary);
  border-end-start-radius: 5px;
  box-shadow: var(--shadow-xs);
}

.bubble.assistant:hover {
  border-color: var(--border-light);
}

.bubble.assistant.thinking {
  border-color: var(--border-accent);
  background: linear-gradient(145deg, #fffefb, #faf8f4);
  box-shadow: 0 0 20px rgba(232, 138, 26, 0.06);
}

.user-image {
  max-width: 240px;
  max-height: 240px;
  border-radius: var(--radius-xs);
  object-fit: cover;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}

.user-text {
  word-break: break-word;
}

/**
 * 工具调用卡片样式
 *   - 卡片：圆角 + 浅灰背景 + 细边框，与气泡形成视觉分层
 *   - 头部：横向 flex，左侧图标 / 中间名+参数 / 右侧折叠箭头
 *   - 折叠态：仅显示一行；展开态：pre 块展示完整参数
 */
.tool-calls {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
}

.tool-call {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-soft, rgba(0, 0, 0, 0.03));
  overflow: hidden;
  transition: border-color var(--duration-fast) var(--ease-out-expo);
}

.tool-call.is-streaming {
  border-color: var(--accent);
  animation: toolPulse 1.4s ease-in-out infinite;
}

@keyframes toolPulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(0, 0, 0, 0); }
  50% { box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.15); }
}

.tool-call-header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  background: transparent;
  border: 0;
  cursor: pointer;
  font: inherit;
  color: inherit;
  text-align: left;
}

.tool-icon {
  font-size: 14px;
  line-height: 1;
}

.tool-name {
  font-weight: 600;
  font-size: 13px;
  color: var(--accent);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
}

.tool-summary {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-streaming {
  flex: 1;
  font-size: 12px;
  color: var(--accent);
  font-style: italic;
}

.tool-toggle {
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.tool-args {
  margin: 0;
  padding: 8px 12px 12px;
  font-size: 12px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
  background: rgba(0, 0, 0, 0.04);
  color: var(--text);
  border-top: 1px solid var(--border);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow: auto;
}

.thinking-indicator {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
}

.thinking-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-muted);
  letter-spacing: 0.02em;
}

.thinking-dots {
  display: flex;
  gap: 4px;
  align-items: center;
}

.thinking-dots .dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
  opacity: 0.4;
  animation: dotBounce 1.4s ease-in-out infinite;
}

.thinking-dots .dot:nth-child(2) {
  animation-delay: 0.2s;
}

.thinking-dots .dot:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes dotBounce {
  0%, 80%, 100% {
    opacity: 0.25;
    transform: translateY(0);
  }
  40% {
    opacity: 0.9;
    transform: translateY(-5px);
  }
}

:deep(.markdown-body) {
  font-size: inherit;
  line-height: inherit;
}

:deep(.markdown-body h1),
:deep(.markdown-body h2),
:deep(.markdown-body h3) {
  font-weight: 700;
  color: var(--text-primary);
  margin: 16px 0 8px;
  letter-spacing: -0.01em;
}

:deep(.markdown-body h1) { font-size: 1.4em; }
:deep(.markdown-body h2) {
  font-size: 1.2em;
  border-bottom: 1px solid var(--border);
  padding-bottom: 6px;
}
:deep(.markdown-body h3) { font-size: 1.05em; }

:deep(.markdown-body code) {
  background: var(--bg-elevated);
  color: var(--accent-light);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 0.9em;
}

:deep(.markdown-body pre) {
  background: var(--bg-deep);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 14px 16px;
  overflow-x: auto;
  margin: 10px 0;
}

:deep(.markdown-body pre code) {
  background: transparent;
  color: var(--text-secondary);
  padding: 0;
}

:deep(.markdown-body ul),
:deep(.markdown-body ol) {
  padding-inline-start: 20px;
  margin: 6px 0;
}

:deep(.markdown-body li) { margin: 3px 0; }

:deep(.markdown-body p) { margin: 6px 0; }

:deep(.markdown-body strong) {
  color: var(--accent-light);
  font-weight: 600;
}

:deep(.markdown-body blockquote) {
  border-left: 3px solid var(--accent);
  padding: 4px 14px;
  margin: 10px 0;
  color: var(--text-secondary);
  background: var(--accent-soft);
  border-radius: 0 var(--radius-xs) var(--radius-xs) 0;
}

:deep(.markdown-body table) {
  width: 100%;
  border-collapse: collapse;
  margin: 10px 0;
  font-size: 0.9em;
}

:deep(.markdown-body th),
:deep(.markdown-body td) {
  padding: 8px 12px;
  border: 1px solid var(--border);
  text-align: left;
}

:deep(.markdown-body th) {
  background: var(--bg-elevated);
  font-weight: 600;
}

:deep(.markdown-body tr:nth-child(even)) {
  background: rgba(0, 0, 0, 0.015);
}

:deep(.markdown-body a) {
  color: var(--accent-light);
  text-decoration: none;
}

:deep(.markdown-body a:hover) {
  text-decoration: underline;
}

.typing-cursor {
  display: inline-block;
  width: 2px;
  height: 1.15em;
  background: linear-gradient(to bottom, var(--accent), var(--accent-light));
  margin-inline-start: 3px;
  vertical-align: text-bottom;
  border-radius: 1px;
  animation: cursorBlink 0.7s step-end infinite;
}

@keyframes cursorBlink {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0; }
}

@media (width < 640px) {
  .bubble {
    padding: 10px 14px;
  }
}
</style>