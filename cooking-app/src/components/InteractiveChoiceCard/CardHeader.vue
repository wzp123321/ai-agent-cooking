<script setup lang="ts">
/**
 * CardHeader — 卡片头部（图标 + 标签）
 */
defineProps<{
  resolved: boolean
}>()
</script>

<template>
  <div class="interactive-header">
    <span class="interactive-icon">🤔</span>
    <span class="interactive-label">{{ resolved ? '已回答' : '请选择' }}</span>
  </div>
</template>
