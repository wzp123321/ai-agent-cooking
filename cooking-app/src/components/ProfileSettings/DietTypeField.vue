<script setup lang="ts">
/**
 * DietTypeField — 膳食模式下拉
 */
defineProps<{
  modelValue: string
}>()

defineEmits<{
  'update:modelValue': [value: string]
}>()

const options = [
  { value: '生酮', label: '生酮饮食' },
  { value: '低卡', label: '低卡路里' },
  { value: '高蛋白', label: '高蛋白' },
  { value: '素食', label: '素食（蛋奶素）' },
  { value: '纯素', label: '纯素（Vegan）' },
  { value: '无麸质', label: '无麸质' },
  { value: '低FODMAP', label: '低FODMAP' },
  { value: '糖尿病友好', label: '糖尿病友好' },
]
</script>

<template>
  <select class="form-select" :value="modelValue" @change="$emit('update:modelValue', ($event.target as HTMLSelectElement).value)">
    <option value="">无特殊要求</option>
    <option v-for="d in options" :key="d.value" :value="d.value">
      {{ d.label }}
    </option>
  </select>
</template>
