<script setup lang="ts">
/**
 * SidebarHeader — 品牌头部
 */
import { APP_NAME, APP_SUBTITLE } from '@/constants'
</script>

<template>
  <div class="sidebar-header">
    <div class="logo">
      <span class="logo-icon">🍳</span>
      <span class="logo-text">{{ APP_NAME }}</span>
    </div>
    <p class="logo-sub">{{ APP_SUBTITLE }}</p>
  </div>
</template>
