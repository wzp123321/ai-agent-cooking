<script setup lang="ts">
/**
 * TextInput — 文本输入（el-input textarea）
 *
 * 快捷键：
 *   - Enter       → 触发 send
 *   - Shift+Enter → 换行（不发送）
 */
import { ref } from 'vue'

defineProps<{
  modelValue: string
  placeholder?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  send: []
}>()

const inputRef = ref()

const handleKeydown = (e: KeyboardEvent): void => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    emit('send')
  }
}

defineExpose({ inputRef })
</script>

<template>
  <el-input
    ref="inputRef"
    :model-value="modelValue"
    type="textarea"
    :autosize="{ minRows: 1, maxRows: 5 }"
    :placeholder="placeholder"
    resize="none"
    class="message-input"
    @update:model-value="(v: string) => emit('update:modelValue', v)"
    @keydown="handleKeydown"
  />
</template>
