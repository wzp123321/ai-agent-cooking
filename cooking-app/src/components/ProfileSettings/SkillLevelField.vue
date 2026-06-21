<script setup lang="ts">
/**
 * SkillLevelField — 烹饪水平单选
 */
type SkillLevel = 'beginner' | 'intermediate' | 'expert'

defineProps<{
  modelValue: SkillLevel
}>()

defineEmits<{
  'update:modelValue': [value: SkillLevel]
}>()

const options = [
  { value: 'beginner' as const, label: '新手', hint: '需要详细步骤' },
  { value: 'intermediate' as const, label: '中级', hint: '有一定基础' },
  { value: 'expert' as const, label: '高手', hint: '专业级建议' },
]
</script>

<template>
  <div class="radio-group">
    <label
      v-for="opt in options"
      :key="opt.value"
      class="radio-item"
      :class="{ active: modelValue === opt.value }"
    >
      <input
        type="radio"
        :value="opt.value"
        :checked="modelValue === opt.value"
        @change="$emit('update:modelValue', opt.value)"
        hidden
      />
      <span class="radio-dot" />
      <span class="radio-text">{{ opt.label }}</span>
      <span class="radio-hint">{{ opt.hint }}</span>
    </label>
  </div>
</template>
