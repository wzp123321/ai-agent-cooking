<script setup lang="ts">
/**
 * SliderField — 滑动条交互
 *
 * 行为：
 *   - 从 meta 读取 min/max/step/default/unit
 *   - 实时显示当前数值（带 unit）
 *   - 提交时把数值转字符串回传（与后端 validator.ts 对齐：Number() 后落 [min, max]）
 *   - 后端兜底：min=0, max=100, step 缺省=1
 */
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  options: string[]
  meta: Record<string, unknown>
  submitting: boolean
}>()

const emit = defineEmits<{
  select: [choice: string[]]
}>()

const min = computed<number>(() =>
  typeof props.meta.min === 'number' ? (props.meta.min as number) : 0,
)
const max = computed<number>(() =>
  typeof props.meta.max === 'number' ? (props.meta.max as number) : 100,
)
const step = computed<number>(() => {
  if (typeof props.meta.step === 'number' && (props.meta.step as number) > 0) {
    return props.meta.step as number
  }
  return 1
})
const unit = computed<string>(() =>
  typeof props.meta.unit === 'string' ? (props.meta.unit as string) : '',
)
const initialValue = computed<number>(() => {
  if (typeof props.meta.default === 'number') {
    return clamp(props.meta.default as number, min.value, max.value)
  }
  // 没给 default 时取中点
  return Math.round((min.value + max.value) / 2 / step.value) * step.value
})

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

const value = ref<number>(initialValue.value)

watch(
  () => [props.meta.min, props.meta.max, props.meta.default],
  () => {
    value.value = initialValue.value
  },
)

const canSubmit = computed<boolean>(() => !props.submitting)

const onSubmit = (): void => {
  if (!canSubmit.value) return
  // 与后端 validateSliderChoice 行为对齐：Number(str) 后落 [min,max]
  emit('select', [String(value.value)])
}
</script>

<template>
  <div class="slider-field">
    <div class="slider-row">
      <input
        type="range"
        class="slider-input"
        :min="min"
        :max="max"
        :step="step"
        :disabled="submitting"
        v-model.number="value"
      />
      <div class="slider-value">
        <span class="slider-value-num">{{ value }}</span>
        <span class="slider-value-unit" v-if="unit">{{ unit }}</span>
      </div>
    </div>
    <div class="slider-meta">
      <span class="slider-bound">最小 {{ min }}{{ unit }}</span>
      <span class="slider-bound">最大 {{ max }}{{ unit }}</span>
    </div>
    <div class="slider-actions">
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
.slider-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.slider-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.slider-input {
  flex: 1;
  -webkit-appearance: none;
  appearance: none;
  height: 4px;
  background: #f3d9a8;
  border-radius: 2px;
  outline: none;
  cursor: pointer;
}
.slider-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.slider-input::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 18px;
  height: 18px;
  background: linear-gradient(145deg, #f0a030, #e07b1e);
  border-radius: 50%;
  border: 2px solid #fff;
  box-shadow: 0 1px 4px rgba(232, 138, 26, 0.4);
  cursor: pointer;
  transition: transform 0.1s ease;
}
.slider-input::-webkit-slider-thumb:hover {
  transform: scale(1.1);
}
.slider-input::-moz-range-thumb {
  width: 18px;
  height: 18px;
  background: linear-gradient(145deg, #f0a030, #e07b1e);
  border-radius: 50%;
  border: 2px solid #fff;
  box-shadow: 0 1px 4px rgba(232, 138, 26, 0.4);
  cursor: pointer;
}
.slider-value {
  display: inline-flex;
  align-items: baseline;
  gap: 2px;
  min-width: 56px;
  padding: 4px 10px;
  background: #fff8eb;
  border: 1px solid #f3d9a8;
  border-radius: 6px;
  font-weight: 600;
  color: #c0651c;
  font-variant-numeric: tabular-nums;
}
.slider-value-num {
  font-size: 15px;
}
.slider-value-unit {
  font-size: 11px;
  color: #94a3b8;
}
.slider-meta {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: #94a3b8;
}
.slider-actions {
  display: flex;
  justify-content: flex-end;
}
</style>
