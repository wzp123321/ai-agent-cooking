<script setup lang="ts">
/**
 * ProfileSettings — 个人偏好设置弹窗（主入口）
 *
 * 拆分后的结构：
 *   - SkillLevelField   : 烹饪水平（radio）
 *   - DietTypeField     : 膳食模式（select）
 *   - TagInputField     : 通用 tag 输入（过敏 / 忌口共用）
 *   - CalorieField      : 每日热量目标
 *
 * 共享样式在 styles.css 中统一管理。
 */
import { onMounted, reactive, ref } from 'vue'
import { getProfile, updateProfile } from '@/api/chat'
import type { UserProfile } from '@/types'
import SkillLevelField from './SkillLevelField.vue'
import DietTypeField from './DietTypeField.vue'
import TagInputField from './TagInputField.vue'
import CalorieField from './CalorieField.vue'

defineProps<{ visible: boolean }>()
const emit = defineEmits<{
  close: []
  saved: [profile: UserProfile]
}>()

const form = reactive({
  skill_level: 'intermediate' as UserProfile['skill_level'],
  diet_type: '',
  allergies: [] as string[],
  disliked: [] as string[],
  calorie_goal: 0,
})

const saving = ref(false)

onMounted(async () => {
  try {
    const profile = await getProfile()
    form.skill_level = profile.skill_level
    form.diet_type = profile.diet_type
    form.allergies = profile.allergies
    form.disliked = profile.disliked
    form.calorie_goal = profile.calorie_goal
  } catch {
    console.warn('[Profile] 加载用户画像失败，使用默认值')
  }
})

const save = async (): Promise<void> => {
  saving.value = true
  try {
    const profile = await updateProfile({
      skill_level: form.skill_level,
      diet_type: form.diet_type,
      allergies: form.allergies,
      disliked: form.disliked,
      calorie_goal: form.calorie_goal,
    })
    emit('saved', profile)
    emit('close')
  } catch (err) {
    console.error('[Profile] 保存失败：', err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="profile-overlay" v-if="visible" @click.self="emit('close')">
    <div class="profile-panel">
      <div class="profile-header">
        <h2 class="profile-title">⚙️ 个人偏好设置</h2>
        <p class="profile-desc">设置后，Agent 会根据你的偏好调整回答</p>
        <button class="close-btn" @click="emit('close')" title="关闭">✕</button>
      </div>

      <div class="profile-body">
        <div class="form-group">
          <label class="form-label">烹饪水平</label>
          <SkillLevelField v-model="form.skill_level" />
        </div>

        <div class="form-group">
          <label class="form-label">膳食模式</label>
          <DietTypeField v-model="form.diet_type" />
        </div>

        <div class="form-group">
          <label class="form-label">过敏食材</label>
          <TagInputField v-model="form.allergies" placeholder="输入后回车添加…" />
          <span class="form-hint">如：花生、海鲜、牛奶</span>
        </div>

        <div class="form-group">
          <label class="form-label">不喜欢</label>
          <TagInputField v-model="form.disliked" variant="dislike" placeholder="输入后回车添加…" />
          <span class="form-hint">如：香菜、苦瓜、肥肉</span>
        </div>

        <div class="form-group">
          <label class="form-label">
            每日热量目标
            <span class="form-hint-inline">（0 = 不限制）</span>
          </label>
          <CalorieField v-model="form.calorie_goal" />
        </div>
      </div>

      <div class="profile-footer">
        <button class="btn btn-secondary" @click="emit('close')">取消</button>
        <button class="btn btn-primary" @click="save" :disabled="saving">
          {{ saving ? '保存中…' : '保存设置' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style src="./styles.css" />
