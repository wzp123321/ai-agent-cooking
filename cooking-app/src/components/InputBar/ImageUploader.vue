<script setup lang="ts">
/**
 * ImageUploader — 图片上传 + 预览 + 移除
 *
 * 使用 v-model:imageData 双向绑定，父组件拿到 data URL。
 * 限制：仅 image/* 类型，最大 10MB。
 */
import { ref } from 'vue'
import { ElMessage } from 'element-plus'

defineProps<{
  imageData: string
}>()

const emit = defineEmits<{
  'update:imageData': [value: string]
}>()

const fileInputRef = ref<HTMLInputElement>()
const MAX_IMAGE_SIZE = 10 * 1024 * 1024

const triggerFileInput = (): void => {
  fileInputRef.value?.click()
}

const handleFileChange = (e: Event): void => {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  if (!file.type.startsWith('image/')) {
    ElMessage.warning('请选择图片文件')
    return
  }

  if (file.size > MAX_IMAGE_SIZE) {
    ElMessage.warning('图片大小不能超过 10MB')
    return
  }

  const reader = new FileReader()
  reader.onload = () => {
    emit('update:imageData', reader.result as string)
  }
  reader.readAsDataURL(file)

  input.value = ''
}

const removeImage = (): void => {
  emit('update:imageData', '')
}

const pick = (): void => {
  triggerFileInput()
}

defineExpose({ pick })
</script>

<template>
  <div>
    <input
      ref="fileInputRef"
      type="file"
      accept="image/*"
      class="file-input-hidden"
      @change="handleFileChange"
    />

    <div v-if="imageData" class="image-preview-row">
      <div class="image-preview">
        <img :src="imageData" alt="上传预览" />
        <button class="image-remove-btn" @click="removeImage" title="移除图片" type="button">
          <span>✕</span>
        </button>
      </div>
    </div>
  </div>
</template>
