<template>
  <div class="messages-container" ref="containerRef" @scroll="onScroll">

    <WelcomeScreen :visible="chatStore.messages.length === 0" />

    <div class="messages-list">
      <MessageBubble
        v-for="msg in chatStore.messages"
        :key="msg.id"
        :message="msg"
        :submit-interactive-choice="submitInteractiveChoice"
      />
    </div>

  </div>
</template>

<script setup lang="ts">
import { inject } from 'vue'
import { useChatStore } from '@/stores/chat'
import { useScrollToBottom } from '@/hooks/useScrollToBottom'
import MessageBubble from '@/components/MessageBubble/index.vue'
import WelcomeScreen from '@/components/WelcomeScreen.vue'

const chatStore = useChatStore()

/**
 * 从 ChatView 注入 submitInteractiveChoice。
 *
 * 用 inject 而非再调 useConversation() 的原因：
 *   useConversation 内部用 module-level 单例（见 useConversation.ts 顶部注释），
 *   但若 MessageList 也在此调一次，函数闭包会被重建且一些模块状态语义变模糊。
 *   inject 直接拿到 ChatView 提供的同一引用，最干净。
 */
const submitInteractiveChoice = inject<(id: string, choice: string[]) => Promise<void>>(
  'submitInteractiveChoice',
  async (_id: string, _choice: string[]) => {
    console.warn('[MessageList] ⚠️ submitInteractiveChoice 未注入，请检查 ChatView 是否提供了它')
  },
)

/**
 * 自动滚底触发器 — 避免全量 content 拼接
 *
 * 之前：messages.map(m => m.content).join('')  在每个 chunk 都拼接 ~500KB+
 * 现在：只跟踪  ① 消息数量变化（新消息 → 滚底）
 *              ② 最后一条消息的 content 长度变化（流式更新 → 滚底）
 * 二者合并为一个短字符串，O(1) 比较
 */
const { containerRef, onScroll } = useScrollToBottom(() => {
  const msgs = chatStore.messages
  return `n${msgs.length}_l${msgs[msgs.length - 1]?.content?.length ?? 0}`
})
</script>

<style scoped>
/* ══════════════════════════════════════════════════════════
   MessageList — 高级消息列表
   渐变遮罩 · 平滑滚动 · 优雅间距
   ══════════════════════════════════════════════════════════ */

.messages-container {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: clamp(16px, 3vw, 32px);
  scroll-behavior: smooth;
  display: flex;
  flex-direction: column;
  overscroll-behavior: contain;
  position: relative;
}

.messages-list {
  display: flex;
  flex-direction: column;
  gap: clamp(16px, 3vw, 28px);
  margin-block-start: auto;
}

@media (width < 640px) {
  .messages-container {
    padding: 12px;
  }

  .messages-list {
    gap: 14px;
  }
}
</style>
