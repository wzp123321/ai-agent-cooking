<script setup lang="ts">
/**
 * MessageAvatar — 消息头像
 *
 * 设计要点：
 *   - SVG 矢量图标，替代原来的 emoji 👤/👨‍🍳
 *   - 用户：圆形人物剪影（person icon），琥珀渐变背景
 *   - 助手：五角星剪影（star icon），暖灰白渐变背景
 *   - 助手生成中：外围叠加 avatarPulse 呼吸光晕
 */
defineProps<{
  role: 'user' | 'assistant'
  streaming?: boolean
}>()
</script>

<template>
  <div class="avatar" :class="`${role}-avatar`">
    <svg
      v-if="role === 'user'"
      class="avatar-icon"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="1.6" />
      <path
        d="M5 21c0-3.9 3.1-7 7-7s7 3.1 7 7"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
      />
    </svg>
    <svg
      v-else
      class="avatar-icon"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="m12 2 2.4 5.2L20 9.5l-4 3.6 1 5.4L12 16l-5 2.5 1-5.4L4 9.5l5.6-2.3L12 2z"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linejoin="round"
      />
    </svg>
    <div v-if="role === 'assistant' && streaming" class="avatar-pulse" />
  </div>
</template>
