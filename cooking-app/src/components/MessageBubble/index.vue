<script setup lang="ts">
/**
 * MessageBubble — 单条消息气泡（主入口）
 *
 * 拆分后的结构：
 *   - MessageAvatar    : 头像（SVG + pulse 动画）
 *   - ToolCallList     : 工具调用列表
 *   - ThinkingDots     : 思考中动画
 *   - MarkdownContent  : markdown 渲染（带节流）
 *   - InteractiveChoiceCard : 交互式卡片（外部组件）
 *
 * 共享样式在 styles.css 中统一管理。
 */
import { computed, ref } from 'vue'
import type { ChatMessage } from '@/types'
import MessageAvatar from './MessageAvatar.vue'
import ToolCallList from './ToolCallList.vue'
import ThinkingDots from './ThinkingDots.vue'
import MarkdownContent from './MarkdownContent.vue'
import ReActProgressIndicator from './ReActProgressIndicator.vue'
import InteractiveChoiceCard from '@/components/InteractiveChoiceCard/index.vue'

const props = defineProps<{
  message: ChatMessage
  submitInteractiveChoice: (id: string, choice: string[]) => Promise<void>
}>()

// 提交中状态：控制按钮 disabled，避免重复点击
const isSubmitting = ref(false)

const onSelect = async (choice: string[]): Promise<void> => {
  if (!props.message.interactive || isSubmitting.value) return
  isSubmitting.value = true
  try {
    await props.submitInteractiveChoice(props.message.interactive.id, choice)
  } catch (err) {
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
</script>

<template>
  <div class="message" :class="message.role">
    <MessageAvatar :role="message.role" :streaming="message.streaming" />

    <div class="bubble-wrapper">
      <div class="bubble" :class="[message.role, { thinking: isThinking }]">
        <template v-if="message.role === 'user'">
          <img v-if="message.image" :src="message.image" class="user-image" alt="用户上传图片" />
          <span v-if="message.content" class="user-text">{{ message.content }}</span>
        </template>

        <template v-else>
          <!-- P1-①：ReAct 阶段进度指示器（仅当前正在流式的消息显示） -->
          <ReActProgressIndicator v-if="message.streaming" />

          <ToolCallList
            v-if="message.toolCalls && message.toolCalls.length > 0"
            :tool-calls="message.toolCalls"
            :streaming="message.streaming"
            :has-content="!!message.content"
          />

          <ThinkingDots v-if="isThinking" />

          <MarkdownContent
            v-if="message.content"
            :text="message.content"
            :streaming="message.streaming"
          />

          <span v-if="message.streaming && message.content" class="typing-cursor" />

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

<style src="./styles.css" />
