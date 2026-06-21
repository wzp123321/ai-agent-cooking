<script setup lang="ts">
/**
 * SessionList — 历史会话列表
 *
 * 支持：切换会话、删除会话（hover 显示）
 */
import { Close, ChatLineRound } from '@element-plus/icons-vue'
import type { ChatSession } from '@/types'

defineProps<{
  sessions: ChatSession[]
  currentId: string
}>()

defineEmits<{
  switch: [id: string]
  delete: [id: string]
}>()
</script>

<template>
  <div class="session-section">
    <p class="section-title">历史对话</p>

    <div class="session-list">
      <div
        v-for="session in sessions"
        :key="session.id"
        class="session-item"
        :class="{ active: session.id === currentId }"
        @click="$emit('switch', session.id)"
      >
        <el-icon class="session-icon"><ChatLineRound /></el-icon>
        <span class="session-title">{{ session.title }}</span>
        <el-button
          class="session-del"
          :icon="Close"
          text
          size="small"
          @click.stop="$emit('delete', session.id)"
        />
      </div>
    </div>
  </div>
</template>
