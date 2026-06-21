<script setup lang="ts">
/**
 * InteractiveChoiceCard — 主入口
 *
 * 按 `type` 字段分支渲染不同的子组件：
 *   - choice  : OptionList（按钮/复选框 + 可选配图）
 *   - text    : TextInput
 *   - confirm : ConfirmButtons
 *   - slider  : SliderField
 *
 * 拆分后：
 *   - CardHeader     : 头部（图标+标签）
 *   - OptionList     : choice 模式
 *   - TextInput      : text 模式
 *   - ConfirmButtons : confirm 模式
 *   - SliderField    : slider 模式
 *   - ResolvedView   : 已选择状态（按 type 适配文案）
 */
import { computed } from 'vue'
import type { InteractiveRequest, InteractiveType } from '@/types'
import CardHeader from './CardHeader.vue'
import OptionList from './OptionList.vue'
import TextInput from './TextInput.vue'
import ConfirmButtons from './ConfirmButtons.vue'
import SliderField from './SliderField.vue'
import ResolvedView from './ResolvedView.vue'

const props = defineProps<{
  request: InteractiveRequest
  resolved: boolean
  choice?: string[]
  submitting: boolean
}>()

defineEmits<{
  select: [choice: string[]]
}>()

/** 向后兼容：未带 type 字段的旧事件统一视为 choice */
const interactiveType = computed<InteractiveType>(() => props.request.type ?? 'choice')

const sliderUnit = computed<string>(() =>
  typeof props.request.meta?.unit === 'string' ? (props.request.meta.unit as string) : '',
)
</script>

<template>
  <div class="interactive-card" :class="{ resolved, submitting }">
    <CardHeader :resolved="resolved" />
    <div v-if="!resolved" class="interactive-question">{{ request.question }}</div>

    <!-- choice: 单选/多选按钮组（保留配图能力） -->
    <OptionList
      v-if="!resolved && interactiveType === 'choice'"
      :options="request.options"
      :option-images="request.optionImages"
      :multi-select="request.multiSelect"
      :submitting="submitting"
      @select="(c) => $emit('select', c)"
    />

    <!-- text: 自由文本输入 -->
    <TextInput
      v-else-if="!resolved && interactiveType === 'text'"
      :options="request.options"
      :meta="request.meta"
      :validation="request.validation"
      :submitting="submitting"
      @select="(c) => $emit('select', c)"
    />

    <!-- confirm: 确认/取消二选一 -->
    <ConfirmButtons
      v-else-if="!resolved && interactiveType === 'confirm'"
      :options="['确认', '取消']"
      :submitting="submitting"
      @select="(c) => $emit('select', c)"
    />

    <!-- slider: 滑动条 -->
    <SliderField
      v-else-if="!resolved && interactiveType === 'slider'"
      :options="request.options"
      :meta="request.meta"
      :submitting="submitting"
      @select="(c) => $emit('select', c)"
    />

    <ResolvedView
      v-else
      :question="request.question"
      :choice="choice || []"
      :type="interactiveType"
      :unit="sliderUnit"
    />
  </div>
</template>

<style src="./styles.css" />
