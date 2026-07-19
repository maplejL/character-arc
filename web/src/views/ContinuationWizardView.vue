<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  parseManuscriptFiles,
  readFilesAsText,
  seedContinuationProject,
  type ParsedChapterCandidate,
} from '../lib/continuationClient'
const router = useRouter()

const step = ref(1)
const loading = ref(false)
const error = ref<string | null>(null)
const warnings = ref<string[]>([])
const chapters = ref<ParsedChapterCandidate[]>([])
const forceSingleBook = ref(false)
const markLastAsPartial = ref(false)
const runBackfill = ref(true)
/** 默认不勾选：反推耗 token；创建后可在工作台横幅再点 */
const runReverseExtract = ref(false)

const meta = reactive({
  title: '',
  genre: '',
  wordCount: '',
})

const totalChars = computed(() => chapters.value.reduce((sum, chapter) => sum + chapter.charCount, 0))

async function onPickFiles(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const fileList = input.files
  input.value = ''
  if (!fileList?.length) return
  error.value = null
  loading.value = true
  try {
    const files = await readFilesAsText(fileList)
    const result = await parseManuscriptFiles(files, forceSingleBook.value ? 'force-single-book' : 'auto')
    chapters.value = result.chapters.map((chapter) => ({ ...chapter }))
    warnings.value = result.warnings
    if (!meta.title.trim() && result.detectedTitle) meta.title = result.detectedTitle
    if (result.chapters.length === 0) {
      error.value = result.warnings.join('；') || '没有识别到可读章节'
      return
    }
    step.value = 2
  } catch (e) {
    error.value = e instanceof Error ? e.message : '解析失败'
  } finally {
    loading.value = false
  }
}

function removeChapter(index: number): void {
  chapters.value = chapters.value.filter((_, i) => i !== index).map((chapter, i) => ({
    ...chapter,
    index: i + 1,
  }))
}

function moveChapter(index: number, delta: number): void {
  const next = index + delta
  if (next < 0 || next >= chapters.value.length) return
  const list = [...chapters.value]
  const tmp = list[index]!
  list[index] = list[next]!
  list[next] = tmp
  chapters.value = list.map((chapter, i) => ({ ...chapter, index: i + 1 }))
}

async function createProject(): Promise<void> {
  if (!meta.title.trim()) {
    error.value = '请填写书名'
    return
  }
  if (chapters.value.length === 0) {
    error.value = '没有可导入的章节'
    return
  }
  error.value = null
  loading.value = true
  try {
    const result = await seedContinuationProject({
      title: meta.title.trim(),
      genre: meta.genre.trim() || undefined,
      wordCount: meta.wordCount.trim() || undefined,
      chapters: chapters.value.map((chapter) => ({
        title: chapter.title,
        plainText: chapter.plainText,
        isPartial: chapter.isPartial,
      })),
      markLastAsPartial: markLastAsPartial.value,
      sourceSummary: `${chapters.value.length} 章 · 约 ${totalChars.value} 字 · Web 原稿导入`,
    })

    await router.push({
      path: `/studio/${result.projectId}`,
      query: {
        continuation: '1',
        ...(runBackfill.value ? { backfill: '1' } : {}),
        ...(runReverseExtract.value ? { reverseExtract: '1' } : {}),
      },
    })
  } catch (e) {
    error.value = e instanceof Error ? e.message : '创建失败'
  } finally {
    loading.value = false
  }
}

function backHome(): void {
  void router.push('/')
}
</script>

<template>
  <div class="cont-page">
    <div class="cont-page__inner">
      <header class="cont-hero">
        <button type="button" class="cont-link" data-testid="continuation-back" @click="backHome">
          ← 返回工作台
        </button>
        <p class="cont-hero__eyebrow">作品续写</p>
        <h1>从半成品继续写</h1>
        <p class="cont-hero__desc">
          导入已有章节正文，创建新项目并写入断点。与章节助手里的「续写一小段」不同，这里是整本接写。
        </p>
        <div class="cont-steps">
          <span :class="{ active: step === 1 }">1 选源</span>
          <span :class="{ active: step === 2 }">2 预览</span>
          <span :class="{ active: step === 3 }">3 创建</span>
        </div>
      </header>

      <p v-if="error" class="cont-error" data-testid="continuation-error">{{ error }}</p>

      <section v-if="step === 1" class="cont-panel" data-testid="continuation-step-source">
        <h2>选择原稿</h2>
        <p class="cont-muted">支持多文件（每文件一章）或单文件整本（按「第N章」标题切分）。格式：txt / md。</p>
        <label class="cont-check">
          <input v-model="forceSingleBook" type="checkbox" />
          强制按整本切章（合并所选文件后按章节标题切分）
        </label>
        <label class="cont-file-btn">
          <input
            type="file"
            multiple
            accept=".txt,.md,.markdown,text/plain"
            data-testid="continuation-file-input"
            :disabled="loading"
            @change="onPickFiles"
          />
          {{ loading ? '解析中…' : '选择文件' }}
        </label>
      </section>

      <section v-else-if="step === 2" class="cont-panel" data-testid="continuation-step-preview">
        <h2>预览章节（{{ chapters.length }} 章 · 约 {{ totalChars }} 字）</h2>
        <ul v-if="warnings.length" class="cont-warnings">
          <li v-for="(w, i) in warnings" :key="i">{{ w }}</li>
        </ul>
        <div v-for="(chapter, index) in chapters" :key="chapter.index" class="cont-chapter">
          <div class="cont-chapter__head">
            <input v-model="chapter.title" class="cont-input" data-testid="continuation-chapter-title" />
            <span class="cont-muted">{{ chapter.charCount }} 字</span>
            <button type="button" class="cont-mini" @click="moveChapter(index, -1)">上移</button>
            <button type="button" class="cont-mini" @click="moveChapter(index, 1)">下移</button>
            <button type="button" class="cont-mini cont-mini--danger" @click="removeChapter(index)">删除</button>
          </div>
          <p class="cont-preview">{{ chapter.plainText.slice(0, 160) }}{{ chapter.plainText.length > 160 ? '…' : '' }}</p>
        </div>
        <div class="cont-actions">
          <button type="button" class="cont-btn" :disabled="loading" @click="step = 1">上一步</button>
          <button
            type="button"
            class="cont-btn cont-btn--primary"
            data-testid="continuation-to-meta"
            :disabled="loading || chapters.length === 0"
            @click="step = 3"
          >
            下一步
          </button>
        </div>
      </section>

      <section v-else class="cont-panel" data-testid="continuation-step-meta">
        <h2>项目信息</h2>
        <label class="cont-field">
          <span>书名</span>
          <input v-model="meta.title" class="cont-input" required data-testid="continuation-title" placeholder="作品标题" />
        </label>
        <label class="cont-field">
          <span>题材</span>
          <input v-model="meta.genre" class="cont-input" data-testid="continuation-genre" placeholder="玄幻 / 都市 …" />
        </label>
        <label class="cont-field">
          <span>目标字数</span>
          <input v-model="meta.wordCount" class="cont-input" placeholder="100 万字" />
        </label>
        <label class="cont-check">
          <input v-model="markLastAsPartial" type="checkbox" data-testid="continuation-partial" />
          最后一章是残稿（未完成，断点停在上一章）
        </label>
        <label class="cont-check">
          <input v-model="runBackfill" type="checkbox" data-testid="continuation-backfill-opt" />
          创建后自动补录故事状态（可跳过，稍后在写作台补）
        </label>
        <label class="cont-check">
          <input v-model="runReverseExtract" type="checkbox" data-testid="continuation-reverse-opt" />
          创建后 AI 反推大纲 / 角色 / 世界观 / 关系网（耗 token，默认关；也可在写作台横幅点）
        </label>
        <div class="cont-actions">
          <button type="button" class="cont-btn" :disabled="loading" @click="step = 2">上一步</button>
          <button
            type="button"
            class="cont-btn cont-btn--primary"
            data-testid="continuation-create"
            :disabled="loading"
            @click="createProject"
          >
            {{ loading ? '创建中…' : '创建并进入写作台' }}
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.cont-page {
  min-height: 100vh;
  background: radial-gradient(ellipse at top, #1e293b 0%, #0f172a 55%);
  color: #e2e8f0;
  padding: 2rem 1rem 4rem;
}
.cont-page__inner {
  max-width: 840px;
  margin: 0 auto;
}
.cont-hero h1 {
  margin: 0.25rem 0;
  font-size: 1.75rem;
}
.cont-hero__eyebrow {
  color: #94a3b8;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-size: 0.75rem;
  margin: 0.75rem 0 0;
}
.cont-hero__desc {
  color: #94a3b8;
  line-height: 1.6;
}
.cont-steps {
  display: flex;
  gap: 0.75rem;
  margin-top: 1rem;
}
.cont-steps span {
  padding: 0.25rem 0.75rem;
  border-radius: 999px;
  border: 1px solid rgba(148, 163, 184, 0.25);
  color: #64748b;
  font-size: 0.85rem;
}
.cont-steps span.active {
  color: #e2e8f0;
  border-color: #38bdf8;
  background: rgba(56, 189, 248, 0.12);
}
.cont-panel {
  margin-top: 1.5rem;
  padding: 1.25rem;
  border-radius: 16px;
  background: rgba(15, 23, 42, 0.72);
  border: 1px solid rgba(148, 163, 184, 0.18);
}
.cont-muted {
  color: #94a3b8;
  font-size: 0.9rem;
}
.cont-link {
  background: none;
  border: none;
  color: #7dd3fc;
  cursor: pointer;
  padding: 0;
}
.cont-file-btn {
  display: inline-flex;
  margin-top: 1rem;
  padding: 0.65rem 1.25rem;
  border-radius: 10px;
  background: #0ea5e9;
  color: #0f172a;
  font-weight: 600;
  cursor: pointer;
}
.cont-file-btn input {
  display: none;
}
.cont-check {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
  margin: 0.75rem 0;
  color: #cbd5e1;
  font-size: 0.92rem;
}
.cont-chapter {
  margin: 0.75rem 0;
  padding: 0.75rem;
  border-radius: 10px;
  background: rgba(30, 41, 59, 0.6);
}
.cont-chapter__head {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}
.cont-input {
  flex: 1;
  min-width: 160px;
  padding: 0.45rem 0.65rem;
  border-radius: 8px;
  border: 1px solid rgba(148, 163, 184, 0.25);
  background: #0f172a;
  color: inherit;
}
.cont-preview {
  margin: 0.5rem 0 0;
  color: #94a3b8;
  font-size: 0.85rem;
  line-height: 1.5;
  white-space: pre-wrap;
}
.cont-mini {
  border: 1px solid rgba(148, 163, 184, 0.3);
  background: transparent;
  color: #cbd5e1;
  border-radius: 6px;
  padding: 0.2rem 0.5rem;
  cursor: pointer;
  font-size: 0.8rem;
}
.cont-mini--danger {
  color: #fca5a5;
}
.cont-field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin-bottom: 0.85rem;
}
.cont-actions {
  display: flex;
  gap: 0.75rem;
  margin-top: 1.25rem;
}
.cont-btn {
  padding: 0.55rem 1rem;
  border-radius: 10px;
  border: 1px solid rgba(148, 163, 184, 0.3);
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.cont-btn--primary {
  background: #0ea5e9;
  border-color: #0ea5e9;
  color: #0f172a;
  font-weight: 600;
}
.cont-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.cont-error {
  color: #fca5a5;
  margin-top: 1rem;
}
.cont-warnings {
  color: #fcd34d;
  font-size: 0.9rem;
}
</style>
