<script setup lang="ts">
/**
 * ActionButtons — 输入区右侧按钮组
 *
 * 三个按钮互斥：
 *   - camera-btn : 拍照（仅在非 loading 时显示）
 *   - stop-btn   : 停止生成（仅在 loading 时显示）
 *   - send-btn   : 发送（仅在非 loading 时显示）
 */
import { Promotion } from '@element-plus/icons-vue'

defineProps<{
  loading: boolean
  agentOnline: boolean
  canSend: boolean
}>()

defineEmits<{
  pickImage: []
  send: []
  stop: []
}>()
</script>

<template>
  <div class="input-actions">
    <button
      class="camera-btn"
      :disabled="loading || !agentOnline"
      title="拍照识别食材"
      type="button"
      @click="$emit('pickImage')"
    >
      📷
    </button>

    <button v-if="loading" class="stop-btn" title="停止生成" type="button" @click="$emit('stop')">
      <svg class="stop-icon" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <rect x="3" y="3" width="10" height="10" rx="2" />
      </svg>
      <span class="stop-text">停止生成</span>
    </button>

    <el-button
      v-else
      type="primary"
      :icon="Promotion"
      :disabled="!canSend"
      :loading="false"
      class="send-btn"
      @click="$emit('send')"
    />
  </div>
</template>
