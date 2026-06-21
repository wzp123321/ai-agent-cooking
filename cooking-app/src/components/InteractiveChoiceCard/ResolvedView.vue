<script setup lang="ts">
/**
 * ResolvedView — 已解决状态展示
 *
 * 按交互类型分支显示答案：
 *   - text    : 显示原文
 *   - confirm : 显示 "已确认" / "已取消"
 *   - slider  : 显示数值 + unit
 *   - choice  : 默认 '、' 拼接
 */
import { computed } from 'vue'
import type { InteractiveType } from '@/types'

const props = defineProps<{
  question: string
  choice: string[]
  type?: InteractiveType
  unit?: string
}>()

const displayText = computed<string>(() => {
  const v = (props.choice || [])[0] ?? ''
  switch (props.type) {
    case 'text':
      return v || '（空）'
    case 'confirm':
      return v === '确认' ? '已确认' : v === '取消' ? '已取消' : v
    case 'slider':
      return props.unit ? `${v} ${props.unit}` : v
    case 'choice':
    default:
      return (props.choice || []).join('、')
  }
})
</script>

<template>
  <div class="interactive-resolved">
    <div class="resolved-question">{{ question }}</div>
    <div class="resolved-answer">
      <span class="resolved-icon">✓</span>
      <span class="resolved-text">已选择：{{ displayText }}</span>
    </div>
  </div>
</template>
