<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NFormItem, NInputNumber, NModal, NSpin, useMessage } from 'naive-ui'
import { useAppStore } from '@/stores/app'
import {
  formatChapterDisplayTitleFromExisting,
  type ChapterTitleBatchResult
} from '@/features/chapters/chapterTitle'
import { toIpcPayload } from '@/utils/ipcPayload'
import type { ChapterDraft } from '@/types/app'

const props = defineProps<{
  show: boolean
  volumeId?: string
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
}>()

const appStore = useAppStore()
const message = useMessage()

const startChapter = ref(1)
const endChapter = ref(1)
const suggestion = ref('')
const proposedEntries = ref<Array<{ index: number; title: string }>>([])
const loading = ref(false)

const volumeGroup = computed(() =>
  appStore.chapterVolumeGroups.find((group) => group.volume.id === props.volumeId)
  ?? appStore.chapterVolumeGroups.find((group) =>
    group.items.some((chapter) => chapter.id === appStore.selectedChapterId)
  )
  ?? appStore.chapterVolumeGroups[0]
)

const volumeChapters = computed<ChapterDraft[]>(() => volumeGroup.value?.items ?? [])

const selectedIndexInVolume = computed(() => {
  const idx = volumeChapters.value.findIndex((chapter) => chapter.id === appStore.selectedChapterId)
  return idx >= 0 ? idx + 1 : 1
})

const previewRows = computed(() => {
  const start = Math.min(startChapter.value, endChapter.value)
  const end = Math.max(startChapter.value, endChapter.value)
  const proposedMap = new Map(proposedEntries.value.map((entry) => [entry.index, entry.title]))

  return volumeChapters.value
    .map((chapter, index) => {
      const chapterIndex = index + 1
      if (chapterIndex < start || chapterIndex > end) return null
      const outlineTitle = appStore.outlineItems.find((item) => item.id === chapter.outlineItemId)?.title
      return {
        index: chapterIndex,
        chapterId: chapter.id,
        before: chapter.title,
        after: proposedMap.get(chapterIndex)
          ?? formatChapterDisplayTitleFromExisting({
            currentTitle: chapter.title,
            outlineTitle,
            volumeSequence: chapterIndex
          })
      }
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row))
})

function resetRange(): void {
  const total = Math.max(volumeChapters.value.length, 1)
  const current = Math.min(Math.max(selectedIndexInVolume.value, 1), total)
  startChapter.value = current
  endChapter.value = current
}

watch(
  () => props.show,
  (visible) => {
    if (!visible) return
    suggestion.value = ''
    proposedEntries.value = []
    resetRange()
  }
)

function closeDialog(): void {
  emit('update:show', false)
}

function buildChaptersJson(): string {
  return JSON.stringify(
    volumeChapters.value.map((chapter, index) => ({
      index: index + 1,
      title: chapter.title,
      summary: chapter.summary,
      outlineItemTitle: appStore.outlineItems.find((item) => item.id === chapter.outlineItemId)?.title ?? ''
    })),
    null,
    2
  )
}

async function generateSuggestion(): Promise<void> {
  if (volumeChapters.value.length === 0) {
    message.warning('当前分卷没有章节')
    return
  }

  const start = Math.min(startChapter.value, endChapter.value)
  const end = Math.max(startChapter.value, endChapter.value)
  if (start < 1 || end > volumeChapters.value.length) {
    message.warning(`章节范围应在 1–${volumeChapters.value.length} 之间`)
    return
  }

  loading.value = true
  try {
    const response = await window.characterArc.generateAi(toIpcPayload({
      task: 'chapter-title-batch',
      settings: appStore.appSettings,
      context: {
        projectTitle: appStore.currentProject?.title,
        projectGenre: appStore.currentProject?.genre,
        volumeTitle: volumeGroup.value?.volume.title,
        volumeSummary: volumeGroup.value?.volume.summary,
        startChapter: start,
        endChapter: end,
        chaptersJson: buildChaptersJson()
      }
    }))

    if (!response.success) {
      throw new Error(response.error ?? 'AI 标题建议生成失败')
    }

    const result = response.result as ChapterTitleBatchResult | undefined
    if (!result?.suggestion || !Array.isArray(result.entries) || result.entries.length === 0) {
      throw new Error('AI 未返回有效的标题建议')
    }

    suggestion.value = result.suggestion
    proposedEntries.value = result.entries
      .filter((entry) => entry.index >= start && entry.index <= end)
      .map((entry) => ({ index: entry.index, title: entry.title.trim() }))
      .filter((entry) => entry.title)

    if (proposedEntries.value.length === 0) {
      throw new Error('AI 返回的标题建议为空')
    }

    message.success('已生成标题修改建议')
  } catch (error) {
    message.error(error instanceof Error ? error.message : 'AI 标题建议生成失败')
  } finally {
    loading.value = false
  }
}

function applyTitles(): void {
  if (previewRows.value.length === 0) {
    message.warning('没有可应用的章节')
    return
  }

  for (const row of previewRows.value) {
    appStore.updateChapter(row.chapterId, { title: row.after })
  }

  message.success(`已更新 ${previewRows.value.length} 个章节标题`)
  closeDialog()
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    title="AI 修改章节标题"
    style="width: min(640px, 92vw);"
    :mask-closable="!loading"
    @update:show="emit('update:show', $event)"
  >
    <div class="title-batch-body">
      <p class="hint">
        为当前分卷指定章节范围，AI 会给出统一命名建议。确认后将批量替换范围内章节的标题。
      </p>

      <div class="range-row">
        <NFormItem label="开始章节" :show-feedback="false">
          <NInputNumber v-model:value="startChapter" :min="1" :max="Math.max(volumeChapters.length, 1)" />
        </NFormItem>
        <NFormItem label="结束章节" :show-feedback="false">
          <NInputNumber v-model:value="endChapter" :min="1" :max="Math.max(volumeChapters.length, 1)" />
        </NFormItem>
      </div>

      <NSpin :show="loading">
        <section v-if="suggestion" class="suggestion-box">
          <h4>修改建议</h4>
          <p>{{ suggestion }}</p>
        </section>

        <section v-if="previewRows.length" class="preview-box">
          <h4>预览（{{ previewRows.length }} 章）</h4>
          <ul>
            <li v-for="row in previewRows" :key="row.chapterId">
              <span class="idx">第{{ row.index }}章</span>
              <span class="before">{{ row.before }}</span>
              <span class="arrow">→</span>
              <span class="after">{{ row.after }}</span>
            </li>
          </ul>
        </section>

        <p v-else-if="!loading" class="empty-preview">
          点击「生成建议」查看 AI 命名方案；未生成前将使用规则化标题作为预览。
        </p>
      </NSpin>
    </div>

    <template #footer>
      <div class="footer-actions">
        <NButton :disabled="loading" @click="closeDialog">取消</NButton>
        <NButton :disabled="loading || volumeChapters.length === 0" @click="generateSuggestion">
          生成建议
        </NButton>
        <NButton
          type="primary"
          :disabled="loading || previewRows.length === 0"
          @click="applyTitles"
        >
          确认应用
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.title-batch-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.hint {
  margin: 0;
  font-size: 13px;
  color: var(--arc-text-secondary);
  line-height: 1.5;
}

.range-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.suggestion-box,
.preview-box {
  border: 1px solid var(--arc-border);
  border-radius: var(--arc-radius-sm);
  padding: 12px;
  background: var(--arc-bg-surface-hover);
}

.suggestion-box h4,
.preview-box h4 {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--arc-text-primary);
}

.suggestion-box p {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--arc-text-secondary);
  white-space: pre-wrap;
}

.preview-box ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.preview-box li {
  display: grid;
  grid-template-columns: auto 1fr auto 1fr;
  gap: 8px;
  align-items: start;
  font-size: 12px;
}

.idx {
  color: var(--arc-text-hint);
  white-space: nowrap;
}

.before {
  color: var(--arc-text-secondary);
  word-break: break-word;
}

.arrow {
  color: var(--arc-text-hint);
}

.after {
  color: var(--arc-primary);
  font-weight: 500;
  word-break: break-word;
}

.empty-preview {
  margin: 0;
  font-size: 12px;
  color: var(--arc-text-hint);
}

.footer-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
