<script setup lang="ts">
/**
 * OptionList — 选项列表（单选 + 多选统一入口）
 *
 * 行为：
 *   - 单选：点击选项即提交
 *   - 多选：勾选 + 提交按钮
 *   - 支持 optionImages 配图（与 options 等长；null=无图）
 *     有图的选项渲染为"上图下文"卡片；无图保持原来的胶囊按钮样式
 */
import { ref, watch } from 'vue'

const props = defineProps<{
  options: string[]
  optionImages?: (string | null)[]
  multiSelect: boolean
  submitting: boolean
}>()

const emit = defineEmits<{
  select: [choice: string[]]
}>()

const selected = ref<string[]>([])

watch(
  () => props.options,
  () => {
    selected.value = []
  },
)

const hasAnyImage = (): boolean => Array.isArray(props.optionImages) && props.optionImages.some((x) => typeof x === 'string')

const getImage = (i: number): string | null => {
  if (!Array.isArray(props.optionImages)) return null
  return props.optionImages[i] ?? null
}

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

<template>
  <div class="interactive-options" :class="{ 'has-images': hasAnyImage() }">
    <template v-if="!multiSelect">
      <!-- 单选 + 配图 → 卡片 -->
      <button
        v-for="(opt, i) in options"
        :key="opt"
        type="button"
        class="opt-card"
        :class="{ 'opt-card-noimg': !getImage(i) }"
        :disabled="submitting"
        @click="onSingleClick(opt)"
      >
        <img v-if="getImage(i)" :src="getImage(i) as string" :alt="opt" class="opt-card-img" />
        <span class="opt-card-label">{{ opt }}</span>
      </button>
    </template>

    <template v-else>
      <!-- 多选 + 配图 → 卡片 -->
      <label
        v-for="(opt, i) in options"
        :key="opt"
        class="opt-card opt-card-checkable"
        :class="{ checked: selected.includes(opt), disabled: submitting, 'opt-card-noimg': !getImage(i) }"
      >
        <input
          type="checkbox"
          :value="opt"
          :checked="selected.includes(opt)"
          :disabled="submitting"
          @change="onToggle(opt, ($event.target as HTMLInputElement).checked)"
        />
        <img v-if="getImage(i)" :src="getImage(i) as string" :alt="opt" class="opt-card-img" />
        <span class="opt-card-label">
          <span v-if="getImage(i)" class="opt-card-checkbox">
            <svg v-if="selected.includes(opt)" viewBox="0 0 16 16" width="12" height="12">
              <path d="M3 8l3.2 3.2L13 4.4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
          {{ opt }}
        </span>
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
</template>

<style scoped>
/* 保留无图模式：胶囊按钮 */
.interactive-options:not(.has-images) {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* 有图模式：卡片网格 */
.interactive-options.has-images {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 8px;
}

.opt-card {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  background: #fff;
  border: 1px solid #e5d5b5;
  border-radius: 10px;
  cursor: pointer;
  overflow: hidden;
  font-family: inherit;
  font-size: 12px;
  color: var(--text-primary, #2d2d2d);
  text-align: center;
  padding: 0;
  transition: all 0.18s ease;
  position: relative;
}
.opt-card:hover:not(:disabled):not(.disabled) {
  border-color: #f0a030;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(232, 138, 26, 0.18);
}
.opt-card:disabled,
.opt-card.disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.opt-card.checked {
  border-color: #f0a030;
  background: #fff3e0;
}
.opt-card-img {
  width: 100%;
  height: 72px;
  object-fit: cover;
  display: block;
  background: #f4f5f7;
}
.opt-card-label {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 6px 8px;
  line-height: 1.3;
}
/* 无图时的胶囊按钮样式（保持原交互观感） */
.opt-card.opt-card-noimg {
  flex-direction: row;
  justify-content: center;
  padding: 8px 16px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 500;
  color: #c0651c;
  border-color: #f0a030;
}
.opt-card.opt-card-noimg:hover:not(:disabled) {
  background: #f0a030;
  color: #fff;
}

.opt-card-checkbox {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border: 1.5px solid #d0c4a8;
  border-radius: 3px;
  background: #fff;
  color: #fff;
  flex-shrink: 0;
}
.opt-card.checked .opt-card-checkbox {
  background: #f0a030;
  border-color: #f0a030;
}
.opt-card input[type='checkbox'] {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.opt-submit {
  grid-column: 1 / -1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
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
  justify-self: end;
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
</style>
