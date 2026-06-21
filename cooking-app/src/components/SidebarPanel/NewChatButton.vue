<script setup lang="ts">
/**
 * NewChatButton — 新建对话按钮
 */
import { Plus } from '@element-plus/icons-vue'

defineEmits<{ click: [] }>()
</script>

<template>
  <el-button
    type="primary"
    class="new-chat-btn"
    :icon="Plus"
    @click="$emit('click')"
  >
    新建对话
  </el-button>
</template>
