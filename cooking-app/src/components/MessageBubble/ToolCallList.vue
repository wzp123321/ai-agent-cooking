<script setup lang="ts">
/**
 * ToolCallList — 工具调用列表
 *
 * 设计要点：
 *   - 当 finish_reason='tool_calls' 时渲染
 *   - 每个工具调用以可展开卡片形式展示：
 *       头部：🔧 工具名 + 参数摘要（默认折叠）
 *       展开后：完整 JSON 参数
 *   - 流式聚合中显示"调用中…"动效
 */
import { ref } from 'vue'
import type { ToolCall } from '@/types'
import { formatToolArgs, summarizeToolArgs } from '@/utils/tool-args'

defineProps<{
  toolCalls: ToolCall[]
  streaming?: boolean
  hasContent?: boolean
}>()

const expandedTools = ref<Record<number, boolean>>({})
const toggleTool = (i: number): void => {
  expandedTools.value[i] = !expandedTools.value[i]
}
</script>

<template>
  <div class="tool-calls">
    <div
      v-for="(tc, i) in toolCalls"
      :key="tc.id || i"
      class="tool-call"
      :class="{
        expanded: expandedTools[i],
        'is-streaming': streaming && !hasContent,
      }"
    >
      <button class="tool-call-header" @click="toggleTool(i)" type="button">
        <span class="tool-icon">🔧</span>
        <span class="tool-name">{{ tc.function.name || '调用中…' }}</span>
        <span v-if="streaming && !hasContent" class="tool-streaming">调用中…</span>
        <span v-else class="tool-summary">{{ summarizeToolArgs(tc.function.arguments) }}</span>
        <span class="tool-toggle">{{ expandedTools[i] ? '▾' : '▸' }}</span>
      </button>
      <pre v-if="expandedTools[i]" class="tool-args">{{ formatToolArgs(tc.function.arguments) }}</pre>
    </div>
  </div>
</template>
