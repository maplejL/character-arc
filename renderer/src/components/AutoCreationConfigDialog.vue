<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NCheckbox, NCheckboxGroup, NInput, NInputNumber, NModal, NSelect } from 'naive-ui'
import { useAppStore } from '@/stores/app'
import {
  buildVolumeChapterQueue,
  getTargetOutlineQueueLength,
} from '@/features/autoCreation/buildVolumeChapterQueue'
import {
  DEFAULT_AUTO_CREATION_CONFIG,
  getAutoCreationEffectiveTotal,
  type AutoCreationConfig,
} from '@/features/autoCreation/types'
import { formatChapterWordTargetLabel, validateChapterWordTarget } from '@/features/chapters/wordTarget'

const AUTO_CREATION_CONFIG_STORAGE_KEY = 'characterarc:auto-creation-config'

const props = defineProps<{ show: boolean; volumeId?: string; volumeTitle?: string }>()
const emit = defineEmits<{
  (e: 'confirm', config: Partial<AutoCreationConfig>, options?: { startFromChapterId?: string }): void
  (e: 'cancel'): void
}>()

const appStore = useAppStore()
const project = computed(() => appStore.currentProject)

const maxRepairRounds = ref(DEFAULT_AUTO_CREATION_CONFIG.maxFinalGateRounds)
const maxChapters = ref<number | null>(null)
const targetOutlineItemId = ref<string | null>(null)
const startFromChapterId = ref<string | null>(null)
const forcedWordMin = ref<number | null>(null)
const forcedWordMax = ref<number | null>(null)
const selectedRefIds = ref<string[]>([])
const userPrompt = ref('')

const referenceWorks = computed(() => appStore.referenceWorks)
const projectSkills = computed(() =>
  (project.value?.projectSkills ?? []).filter((skill) => skill.enabled && skill.stageIds.includes('draft')),
)

const volumeOutlineItems = computed(() => {
  if (!props.volumeId) return []
  return appStore.outlineItems
    .filter((item) => item.volumeId === props.volumeId)
    .sort((a, b) => a.sortOrder - b.sortOrder)
})

const volumeQueue = computed(() => {
  if (!props.volumeId) return []
  return buildVolumeChapterQueue({
    volumeId: props.volumeId,
    chapters: appStore.chapters,
    outlineItems: appStore.outlineItems,
  })
})

const volumeQueueSize = computed(() => volumeQueue.value.length)

const startChapterOptions = computed(() => {
  const chaptersById = new Map(appStore.chapters.map((chapter) => [chapter.id, chapter]))
  const options: Array<{ label: string; value: string }> = []
  volumeQueue.value.forEach((entry, index) => {
    if (entry.kind !== 'chapter') return
    const chapter = chaptersById.get(entry.chapterId)
    if (!chapter) return
    options.push({ label: `第 ${index + 1} 章 · ${chapter.title}`, value: chapter.id })
  })
  return options
})

const startFromQueueIndex = computed(() => {
  if (!startFromChapterId.value) return 0
  const index = volumeQueue.value.findIndex(
    (entry) => entry.kind === 'chapter' && entry.chapterId === startFromChapterId.value,
  )
  return index > 0 ? index : 0
})

const remainingQueueSize = computed(() => Math.max(0, volumeQueueSize.value - startFromQueueIndex.value))

const selectedStartChapterLabel = computed(
  () => startChapterOptions.value.find((option) => option.value === startFromChapterId.value)?.label ?? null,
)

const targetOutlineQueueSize = computed(() => {
  if (!props.volumeId || !targetOutlineItemId.value) return volumeQueueSize.value
  return getTargetOutlineQueueLength({
    volumeId: props.volumeId,
    chapters: appStore.chapters,
    outlineItems: appStore.outlineItems,
    targetOutlineItemId: targetOutlineItemId.value,
  }) ?? volumeQueueSize.value
})

const targetOutlineOptions = computed(() =>
  volumeOutlineItems.value.map((item, index) => ({
    label: `${index + 1}. ${item.title}`,
    value: item.id,
  }))
)

const selectedTargetOutline = computed(() =>
  volumeOutlineItems.value.find((item) => item.id === targetOutlineItemId.value) ?? null
)

const effectiveQueueSize = computed(() =>
  Math.min(
    getAutoCreationEffectiveTotal({
      chapterQueueLength: volumeQueueSize.value,
      maxChapters: maxChapters.value ?? undefined,
      targetOutlineQueueLength: targetOutlineItemId.value ? targetOutlineQueueSize.value : undefined,
    }),
    remainingQueueSize.value,
  ),
)

const forcedWordRangeError = computed(() => {
  const min = forcedWordMin.value
  const max = forcedWordMax.value
  if (min == null && max == null) return null
  if (min == null || max == null) return '请同时填写最低与最高字数，或留空使用大纲配置'
  if (min > max) return '最低字数不能高于最高字数'
  if (min < 500 || max > 10000) return '每章字数建议在 500–10000 之间'
  return null
})

const volumeOutlinePreview = computed(() => {
  const siblingTargets = volumeOutlineItems.value.map((item) => item.wordTarget)
  return volumeOutlineItems.value.map((item) => {
    const validation = validateChapterWordTarget(item.wordTarget, {
      siblingWordTargets: siblingTargets.filter((target) => target !== item.wordTarget),
    })
    return {
      id: item.id,
      title: item.title,
      wordLabel: formatChapterWordTargetLabel(item.wordTarget),
      wordWarning: validation.message,
    }
  })
})

function loadSavedConfig(): Partial<AutoCreationConfig> {
  try {
    const raw = localStorage.getItem(AUTO_CREATION_CONFIG_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Partial<AutoCreationConfig>) : {}
  } catch {
    return {}
  }
}

function saveConfig(config: Partial<AutoCreationConfig>): void {
  localStorage.setItem(
    AUTO_CREATION_CONFIG_STORAGE_KEY,
    JSON.stringify({
      maxAuditRepairRounds: config.maxAuditRepairRounds,
      maxFinalGateRounds: config.maxFinalGateRounds,
      maxRepairRounds: config.maxRepairRounds ?? config.maxFinalGateRounds,
      maxChapters: config.maxChapters,
      targetOutlineItemId: config.targetOutlineItemId,
      userPrompt: config.userPrompt,
    }),
  )
}

watch(
  () => props.show,
  (visible) => {
    if (!visible) return
    const saved = loadSavedConfig()
    maxRepairRounds.value =
      saved.maxFinalGateRounds ?? saved.maxAuditRepairRounds ?? DEFAULT_AUTO_CREATION_CONFIG.maxFinalGateRounds
    maxChapters.value = saved.maxChapters ?? null
    targetOutlineItemId.value = saved.targetOutlineItemId ?? null
    startFromChapterId.value = null
    forcedWordMin.value = null
    forcedWordMax.value = null
    selectedRefIds.value = [...(project.value?.selectedReferenceWorkIds ?? [])]
    userPrompt.value = saved.userPrompt ?? ''
  },
)

function handleConfirm(): void {
  if (forcedWordRangeError.value) return
  const rounds = Math.max(0, Math.min(20, Math.round(maxRepairRounds.value)))
  const config: Partial<AutoCreationConfig> = {
    maxAuditRepairRounds: rounds,
    maxFinalGateRounds: rounds,
    maxRepairRounds: rounds,
    selectedReferenceWorkIds: selectedRefIds.value,
    enabledSkillIds: projectSkills.value.map((skill) => skill.id),
    userPrompt: userPrompt.value.trim(),
  }
  if (maxChapters.value != null && maxChapters.value > 0) {
    config.maxChapters = Math.min(Math.round(maxChapters.value), volumeQueueSize.value || maxChapters.value)
  }
  if (targetOutlineItemId.value) {
    config.targetOutlineItemId = targetOutlineItemId.value
  }
  if (forcedWordMin.value != null && forcedWordMax.value != null) {
    config.forcedWordCountMin = forcedWordMin.value
    config.forcedWordCountMax = forcedWordMax.value
  }
  saveConfig(config)
  emit('confirm', config, startFromChapterId.value ? { startFromChapterId: startFromChapterId.value } : undefined)
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    :title="volumeTitle ? `自动创作 · ${volumeTitle}` : '自动创作配置'"
    :style="{ width: 'min(560px, 90vw)' }"
    :mask-closable="true"
    :closable="true"
    :bordered="false"
    @close="$emit('cancel')"
    @mask-click="$emit('cancel')"
  >
    <div class="config-form">
      <section class="outline-summary">
        <p class="summary-title">将按本分卷大纲顺序处理</p>
        <p class="summary-meta">
          本分卷共 <strong>{{ volumeQueueSize }}</strong> 章（已按节点「规划章数」展开）
          <template v-if="selectedStartChapterLabel">
            · 从「<strong>{{ selectedStartChapterLabel }}</strong>」起，剩余 <strong>{{ remainingQueueSize }}</strong> 章
          </template>
          <template v-if="targetOutlineItemId">
            · 处理至「<strong>{{ selectedTargetOutline?.title }}</strong>」（含）共 <strong>{{ targetOutlineQueueSize }}</strong> 章
          </template>
          <template v-if="maxChapters != null && maxChapters > 0 || targetOutlineItemId">
            · 本次实际处理 <strong>{{ effectiveQueueSize }}</strong> 章后停止
          </template>
          <template v-if="forcedWordMin != null && forcedWordMax != null">
            · 强制每章 {{ forcedWordMin }}–{{ forcedWordMax }} 字
          </template>
        </p>
        <ul v-if="volumeOutlinePreview.length" class="outline-preview">
          <li v-for="item in volumeOutlinePreview.slice(0, 6)" :key="item.id">
            <span class="node-title">{{ item.title }}</span>
            <span class="node-word">{{ item.wordLabel }}</span>
            <span v-if="item.wordWarning" class="node-word-warn" :title="item.wordWarning">!</span>
          </li>
          <li v-if="volumeOutlinePreview.length > 6" class="more">… 另有 {{ volumeOutlinePreview.length - 6 }} 个节点</li>
        </ul>
      </section>

      <section class="config-section">
        <label class="section-label">起始章节（可选，用于从某章重跑）</label>
        <p class="section-hint">默认从分卷开头开始；选择后从该章起按顺序处理，内容已合格的章仍会自动跳过</p>
        <n-select
          v-model:value="startFromChapterId"
          :options="startChapterOptions"
          clearable
          filterable
          placeholder="从分卷开头开始（默认）"
          size="small"
        />
      </section>

      <section class="config-section">
        <label class="section-label">强制每章字数（可选）</label>
        <p class="section-hint">留空则使用各大纲节点字数；填写后本分卷每一章都使用该范围（取中位数作为目标）</p>
        <div class="word-range-row">
          <n-input-number v-model:value="forcedWordMin" :min="500" :max="10000" :step="100" placeholder="最低" size="small" clearable />
          <span class="word-range-sep">—</span>
          <n-input-number v-model:value="forcedWordMax" :min="500" :max="10000" :step="100" placeholder="最高" size="small" clearable />
        </div>
        <p v-if="forcedWordRangeError" class="section-error">{{ forcedWordRangeError }}</p>
      </section>

      <section class="config-section">
        <label class="section-label">目标大纲节点（可选）</label>
        <p class="section-hint">从分卷第一个节点起，按顺序处理到所选节点（含）即停止；可与「创作章节总数」同时设置，取更严限制</p>
        <n-select
          v-model:value="targetOutlineItemId"
          :options="targetOutlineOptions"
          clearable
          filterable
          placeholder="如：处理至「总装前夜」节点"
          size="small"
        />
      </section>

      <section class="config-section">
        <label class="section-label">创作章节总数（可选）</label>
        <p class="section-hint">留空则处理至目标节点或全部分卷；填写后按大纲顺序写到第 N 章即停止（含跳过与已完成）</p>
        <n-input-number
          v-model:value="maxChapters"
          :min="1"
          :max="Math.max(volumeQueueSize, 1)"
          :step="1"
          size="small"
          clearable
          placeholder="如 10"
        />
      </section>

      <section class="config-section">
        <label class="section-label">最大修正轮次</label>
        <p class="section-hint">审计与终检未通过时，AI 改稿并重检的上限（默认 5 轮）</p>
        <n-input-number v-model:value="maxRepairRounds" :min="0" :max="20" :step="1" size="small" />
      </section>

      <section v-if="referenceWorks.length > 0" class="config-section">
        <label class="section-label">参考作品（拆书库）</label>
        <n-checkbox-group v-model:value="selectedRefIds">
          <div class="checkbox-list">
            <n-checkbox v-for="work in referenceWorks" :key="work.id" :value="work.id" :label="work.title" />
          </div>
        </n-checkbox-group>
      </section>

      <section class="config-section">
        <label class="section-label">本分卷补充指令（可选）</label>
        <p class="section-hint">叠加到每一章；单章特殊要求请写在大纲节点描述里</p>
        <n-input
          v-model:value="userPrompt"
          type="textarea"
          placeholder="如：本分卷整体节奏偏快、对白多一些..."
          :rows="2"
          size="small"
        />
      </section>
    </div>

    <template #footer>
      <div class="dialog-footer">
        <n-button size="small" @click="$emit('cancel')">取消</n-button>
        <n-button type="primary" size="small" :disabled="Boolean(forcedWordRangeError)" @click="handleConfirm">开始自动创作</n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.config-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.outline-summary {
  padding: 12px 14px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--arc-primary, #2563eb) 8%, var(--arc-surface, #f8fafc));
  border: 1px solid color-mix(in srgb, var(--arc-primary, #2563eb) 18%, var(--arc-border, #e2e8f0));
}
.summary-title {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 600;
}
.summary-meta {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--text-color-3, #64748b);
}
.outline-preview {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 140px;
  overflow-y: auto;
}
.outline-preview li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}
.node-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.node-word {
  flex-shrink: 0;
  color: var(--text-color-3, #64748b);
}
.outline-preview .more {
  color: var(--text-color-3, #94a3b8);
  justify-content: flex-start;
}
.config-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.section-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-color-1, #333);
}
.section-hint {
  font-size: 12px;
  color: var(--text-color-3, #999);
  margin: 0;
}
.node-word-warn {
  flex-shrink: 0;
  color: #b45309;
  font-weight: 700;
}
.word-range-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.word-range-sep {
  color: var(--text-color-3, #94a3b8);
}
.section-error {
  margin: 0;
  font-size: 12px;
  color: #dc2626;
}
.checkbox-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
}
.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
