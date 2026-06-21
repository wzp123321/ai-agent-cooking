<script setup lang="ts">
/**
 * SidebarPanel — 侧边栏主入口
 *
 * 拆分后的结构：
 *   - SidebarHeader     : 品牌区
 *   - NewChatButton     : 新建对话按钮
 *   - SessionList       : 历史会话列表
 *   - QuickQuestions    : 快捷提问
 *   - StatusIndicator   : 底部在线状态
 */
import { ElMessageBox } from 'element-plus'
import { useChatStore } from '@/stores/chat'
import { useHealthCheck, useConversation } from '@/hooks'
import SidebarHeader from './SidebarHeader.vue'
import NewChatButton from './NewChatButton.vue'
import SessionList from './SessionList.vue'
import QuickQuestions from './QuickQuestions.vue'
import StatusIndicator from './StatusIndicator.vue'

const emit = defineEmits<{ close: [] }>()

const chatStore = useChatStore()
const { sendMessage } = useConversation()

useHealthCheck()

const handleNewChat = (): void => {
  chatStore.newSession()
  emit('close')
}

const handleSwitchSession = (id: string): void => {
  chatStore.switchSession(id)
  chatStore.loadHistory(id)
  emit('close')
}

const handleDeleteSession = async (id: string): Promise<void> => {
  await ElMessageBox.confirm(
    '确定要删除这条对话吗？删除后无法恢复。',
    '提示',
    {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    },
  )
  await chatStore.deleteSession(id)
}

const handleQuickQuestion = (q: string): void => {
  sendMessage(q)
  emit('close')
}
</script>

<template>
  <div class="sidebar">
    <SidebarHeader />
    <NewChatButton @click="handleNewChat" />
    <SessionList
      :sessions="chatStore.sessions"
      :current-id="chatStore.currentSessionId"
      @switch="handleSwitchSession"
      @delete="handleDeleteSession"
    />
    <QuickQuestions @pick="handleQuickQuestion" />
    <StatusIndicator :online="chatStore.agentOnline" />
  </div>
</template>

<style src="./styles.css" />
