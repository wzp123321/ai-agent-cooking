<script setup lang="ts">
/**
 * ConfirmButtons — 确认/取消交互
 *
 * 行为：
 *   - 后端会自动补全 options 为 ['确认', '取消']，前端直接渲染即可
 *   - 选中即提交（无需单独"提交"按钮）
 *   - 校验规则在 backend validator.ts：必须是 '确认' 或 '取消'
 */
defineProps<{
  options: string[]
  submitting: boolean
}>()

const emit = defineEmits<{
  select: [choice: string[]]
}>()

const onClick = (opt: string): void => {
  emit('select', [opt])
}
</script>

<template>
  <div class="confirm-buttons">
    <button
      v-for="opt in options"
      :key="opt"
      type="button"
      class="confirm-btn"
      :class="{ 'confirm-btn-yes': opt === '确认', 'confirm-btn-no': opt === '取消' }"
      :disabled="submitting"
      @click="onClick(opt)"
    >
      {{ opt }}
    </button>
  </div>
</template>

<style scoped>
.confirm-buttons {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.confirm-btn {
  padding: 8px 20px;
  font-size: 13px;
  font-weight: 600;
  border-radius: 999px;
  cursor: pointer;
  font-family: inherit;
  border: 1px solid transparent;
  transition: all 0.18s ease;
  min-width: 84px;
}
.confirm-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.confirm-btn-yes {
  background: linear-gradient(145deg, #f0a030, #e07b1e);
  color: #fff;
  box-shadow: 0 2px 8px rgba(232, 138, 26, 0.25);
}
.confirm-btn-yes:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 14px rgba(232, 138, 26, 0.4);
}
.confirm-btn-no {
  background: #fff;
  color: #64748b;
  border-color: #d6d8de;
}
.confirm-btn-no:hover:not(:disabled) {
  background: #f4f5f7;
  border-color: #94a3b8;
}
</style>
