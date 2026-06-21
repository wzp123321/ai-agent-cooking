<!--
  ReActProgressIndicator — 渲染 ReAct 阶段进度

  P1-①：根据 useReActProgress() 的当前值显示一行小指示器。
  - thinking    : "🧠 正在推理第 N 步…"
  - tool_call   : "🔧 正在调用工具：XX, YY"
  - tool_result : （通常下一帧就到 streaming，不专门渲染，避免闪烁）
  - streaming   : （已被 ThinkingDots + typing-cursor 接管，不渲染）

  设计要点：
  - 使用 transition 让出现/消失有 200ms 淡入淡出，避免一闪而过
  - 颜色与 ToolCallList 的 is-streaming 状态保持一致（灰底蓝点）
-->
<script setup lang="ts">
import { computed } from 'vue'
import type { ReActProgressEvent } from '@/types'
import { useReActProgress } from '@/hooks/conversation/useReActProgress'

const progress = useReActProgress()

// 只在 thinking / tool_call 时显示；其它两种事件类型不渲染
const visible = computed(() => {
  const p = progress.value
  if (!p) return null
  if (p.type === 'thinking') {
    return { icon: '🧠', text: `正在推理第 ${p.step} / ${p.maxSteps} 步…` }
  }
  if (p.type === 'tool_call') {
    const names = p.toolNames.length === 0
      ? '工具'
      : p.toolNames.length <= 2
        ? p.toolNames.join('、')
        : `${p.toolNames.length} 个工具`
    return { icon: '🔧', text: `正在调用${names}…` }
  }
  return null
})

const _unused: ReActProgressEvent | null = null
void _unused
</script>

<template>
  <Transition name="progress-fade">
    <div v-if="visible" class="react-progress-indicator" :key="visible.text">
      <span class="react-progress-icon">{{ visible.icon }}</span>
      <span class="react-progress-text">{{ visible.text }}</span>
      <span class="react-progress-dots"><span>.</span><span>.</span><span>.</span></span>
    </div>
  </Transition>
</template>

<style scoped>
.react-progress-indicator {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 4px 0 6px;
  padding: 4px 10px;
  background: rgba(64, 158, 255, 0.08);
  border: 1px solid rgba(64, 158, 255, 0.2);
  border-radius: 6px;
  font-size: 12px;
  color: #4a90e2;
  line-height: 1.4;
}

.react-progress-icon {
  font-size: 13px;
}

.react-progress-text {
  letter-spacing: 0.2px;
}

.react-progress-dots span {
  display: inline-block;
  animation: react-progress-blink 1.2s infinite;
  opacity: 0;
}
.react-progress-dots span:nth-child(2) {
  animation-delay: 0.2s;
}
.react-progress-dots span:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes react-progress-blink {
  0%, 20% { opacity: 0; }
  30%, 80% { opacity: 1; }
  100% { opacity: 0; }
}

.progress-fade-enter-active,
.progress-fade-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.progress-fade-enter-from,
.progress-fade-leave-to {
  opacity: 0;
  transform: translateY(-2px);
}
</style>
