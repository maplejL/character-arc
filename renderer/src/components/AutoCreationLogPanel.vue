<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { AutoCreationLogEntry } from '@/features/autoCreation/logTypes'

const props = defineProps<{
  entries: AutoCreationLogEntry[]
  headline?: string
  emptyText?: string
}>()

const listRef = ref<HTMLElement | null>(null)
const autoScroll = ref(true)

const visibleEntries = computed(() => props.entries)

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return ''
  }
}

function levelLabel(level: AutoCreationLogEntry['level']): string {
  switch (level) {
    case 'success':
      return '成功'
    case 'warn':
      return '注意'
    case 'error':
      return '失败'
    default:
      return '进行中'
  }
}

watch(
  () => props.entries.length,
  async () => {
    if (!autoScroll.value || !listRef.value) return
    await nextTick()
    listRef.value.scrollTop = listRef.value.scrollHeight
  },
)

function onScroll(): void {
  const el = listRef.value
  if (!el) return
  autoScroll.value = el.scrollHeight - el.scrollTop - el.clientHeight < 48
}
</script>

<template>
  <section class="auto-creation-log">
    <header class="auto-creation-log-head">
      <span class="auto-creation-kicker">AUTO CREATION</span>
      <h3>{{ headline ?? '创作流水线日志' }}</h3>
    </header>
    <div ref="listRef" class="auto-creation-log-list" @scroll="onScroll">
      <p v-if="!visibleEntries.length" class="auto-creation-log-empty">
        {{ emptyText ?? '等待流水线事件...' }}
      </p>
      <article
        v-for="entry in visibleEntries"
        :key="entry.id"
        class="auto-creation-log-item"
        :class="entry.level"
      >
        <div class="auto-creation-log-meta">
          <span class="time">{{ formatTime(entry.at) }}</span>
          <span class="level">{{ levelLabel(entry.level) }}</span>
          <span v-if="entry.chapterTitle" class="chapter">{{ entry.chapterTitle }}</span>
          <span v-else-if="entry.step" class="step">{{ entry.step }}</span>
        </div>
        <p class="title">{{ entry.title }}</p>
        <p v-if="entry.detail" class="detail">{{ entry.detail }}</p>
        <ul v-if="entry.issues?.length" class="issues">
          <li v-for="(issue, idx) in entry.issues" :key="idx">{{ issue }}</li>
        </ul>
      </article>
    </div>
  </section>
</template>

<style scoped>
.auto-creation-log {
  margin-top: 10px;
  border: 1px solid rgba(148, 163, 184, 0.35);
  border-radius: 12px;
  background: rgba(248, 250, 252, 0.9);
  overflow: hidden;
}

.auto-creation-log-head {
  padding: 12px 14px 8px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.25);
}

.auto-creation-kicker {
  display: inline-block;
  font-size: 10px;
  letter-spacing: 0.08em;
  color: #2563eb;
  font-weight: 700;
}

.auto-creation-log-head h3 {
  margin: 4px 0 0;
  font-size: 15px;
  font-weight: 600;
}

.auto-creation-log-list {
  max-height: 280px;
  overflow-y: auto;
  padding: 10px 12px 12px;
}

.auto-creation-log-empty {
  margin: 0;
  color: #94a3b8;
  font-size: 13px;
}

.auto-creation-log-item {
  padding: 8px 10px;
  border-radius: 8px;
  background: #fff;
  border: 1px solid rgba(148, 163, 184, 0.2);
  margin-bottom: 8px;
}

.auto-creation-log-item.success {
  border-color: rgba(34, 197, 94, 0.35);
}

.auto-creation-log-item.warn {
  border-color: rgba(245, 158, 11, 0.35);
}

.auto-creation-log-item.error {
  border-color: rgba(239, 68, 68, 0.35);
}

.auto-creation-log-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 11px;
  color: #64748b;
  margin-bottom: 4px;
}

.auto-creation-log-item .title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: #0f172a;
}

.auto-creation-log-item .detail {
  margin: 4px 0 0;
  font-size: 12px;
  color: #475569;
  white-space: pre-wrap;
}

.auto-creation-log-item .issues {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 12px;
  color: #b45309;
}
</style>
