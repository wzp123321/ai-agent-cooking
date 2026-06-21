<script setup lang="ts">
/**
 * TextInput — 文本输入交互
 *
 * 用法：
 *   - 输入框 + 提交按钮
 *   - placeholder 来自 meta.placeholder
 *   - maxLength 来自 meta.maxLength / validation.maxLength（取小）
 *   - validation.minLength / regex 在提交前做客户端预校验（与后端 validator.ts 保持一致）
 */
import { computed, ref } from 'vue'

const props = defineProps<{
  /** 选项数组（text 模式无意义，预留接口一致性） */
  options: string[]
  /** 扩展参数（placeholder/maxLength） */
  meta: Record<string, unknown>
  /** 答案有效性约束 */
  validation?: {
    regex?: string
    minLength?: number
    maxLength?: number
  }
  /** 是否处于提交中（禁用输入和按钮） */
  submitting: boolean
}>()

const emit = defineEmits<{
  select: [choice: string[]]
}>()

const text = ref<string>('')

/** 取 meta.maxLength 与 validation.maxLength 中较小的，覆盖前不会超过后端兜底 200 */
const maxLength = computed<number>(() => {
  const fromMeta = typeof props.meta.maxLength === 'number' ? (props.meta.maxLength as number) : 200
  const fromVal =
    typeof props.validation?.maxLength === 'number' ? (props.validation.maxLength as number) : fromMeta
  return Math.min(fromMeta, fromVal)
})

const placeholder = computed<string>(
  () => (typeof props.meta.placeholder === 'string' ? (props.meta.placeholder as string) : '请输入…'),
)

const charCount = computed<number>(() => text.value.length)

const canSubmit = computed<boolean>(() => {
  if (props.submitting) return false
  const t = text.value
  if (typeof props.validation?.minLength === 'number' && t.length < props.validation.minLength) {
    return false
  }
  return t.length > 0
})

const errorMsg = computed<string>(() => {
  const t = text.value
  if (!t) return ''
  if (typeof props.validation?.minLength === 'number' && t.length < props.validation.minLength) {
    return `至少输入 ${props.validation.minLength} 个字符（当前 ${t.length}）`
  }
  if (typeof props.validation?.regex === 'string' && props.validation.regex) {
    try {
      const re = new RegExp(props.validation.regex)
      if (!re.test(t)) return '输入格式不正确'
    } catch {
      // 防御：后端 regex 异常时不阻塞输入
    }
  }
  return ''
})

const onSubmit = (): void => {
  if (!canSubmit.value) return
  emit('select', [text.value.trim()])
}
</script>

<template>
  <div class="text-input-wrap">
    <textarea
      v-model="text"
      class="text-input"
      :placeholder="placeholder"
      :maxlength="maxLength"
      :disabled="submitting"
      rows="3"
      @keydown.ctrl.enter.prevent="onSubmit"
      @keydown.meta.enter.prevent="onSubmit"
    />
    <div class="text-input-meta">
      <span class="text-input-error" v-if="errorMsg">{{ errorMsg }}</span>
      <span class="text-input-count">{{ charCount }} / {{ maxLength }}</span>
    </div>
    <div class="text-input-actions">
      <button
        type="button"
        class="text-input-submit"
        :disabled="!canSubmit"
        @click="onSubmit"
      >
        <span v-if="submitting" class="opt-submit-spinner" />
        <span>{{ submitting ? '提交中…' : '提交' }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.text-input-wrap {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.text-input {
  width: 100%;
  box-sizing: border-box;
  font-size: 13px;
  line-height: 1.5;
  padding: 8px 10px;
  border: 1px solid #e5d5b5;
  border-radius: 8px;
  background: #fff;
  color: var(--text-primary, #2d2d2d);
  font-family: inherit;
  resize: vertical;
  min-height: 60px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.text-input:focus {
  outline: none;
  border-color: #f0a030;
  box-shadow: 0 0 0 3px rgba(240, 160, 48, 0.12);
}
.text-input:disabled {
  background: #f4f5f7;
  cursor: not-allowed;
}
.text-input-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  color: #94a3b8;
}
.text-input-error {
  color: #c0392b;
}
.text-input-actions {
  display: flex;
  justify-content: flex-end;
}
</style>
