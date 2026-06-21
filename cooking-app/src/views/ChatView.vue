<template>
  <!--
    ═══════════════════════════════════════════════════════
    ChatView — 主页面容器组件
    ═══════════════════════════════════════════════════════
    布局结构：
      ┌─────────────┬──────────────────────────────┐
      │             │          chat-header          │
      │  sidebar    ├──────────────────────────────┤
      │  (桌面端)   │                              │
      │             │          message-list        │
      │             │          (可滚动)             │
      │             │                              │
      │             ├──────────────────────────────┤
      │             │          input-bar            │
      └─────────────┴──────────────────────────────┘

    移动端响应式策略：
      - 侧边栏在 <768px 宽度下隐藏
      - 顶部菜单按钮触发 el-drawer 抽屉式侧边栏
  -->

  <!-- 侧边栏抽屉（移动端 <768px，el-drawer 从左侧滑入） -->
  <el-drawer
    v-model="drawerOpen"
    direction="ltr"
    :with-header="false"
    size="260px"
    class="sidebar-drawer"
  >
    <!-- 抽屉内容复用 SidebarPanel 组件，关闭时触发 emit -->
    <SidebarPanel @close="drawerOpen = false" />
  </el-drawer>

  <!-- 主布局容器 -->
  <div class="layout">

    <!-- ══ 桌面端侧边栏（>768px 时显示） ══ -->
    <aside class="sidebar-desktop">
      <!-- 全屏高度，内容由 SidebarPanel 内部 flex 布局撑满 -->
      <SidebarPanel />
    </aside>

    <!-- ══ 主聊天区域 ══ -->
    <main class="chat-main">

      <!-- 顶部栏：Logo + 标题 + 清空按钮 -->
      <header class="chat-header">
        <!-- 移动端菜单按钮（>768px 隐藏，由 CSS display:none 控制） -->
        <el-button
          class="menu-btn"
          :icon="Menu"
          text
          circle
          @click="drawerOpen = true"
        />

        <!-- 机器人名称和副标题 -->
        <div class="header-info">
          <span class="header-title">{{ APP_NAME }}</span>
          <span class="header-sub">{{ APP_DESC }}</span>
        </div>

        <!-- 清空当前对话按钮（hover 时显示 tooltip） -->
        <el-tooltip content="个人偏好设置" placement="bottom">
          <el-button
            :icon="Setting"
            text
            circle
            @click="profileOpen = true"
          />
        </el-tooltip>
        <el-tooltip content="清空当前对话" placement="bottom">
          <el-button
            :icon="Delete"
            text
            circle
            @click="handleClear"
          />
        </el-tooltip>
      </header>

      <!-- 消息列表区域（自动填满剩余高度） -->
      <MessageList />

      <!-- 底部输入框区域 -->
      <InputBar />
    </main>
  </div>

  <ProfileSettings :visible="profileOpen" @close="profileOpen = false" />
</template>

<script setup lang="ts">
/**
 * ChatView — 主页面入口组件
 *
 * 职责：
 *   - 整体布局（侧边栏 + 主内容区）
 *   - 移动端响应式（侧边栏 drawer 切换）
 *   - 提供"清空对话"的事件处理
 */
import { ref, onMounted, onUnmounted, provide } from 'vue'
import { Menu, Delete, Setting } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import SidebarPanel from '@/components/SidebarPanel/index.vue'
import MessageList from '@/components/MessageList.vue'
import InputBar from '@/components/InputBar/index.vue'
import ProfileSettings from '@/components/ProfileSettings/index.vue'
import { useChatStore } from '@/stores/chat'
import { useConversation } from '@/hooks'
import { APP_NAME, APP_DESC } from '@/constants'

const chatStore = useChatStore()

/**
 * useConversation 在 ChatView 顶层调用一次（保持单一实例），
 * 把 submitInteractiveChoice 通过 provide/inject 暴露给 MessageList → MessageBubble，
 * 避免每个组件各自调用 hook 导致 abortController 状态被反复重置。
 *
 * 这是一个 Vue 3 的"上下文桥"模式，比 props 透传更简洁。
 */
const { submitInteractiveChoice } = useConversation()
provide('submitInteractiveChoice', submitInteractiveChoice)

onMounted(() => {
  chatStore.loadSessions()
  document.addEventListener('keydown', handleGlobalKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleGlobalKeydown)
})

const drawerOpen = ref(false)
const profileOpen = ref(false)

const handleGlobalKeydown = (e: KeyboardEvent) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
    e.preventDefault()
    chatStore.newSession()
  }
}

/**
 * 清空当前对话
 *
 * 流程：
 *   1. 若当前无消息，直接返回（避免无意义弹窗）
 *   2. 弹出 Element Plus 确认框
 *   3. 用户确认后，调用 Store 的 clearCurrentSession action
 */
const handleClear = async () => {
  if (chatStore.messages.length === 0) return

  await ElMessageBox.confirm(
    '确定要清空当前对话吗？此操作不可恢复。',
    '提示',
    {
      confirmButtonText: '清空',
      cancelButtonText: '取消',
      type: 'warning',
    },
  )

  await chatStore.clearCurrentSession()
}
</script>

<style scoped>
/* ══════════════════════════════════════════════════════════
   ChatView — 清爽高级布局
   CSS Grid · 磨砂头部 · 暖白光晕 · 流畅分割线
   ══════════════════════════════════════════════════════════ */

.layout {
  display: grid;
  grid-template-columns: clamp(260px, 22vw, 300px) 1fr;
  width: 100%;
  height: 100dvh;
  overflow: hidden;
}

.sidebar-desktop {
  border-inline-end: 1px solid var(--border);
  background: var(--bg-secondary);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
}

.sidebar-desktop::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(232,138,26,0.015) 0%, transparent 50%);
  pointer-events: none;
}

.chat-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--bg-primary);
  position: relative;
  isolation: isolate;
}

.chat-main::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    radial-gradient(circle 140px at 20% 30%, rgba(232,138,26,0.03) 0%, transparent 100%),
    radial-gradient(circle 100px at 75% 60%, rgba(91,95,199,0.02) 0%, transparent 100%),
    radial-gradient(circle 120px at 50% 85%, rgba(232,138,26,0.025) 0%, transparent 100%);
  pointer-events: none;
  z-index: 0;
  animation: floatOrb2 15s ease-in-out infinite;
}

.chat-header {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 24px;
  border-block-end: 1px solid var(--border);
  background: var(--bg-glass-heavy);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  flex-shrink: 0;
  position: relative;
  z-index: 2;
}

.menu-btn {
  display: none;
}

.header-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.header-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: -0.01em;
}

.header-sub {
  font-size: 12px;
  color: var(--text-muted);
  font-weight: 400;
}

.chat-header :deep(.el-button:hover) {
  background: var(--bg-elevated) !important;
}

.chat-header :deep(.el-button .el-icon) {
  color: var(--text-muted);
  transition: color var(--duration-fast);
}

.chat-header :deep(.el-button:hover .el-icon) {
  color: var(--accent);
}

@media (width < 900px) {
  .layout {
    grid-template-columns: clamp(220px, 28vw, 260px) 1fr;
  }
}

/* ── 响应式：手机 ────────────────────────────────────── */
@media (width < 768px) {
  .layout {
    grid-template-columns: 1fr;
  }

  .sidebar-desktop {
    display: none;
  }

  .menu-btn {
    display: flex;
  }

  .chat-header {
    padding: 8px 12px;
  }
}

::deep(.sidebar-drawer .el-drawer__body) {
  padding: 0;
  background: var(--bg-secondary);
}
</style>
