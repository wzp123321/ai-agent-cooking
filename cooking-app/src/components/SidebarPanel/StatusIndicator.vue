<script setup lang="ts">
/**
 * StatusIndicator — 底部 Agent 在线状态指示灯
 */
defineProps<{
  online: boolean
}>()
</script>

<template>
  <div class="sidebar-footer">
    <span class="status-dot" :class="online ? 'online' : 'offline'" />
    <span class="status-text">
      {{ online ? 'Agent 已连接' : 'Agent 未连接' }}
    </span>
  </div>
</template>
