<script setup lang="ts">
/**
 * TagInputField — 通用 tag 输入（过敏 / 忌口）
 *
 * 行为：
 *   - 输入后回车 → 添加到列表（自动去重）
 *   - 点击 tag 上的 ✕ → 移除
 *   - 列表为空时，placeholder 提示
 */
import { ref } from 'vue'

const props = defineProps<{
  modelValue: string[]
  placeholder?: string
  variant?: 'default' | 'dislike'
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string[]]
}>()

const inputValue = ref('')

const add = (): void => {
  const val = inputValue.value.trim()
  if (val && !props.modelValue.includes(val)) {
    emit('update:modelValue', [...props.modelValue, val])
  }
  inputValue.value = ''
}

const remove = (i: number): void => {
  const next = [...props.modelValue]
  next.splice(i, 1)
  emit('update:modelValue', next)
}
</script>

<template>
  <div class="tag-input">
    <span
      v-for="(item, i) in modelValue"
      :key="i"
      class="tag"
      :class="{ 'tag-dislike': variant === 'dislike' }"
    >
      {{ item }}
      <button class="tag-remove" @click="remove(i)" type="button">✕</button>
    </span>
    <input
      class="tag-input-field"
      v-model="inputValue"
      :placeholder="placeholder || '输入后回车添加…'"
      @keydown.enter.prevent="add"
    />
  </div>
</template>
