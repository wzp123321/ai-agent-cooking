<script setup lang="ts">
/**
 * InputBar — 消息输入框（主入口）
 *
 * 拆分后的结构：
 *   - ImageUploader : 图片上传 + 预览 + 移除
 *   - TextInput     : 多行文本输入（带快捷键）
 *   - ActionButtons : 拍照 / 停止 / 发送按钮
 *
 * 共享样式在 styles.css 中统一管理。
 */
import { computed, ref } from 'vue'
import { useChatStore } from '@/stores/chat'
import { useConversation } from '@/hooks'
import { AGENT_OFFLINE_TIP, AGENT_ONLINE_PLACEHOLDER, DISCLAIMER } from '@/constants'
import ImageUploader from './ImageUploader.vue'
import TextInput from './TextInput.vue'
import ActionButtons from './ActionButtons.vue'

const chatStore = useChatStore()
const { sendMessage, sendVisionMessage, stopGeneration } = useConversation()

const inputText = ref('')
const imageData = ref('')
const uploaderRef = ref<InstanceType<typeof ImageUploader>>()

const placeholder = computed(() =>
  chatStore.agentOnline
    ? imageData.value
      ? '描述一下图片内容，或直接发送…'
      : AGENT_ONLINE_PLACEHOLDER
    : AGENT_OFFLINE_TIP,
)

const hasContent = computed(
  () => inputText.value.trim().length > 0 || !!imageData.value,
)

const canSend = computed(
  () => hasContent.value && !chatStore.loading && chatStore.agentOnline,
)

const pickImage = (): void => {
  uploaderRef.value?.pick()
}

const getImageBase64 = (): string | null => {
  if (!imageData.value) return null
  const parts = imageData.value.split(',')
  if (parts.length === 2) return parts[1]
  return imageData.value
}

const handleSend = async (): Promise<void> => {
  if (!canSend.value) return

  const text = inputText.value.trim()
  const imageBase64 = getImageBase64()

  inputText.value = ''
  imageData.value = ''

  if (imageBase64) {
    await sendVisionMessage(imageBase64, text || undefined)
  } else {
    await sendMessage(text)
  }
}
</script>

<template>
  <div class="input-area">
    <div class="input-wrapper">
      <div class="input-main">
        <ImageUploader ref="uploaderRef" v-model:image-data="imageData" />
        <TextInput
          v-model="inputText"
          :placeholder="placeholder"
          @send="handleSend"
        />
      </div>

      <ActionButtons
        :loading="chatStore.loading"
        :agent-online="chatStore.agentOnline"
        :can-send="canSend"
        @pick-image="pickImage"
        @send="handleSend"
        @stop="stopGeneration"
      />
    </div>

    <p class="input-hint">{{ DISCLAIMER }}</p>
  </div>
</template>

<style src="./styles.css" />
