<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NModal, useDialog, useMessage } from 'naive-ui'
import { getChapterCharacterCount, getChapterPreviewText } from '@/features/chapters/editorContent'
import { formatChapterWordTargetLabel } from '@/features/chapters/wordTarget'
import { useAppStore } from '@/stores/app'
import type { ChapterDraft, ChapterVersion } from '@/types/app'

const props = defineProps<{
  show: boolean
  chapter: ChapterDraft | null
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
}>()

const appStore = useAppStore()
const dialog = useDialog()
const message = useMessage()

const versions = computed<ChapterVersion[]>(() =>
  props.chapter ? appStore.getChapterVersions(props.chapter.id) : []
)

const STATUS_LABELS: Record<ChapterDraft['status'], string> = {
  draft: '草稿中',
  review: '待检查',
  polish: '待润色',
  final: '已定稿',
  quarantine: '需重写'
}

function formatTime(createdAt: string): string {
  const value = new Date(createdAt)
  if (Number.isNaN(value.getTime())) return '未知时间'
  return value.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function statusChipClass(status: ChapterDraft['status']): string {
  switch (status) {
    case 'final': return 'success'
    case 'polish': return 'accent'
    case 'review': return 'warning'
    case 'quarantine': return 'warning'
    default: return 'neutral'
  }
}

async function saveVersion(): Promise<void> {
  const result = await appStore.saveCurrentChapterVersion()
  if (!result.success) {
    message.error(result.error ?? '保存版本失败')
    return
  }
  message.success('已生成当前章节的历史版本快照')
}

function restore(version: ChapterVersion): void {
  dialog.warning({
    title: '恢复历史版本',
    content: `确定恢复 ${formatTime(version.createdAt)} 的章节快照吗？当前草稿内容将被该版本覆盖。`,
    positiveText: '确认恢复',
    negativeText: '取消',
    autoFocus: false,
    closable: false,
    onPositiveClick: async () => {
      const result = await appStore.restoreChapterVersion(version.id)
      if (!result.success) {
        message.error(result.error ?? '历史版本恢复失败')
        return
      }
      emit('update:show', false)
      message.success('历史版本已恢复到当前章节')
    }
  })
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="章节历史版本"
    :style="{ width: 'min(640px, 92vw)' }"
    :bordered="false"
    @update:show="(v) => emit('update:show', v)"
  >
    <template #header-extra>
      <n-button size="small" type="primary" secondary @click="saveVersion">保存当前版本</n-button>
    </template>

    <div v-if="versions.length" class="version-list arc-scrollbar">
      <article v-for="version in versions" :key="version.id" class="version-card">
        <div class="head">
          <div>
            <strong>{{ formatTime(version.createdAt) }}</strong>
            <p class="version-title">{{ version.title }}</p>
          </div>
          <n-button type="primary" secondary round @click="restore(version)">恢复此版本</n-button>
        </div>

        <div class="meta">
          <span class="chip" :class="statusChipClass(version.status)">
            {{ STATUS_LABELS[version.status] ?? '草稿中' }}
          </span>
          <span class="chip neutral">{{ formatChapterWordTargetLabel(version.wordTarget) }}</span>
          <span class="words">{{ getChapterCharacterCount(version.content) }} 字</span>
        </div>

        <p v-if="version.summary" class="summary">{{ version.summary }}</p>
        <p class="preview">{{ getChapterPreviewText(version.content, '该版本暂无正文内容。').slice(0, 120) }}</p>
      </article>
    </div>
    <div v-else class="empty">
      当前章节还没有历史版本，点击右上角「保存当前版本」后会在这里看到快照。
    </div>
  </n-modal>
</template>

<style scoped>
.version-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 60vh;
  overflow-y: auto;
}

.version-card {
  border: 1px solid var(--arc-border);
  border-radius: var(--arc-radius-md);
  background: var(--arc-bg-surface);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.head strong {
  font-size: 14px;
  color: var(--arc-text-primary);
}

.version-title {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--arc-text-secondary);
}

.meta {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}

.chip {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--arc-bg-surface-hover);
  color: var(--arc-text-secondary);
}

.chip.success { background: color-mix(in srgb, var(--arc-success) 14%, var(--arc-bg-surface)); color: var(--arc-success); }
.chip.warning { background: color-mix(in srgb, var(--arc-warning) 14%, var(--arc-bg-surface)); color: var(--arc-warning); }
.chip.accent { background: var(--arc-primary-soft); color: var(--arc-primary); }

.words {
  font-size: 11px;
  color: var(--arc-text-hint);
}

.summary,
.preview {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--arc-text-secondary);
  user-select: text;
}

.preview {
  color: var(--arc-text-hint);
}

.empty {
  padding: 40px 0;
  text-align: center;
  color: var(--arc-text-hint);
  font-size: 13px;
}
</style>
