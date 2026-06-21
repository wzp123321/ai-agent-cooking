<script setup lang="ts">
/**
 * ThinkingDots — 思考中动画
 *
 * 三个弹跳点动画，每个错开 0.2s 产生波浪式弹跳效果。
 * 用于 AI 开始生成但尚无内容时的过渡 UI。
 */
</script>

<template>
  <div class="thinking-indicator">
    <span class="thinking-label">思考中</span>
    <span class="thinking-dots">
      <span class="dot" />
      <span class="dot" />
      <span class="dot" />
    </span>
  </div>
</template>
