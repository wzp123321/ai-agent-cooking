<script setup lang="ts">
/**
 * QuickQuestions — 快捷提问列表
 */
import { QUICK_QUESTIONS } from '@/constants'

defineEmits<{
  pick: [question: string]
}>()
</script>

<template>
  <div class="quick-section">
    <p class="section-title">🌟 快捷提问</p>
    <div class="quick-list">
      <div
        v-for="q in QUICK_QUESTIONS"
        :key="q"
        class="quick-btn"
        @click="$emit('pick', q)"
      >
        {{ q }}
      </div>
    </div>
  </div>
</template>
