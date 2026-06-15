<!--
  InteractiveChoiceCard — 渲染 LLM ask_user_choice 工具的可交互卡片

  设计要点：
    1) 视觉风格与 message bubble 区分（淡琥珀背景 + 左侧色条），让用户一眼识别"这是个待回答的问题"
    2) 单选（multiSelect=false）：每个选项就是一个按钮，点击 → emit('select', [option]) → 父级调用 submitInteractiveChoice
       多选（multiSelect=true）：每个选项是复选框，附加"提交"按钮，至少勾选 1 项才能提交
    3) 已解决状态：替换为"已选择: X"灰字提示，保留选项原文以便回看
    4) 提交中：所有按钮 disabled + spinner，阻止重复点击
-->
<template>
  <div class="interactive-card" :class="{ resolved, submitting }">
    <div class="interactive-header">
      <span class="interactive-icon">🤔</span>
      <span class="interactive-label">{{ resolved ? '已回答' : '请选择' }}</span>
    </div>
    <div v-if="!resolved" class="interactive-question">{{ request.question }}</div>

    <!-- pending 状态：渲染可点击的选项 -->
    <div v-if="!resolved" class="interactive-options">
      <button
        v-if="!request.multiSelect"
        v-for="opt in request.options"
        :key="opt"
        type="button"
        class="opt-button"
        :disabled="submitting"
        @click="onSingleClick(opt)"
      >
        {{ opt }}
      </button>

      <template v-else>
        <label
          v-for="opt in request.options"
          :key="opt"
          class="opt-checkbox"
          :class="{ checked: selected.includes(opt), disabled: submitting }"
        >
          <input
            type="checkbox"
            :value="opt"
            :checked="selected.includes(opt)"
            :disabled="submitting"
            @change="onToggle(opt, ($event.target as HTMLInputElement).checked)"
          />
          <span class="opt-checkbox-box">
            <svg v-if="selected.includes(opt)" viewBox="0 0 16 16" width="12" height="12">
              <path d="M3 8l3.2 3.2L13 4.4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
          <span class="opt-checkbox-label">{{ opt }}</span>
        </label>
        <button
          type="button"
          class="opt-submit"
          :disabled="selected.length === 0 || submitting"
          @click="onMultiSubmit"
        >
          <span v-if="submitting" class="opt-submit-spinner" />
          <span>{{ submitting ? '提交中…' : '提交选择' }}</span>
        </button>
      </template>
    </div>

    <!-- resolved 状态：显示用户已选内容（保留上下文，避免对话失忆） -->
    <div v-else class="interactive-resolved">
      <div class="resolved-question">{{ request.question }}</div>
      <div class="resolved-answer">
        <span class="resolved-icon">✓</span>
        <span class="resolved-text">已选择：{{ (choice || []).join('、') }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import type { InteractiveRequest } from '@/types'

const props = defineProps<{
  request: InteractiveRequest
  resolved: boolean
  choice?: string[]
  submitting: boolean
}>()

const emit = defineEmits<{
  (e: 'select', choice: string[]): void
}>()

/**
 * 多选模式下的本地选中状态。
 * 单选模式不需要：点击即提交，没有"先勾再提交"的中间态。
 *
 * 注意：key 是选项原文，与后端的 InteractiveRequest.options 元素一致。
 * 这样 LLM 收到的 choice 数组就是用户能看懂的字符串，无需前后端再做映射。
 */
const selected = ref<string[]>([])

/**
 * request 变化时重置 selected。
 * 同一 message.interactive 一般不会切换，但保险起见加 watch。
 */
watch(
  () => props.request.id,
  () => {
    selected.value = []
  },
)

const onSingleClick = (opt: string): void => {
  if (props.submitting) return
  emit('select', [opt])
}

const onToggle = (opt: string, checked: boolean): void => {
  if (checked) {
    if (!selected.value.includes(opt)) selected.value.push(opt)
  } else {
    selected.value = selected.value.filter((x) => x !== opt)
  }
}

const onMultiSubmit = (): void => {
  if (props.submitting || selected.value.length === 0) return
  emit('select', [...selected.value])
}
</script>

<style scoped>
.interactive-card {
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: 10px;
  background: linear-gradient(145deg, #fff8eb, #fdf3e0);
  border: 1px solid #f3d9a8;
  border-left: 3px solid #e88a1a;
  box-shadow: 0 2px 8px rgba(232, 138, 26, 0.06);
  transition: opacity 0.2s ease;
}

.interactive-card.resolved {
  background: linear-gradient(145deg, #f4f5f7, #ebecf0);
  border-color: #d6d8de;
  border-left-color: #94a3b8;
}

.interactive-card.submitting {
  opacity: 0.7;
  pointer-events: none;
}

.interactive-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.interactive-icon {
  font-size: 14px;
  line-height: 1;
}

.interactive-label {
  font-size: 12px;
  font-weight: 600;
  color: #b8651a;
  letter-spacing: 0.02em;
}

.interactive-card.resolved .interactive-label {
  color: #64748b;
}

.interactive-question {
  font-size: 14px;
  line-height: 1.5;
  color: var(--text-primary, #2d2d2d);
  margin-bottom: 10px;
  font-weight: 500;
}

/* ─── 单选按钮 ─── */
.interactive-options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.opt-button {
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 500;
  background: #ffffff;
  border: 1px solid #f0a030;
  border-radius: 999px;
  color: #c0651c;
  cursor: pointer;
  transition: all 0.18s ease;
  font-family: inherit;
}

.opt-button:hover:not(:disabled) {
  background: #f0a030;
  color: #fff;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(232, 138, 26, 0.25);
}

.opt-button:active:not(:disabled) {
  transform: translateY(0);
}

.opt-button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

/* ─── 多选复选框 ─── */
.opt-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: #fff;
  border: 1px solid #e5d5b5;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary, #2d2d2d);
  transition: all 0.18s ease;
  user-select: none;
}

.opt-checkbox:hover:not(.disabled) {
  border-color: #f0a030;
  background: #fff8eb;
}

.opt-checkbox.checked {
  border-color: #f0a030;
  background: #fff3e0;
  color: #c0651c;
}

.opt-checkbox.disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.opt-checkbox input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.opt-checkbox-box {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: 1.5px solid #d0c4a8;
  border-radius: 4px;
  background: #fff;
  color: #fff;
  flex-shrink: 0;
  transition: all 0.15s ease;
}

.opt-checkbox.checked .opt-checkbox-box {
  background: #f0a030;
  border-color: #f0a030;
}

.opt-checkbox-label {
  white-space: nowrap;
}

.opt-submit {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  padding: 8px 18px;
  font-size: 13px;
  font-weight: 600;
  background: linear-gradient(145deg, #f0a030, #e07b1e);
  border: 0;
  border-radius: 999px;
  color: #fff;
  cursor: pointer;
  transition: all 0.18s ease;
  font-family: inherit;
  box-shadow: 0 2px 8px rgba(232, 138, 26, 0.25);
}

.opt-submit:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 14px rgba(232, 138, 26, 0.4);
}

.opt-submit:disabled {
  background: #d6d8de;
  box-shadow: none;
  cursor: not-allowed;
}

.opt-submit-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255, 255, 255, 0.4);
  border-top-color: #fff;
  border-radius: 50%;
  animation: optSpin 0.7s linear infinite;
}

@keyframes optSpin {
  to { transform: rotate(360deg); }
}

/* ─── resolved 状态 ─── */
.interactive-resolved {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.resolved-question {
  font-size: 13px;
  color: #64748b;
}

.resolved-answer {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #475569;
}

.resolved-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  background: #94a3b8;
  color: #fff;
  border-radius: 50%;
  font-size: 11px;
  flex-shrink: 0;
}

.resolved-text {
  font-weight: 500;
}
</style>
