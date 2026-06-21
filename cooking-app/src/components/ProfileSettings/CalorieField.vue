<script setup lang="ts">
/**
 * CalorieField — 每日热量目标输入
 *
 * 0 = 不限制。
 */
defineProps<{
  modelValue: number
}>()

defineEmits<{
  'update:modelValue': [value: number]
}>()
</script>

<template>
  <div class="calorie-input-wrap">
    <input
      type="number"
      class="form-input"
      :value="modelValue"
      min="0"
      max="5000"
      step="100"
      placeholder="如：1800"
      @input="$emit('update:modelValue', Number(($event.target as HTMLInputElement).value))"
    />
    <span class="calorie-unit">大卡/天</span>
  </div>
</template>
