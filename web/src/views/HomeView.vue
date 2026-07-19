<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useWorkspaceStore } from '../stores/workspace'
import {
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_DEEPSEEK_MODEL,
  OPENCODE_DEEPSEEK_BASE_URL,
  OPENCODE_DEEPSEEK_MODEL,
  CENTOS_OPENAI_BASE_URL,
  CENTOS_OPENAI_MODEL,
} from '../lib/defaults'
import type { AiProfileWrite, ChapterProductionModelsRead } from '../lib/types'
import { resolveAiPreset, type AiPresetId } from '../lib/aiProviderLabel'
import AiModelField from '../components/AiModelField.vue'
import type { AiModelCredential } from '../composables/useAiModelPicker'

const auth = useAuthStore()
const workspace = useWorkspaceStore()
const router = useRouter()
const testResult = ref<string | null>(null)
const newInvite = ref<string | null>(null)
const importInput = ref<HTMLInputElement | null>(null)
const importing = ref(false)
const importMessage = ref<string | null>(null)

const projectForm = reactive({
  title: '',
  genre: '',
  wordCount: '',
})

type ProfileForm = AiProfileWrite & { hasApiKey?: boolean }

const profileForms = ref<ProfileForm[]>([])
const activeProfileIndex = ref(0)
const productionModels = reactive<ChapterProductionModelsRead>({
  draftProfileId: '',
  draftModel: '',
  repairProfileId: '',
  repairModel: '',
  auditProfileId: '',
  auditModel: '',
})

type ProductionRole = 'draft' | 'repair' | 'audit'
type AiPreset = 'deepseek' | 'opencode' | 'centos'

const productionRoleMeta: Record<
  ProductionRole,
  {
    profileKey: keyof ChapterProductionModelsRead
    modelKey: keyof ChapterProductionModelsRead
    label: string
    testId: string
  }
> = {
  draft: {
    profileKey: 'draftProfileId',
    modelKey: 'draftModel',
    label: '初稿（备忘 / 写作 / 日志）',
    testId: 'prod-draft',
  },
  repair: {
    profileKey: 'repairProfileId',
    modelKey: 'repairModel',
    label: '定点修复',
    testId: 'prod-repair',
  },
  audit: {
    profileKey: 'auditProfileId',
    modelKey: 'auditModel',
    label: '质量审查（质检 / 契约审计）',
    testId: 'prod-audit',
  },
}

function generateProfileId(): string {
  return `profile-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function createEmptyProfile(name?: string): ProfileForm {
  return {
    id: generateProfileId(),
    name: name ?? `供应商 ${profileForms.value.length + 1}`,
    provider: 'openai-compatible',
    model: '',
    baseUrl: '',
  }
}

function formatSupplierLabel(profile: ProfileForm, index: number): string {
  const name = profile.name?.trim() || `供应商 ${index + 1}`
  const preset = resolveAiPreset({ provider: profile.provider, baseUrl: profile.baseUrl })
  const host = profile.baseUrl?.replace(/^https?:\/\//i, '').split('/')[0] || ''
  if (preset.id !== 'unknown' && preset.id !== 'deepseek') return `${name} · ${preset.label}`
  if (host) return `${name} · ${host}`
  return name
}

function productionModelForProfile(profileId: string): string {
  for (const role of ['draft', 'repair', 'audit'] as ProductionRole[]) {
    if (productionProfileId(role) === profileId) {
      return productionModelValue(role)
    }
  }
  return ''
}

function repairProductionBindings(): void {
  const ids = new Set(profileForms.value.map((profile) => profile.id).filter(Boolean))
  for (const role of ['draft', 'repair', 'audit'] as ProductionRole[]) {
    const meta = productionRoleMeta[role]
    const profileId = productionProfileId(role)
    if (profileId && !ids.has(profileId)) {
      productionModels[meta.profileKey] = ''
      productionModels[meta.modelKey] = ''
    }
  }
}

function alignProfileModelsFromProduction(): void {
  for (const profile of profileForms.value) {
    if (!profile.id) continue
    const boundModel = productionModelForProfile(profile.id)
    if (boundModel) profile.model = boundModel
  }
}

function syncProfilesFromConfig(): void {
  const cfg = auth.aiConfig
  if (!cfg) {
    profileForms.value = [createEmptyProfile('供应商 1')]
    activeProfileIndex.value = 0
    return
  }

  profileForms.value =
    cfg.aiProfiles.length > 0
      ? cfg.aiProfiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
          provider: profile.provider,
          model: profile.model,
          baseUrl: profile.baseUrl,
          hasApiKey: profile.hasApiKey,
        }))
      : [
          {
            id: cfg.activeAiProfileId || generateProfileId(),
            name: '供应商 1',
            provider: cfg.provider,
            model: cfg.model,
            baseUrl: cfg.baseUrl,
            hasApiKey: cfg.hasApiKey,
          },
        ]

  // 仅补全缺失 id；勿随意改已有 id，否则会与章节生产绑定脱节
  for (const profile of profileForms.value) {
    if (!profile.id) {
      profile.id = generateProfileId()
    }
  }

  repairProductionBindings()

  if (activeProfileIndex.value >= profileForms.value.length) {
    activeProfileIndex.value = Math.max(0, profileForms.value.length - 1)
  }

  productionModels.draftProfileId = cfg.chapterProductionModels?.draftProfileId ?? ''
  productionModels.draftModel = cfg.chapterProductionModels?.draftModel ?? ''
  productionModels.repairProfileId = cfg.chapterProductionModels?.repairProfileId ?? ''
  productionModels.repairModel = cfg.chapterProductionModels?.repairModel ?? ''
  productionModels.auditProfileId = cfg.chapterProductionModels?.auditProfileId ?? ''
  productionModels.auditModel = cfg.chapterProductionModels?.auditModel ?? ''

  for (const role of ['draft', 'repair', 'audit'] as ProductionRole[]) {
    if (!productionModelValue(role) && productionProfileId(role)) {
      const profile = profileForms.value.find((item) => item.id === productionProfileId(role))
      if (profile?.model?.trim()) {
        productionModels[productionRoleMeta[role].modelKey] = profile.model.trim()
      }
    }
  }
}

const supplierSelectOptions = computed(() =>
  profileForms.value.map((profile, index) => ({
    label: formatSupplierLabel(profile, index),
    shortLabel: profile.name?.trim() || `供应商 ${index + 1}`,
    value: profile.id ?? '',
    index,
  })),
)

const activeProfile = computed(() => profileForms.value[activeProfileIndex.value] ?? null)

const savingSuppliers = ref(false)

const savedSupplierSummary = computed(() => {
  const saved = auth.aiConfig?.aiProfiles?.length ?? 0
  if (!auth.aiConfig || saved === 0) return '尚未保存供应商'
  return `已保存 ${saved} 个供应商`
})

function resolveProfileCredentials(profileId: string): AiModelCredential {
  const profile = profileForms.value.find((item) => item.id === profileId)
  if (profile) {
    return {
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
      profileId: profile.id,
      hasSavedApiKey: profile.hasApiKey,
    }
  }
  const saved = auth.aiConfig?.aiProfiles?.find((item) => item.id === profileId)
  if (saved) {
    return {
      provider: saved.provider,
      baseUrl: saved.baseUrl,
      apiKey: '',
      profileId: saved.id,
      hasSavedApiKey: saved.hasApiKey,
    }
  }
  return {
    provider: 'deepseek',
    baseUrl: '',
    apiKey: '',
    profileId,
    hasSavedApiKey: false,
  }
}

function productionProfileId(role: ProductionRole): string {
  const key = productionRoleMeta[role].profileKey
  return String(productionModels[key] ?? '')
}

function productionModelValue(role: ProductionRole): string {
  const key = productionRoleMeta[role].modelKey
  return String(productionModels[key] ?? '')
}

function setProductionProfile(role: ProductionRole, profileId: string): void {
  const meta = productionRoleMeta[role]
  const prevProfileId = productionProfileId(role)
  productionModels[meta.profileKey] = profileId
  if (!profileId) {
    productionModels[meta.modelKey] = ''
    return
  }
  // 切换供应商时清空模型，避免「CentOS 供应商 + Grok 模型」这类串配
  if (profileId !== prevProfileId) {
    productionModels[meta.modelKey] = ''
    return
  }
  const profile = profileForms.value.find((item) => item.id === profileId)
  if (!productionModelValue(role) && profile?.model?.trim()) {
    productionModels[meta.modelKey] = profile.model.trim()
  }
}

function setProductionModel(role: ProductionRole, model: string): void {
  productionModels[productionRoleMeta[role].modelKey] = model
}

function productionCredentials(role: ProductionRole): AiModelCredential {
  return resolveProfileCredentials(productionProfileId(role))
}

function addProfile(): void {
  profileForms.value.push(createEmptyProfile())
  activeProfileIndex.value = profileForms.value.length - 1
}

function removeProfile(profileId?: string): void {
  if (!profileId || profileForms.value.length <= 1) return
  const removeIndex = profileForms.value.findIndex((profile) => profile.id === profileId)
  profileForms.value = profileForms.value.filter((profile) => profile.id !== profileId)
  if (activeProfileIndex.value >= profileForms.value.length) {
    activeProfileIndex.value = Math.max(0, profileForms.value.length - 1)
  } else if (removeIndex >= 0 && removeIndex < activeProfileIndex.value) {
    activeProfileIndex.value -= 1
  }
  for (const role of ['draft', 'repair', 'audit'] as ProductionRole[]) {
    if (productionProfileId(role) === profileId) {
      setProductionProfile(role, '')
    }
  }
}

function selectProfileTab(index: number): void {
  if (index < 0 || index >= profileForms.value.length) return
  activeProfileIndex.value = index
}

function buildProfilesPayload(): AiProfileWrite[] {
  alignProfileModelsFromProduction()
  return profileForms.value.map((profile, index) => {
    const id = profile.id || generateProfileId()
    const trimmedName = profile.name?.trim() ?? ''
    const boundModel = productionModelForProfile(id)
    return {
      id,
      name: trimmedName || `供应商 ${index + 1}`,
      provider: profile.provider,
      model: boundModel || profile.model?.trim() || DEFAULT_DEEPSEEK_MODEL,
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey || undefined,
    }
  })
}

function applyAiPresetToProfile(profile: ProfileForm, preset: AiPreset): void {
  if (preset === 'deepseek') {
    profile.provider = 'deepseek'
    profile.model = DEFAULT_DEEPSEEK_MODEL
    profile.baseUrl = DEFAULT_DEEPSEEK_BASE_URL
  } else if (preset === 'opencode') {
    profile.provider = 'openai-compatible'
    profile.model = OPENCODE_DEEPSEEK_MODEL
    profile.baseUrl = OPENCODE_DEEPSEEK_BASE_URL
  } else {
    profile.provider = 'openai-compatible'
    profile.model = CENTOS_OPENAI_MODEL
    profile.baseUrl = CENTOS_OPENAI_BASE_URL
  }
}

function isProfilePresetActive(profile: ProfileForm, preset: AiPresetId): boolean {
  return resolveAiPreset({ provider: profile.provider, baseUrl: profile.baseUrl }).id === preset
}

function openProject(projectId: string): void {
  void router.push(`/studio/${projectId}`)
}

onMounted(async () => {
  try {
    await auth.fetchMe()
    await auth.loadAiConfig()
    syncProfilesFromConfig()
    await workspace.fetchProjects()
  } catch {
    /* 401 时 api 层会跳转登录 */
  }
})

async function createProject() {
  if (!projectForm.title.trim()) return
  await workspace.createProject({
    title: projectForm.title.trim(),
    genre: projectForm.genre.trim(),
    wordCount: projectForm.wordCount.trim(),
  })
  projectForm.title = ''
  projectForm.genre = ''
  projectForm.wordCount = ''
}

function buildChapterProductionPayload() {
  return {
    draftProfileId: productionModels.draftProfileId || undefined,
    draftModel: productionModels.draftModel || undefined,
    repairProfileId: productionModels.repairProfileId || undefined,
    repairModel: productionModels.repairModel || undefined,
    auditProfileId: productionModels.auditProfileId || undefined,
    auditModel: productionModels.auditModel || undefined,
  }
}

async function saveSuppliers(): Promise<void> {
  savingSuppliers.value = true
  testResult.value = null
  try {
    const profiles = buildProfilesPayload()
    if (profiles.length === 0) return
    const current = profiles[activeProfileIndex.value] ?? profiles[0]
    const cfg = auth.aiConfig
    await auth.saveAiConfig({
      provider: current?.provider ?? cfg?.provider ?? 'deepseek',
      model: current?.model ?? cfg?.model ?? DEFAULT_DEEPSEEK_MODEL,
      baseUrl: current?.baseUrl || undefined,
      apiKey: current?.apiKey || undefined,
      activeAiProfileId: current?.id ?? cfg?.activeAiProfileId,
      aiProfiles: profiles,
      chapterProductionModels: buildChapterProductionPayload(),
    })
    syncProfilesFromConfig()
    testResult.value = `已保存 ${profiles.length} 个供应商`
  } finally {
    savingSuppliers.value = false
  }
}

async function save() {
  testResult.value = null
  const profiles = buildProfilesPayload()
  if (profiles.length === 0) return

  const activeAiProfileId =
    productionModels.draftProfileId
    || productionModels.repairProfileId
    || productionModels.auditProfileId
    || profiles[0]?.id
    || 'profile-default'
  const activeProfile = profiles.find((p) => p.id === activeAiProfileId) ?? profiles[0]

  await auth.saveAiConfig({
    provider: activeProfile?.provider ?? 'deepseek',
    model: activeProfile?.model ?? DEFAULT_DEEPSEEK_MODEL,
    baseUrl: activeProfile?.baseUrl || undefined,
    apiKey: activeProfile?.apiKey || undefined,
    activeAiProfileId,
    aiProfiles: profiles,
    chapterProductionModels: buildChapterProductionPayload(),
  })
  syncProfilesFromConfig()
  testResult.value = '配置已全部保存'
}

async function testConnection() {
  testResult.value = '测试中…'
  try {
    const res = await auth.testAiConfig()
    testResult.value = res.ok
      ? `连接成功 · ${res.model} · ${res.latencyMs}ms · ${res.message ?? ''}`
      : `连接失败 · ${res.message ?? ''}`
  } catch {
    testResult.value = '连接失败，请先保存有效 API Key'
  }
}

async function genInvite() {
  const res = await auth.createInviteCode(5)
  newInvite.value = res.code
}

function pickImportFile() {
  importInput.value?.click()
}

async function onImportFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  importing.value = true
  importMessage.value = null
  try {
    const created = await workspace.importProject(file)
    importMessage.value = `已导入「${created.title}」`
  } catch (e) {
    importMessage.value = e instanceof Error ? e.message : '导入失败'
  } finally {
    importing.value = false
  }
}
</script>

<template>
  <div class="app-page">
    <div class="app-page__glow app-page__glow--a" aria-hidden="true" />
    <div class="app-page__glow app-page__glow--b" aria-hidden="true" />

    <div class="app-page__inner">
      <header class="app-hero">
        <p class="app-hero__eyebrow">工作台</p>
        <h1 data-testid="home-welcome">你好，{{ auth.user?.email?.split('@')[0] ?? '作者' }}</h1>
        <p class="app-hero__desc">管理作品、配置 AI，点击作品进入完整写作台。</p>
        <div class="app-hero__chips">
          <span class="app-chip">{{ auth.user?.role === 'ADMIN' ? '管理员' : '作者' }}</span>
          <span class="app-chip app-chip--muted">BYOK</span>
          <span class="app-chip app-chip--muted">邀请制</span>
        </div>
      </header>

      <section class="app-panel">
        <div class="app-panel__head">
          <h2>我的作品</h2>
          <p class="app-panel__subtitle">创建并管理你的小说项目</p>
        </div>
        <form class="app-form-grid" @submit.prevent="createProject">
          <label class="app-field span2">
            <span class="app-field__label">书名</span>
            <input
              v-model="projectForm.title"
              class="app-input"
              data-testid="project-title"
              required
              placeholder="新作品标题"
            />
          </label>
          <label class="app-field">
            <span class="app-field__label">题材</span>
            <input
              v-model="projectForm.genre"
              class="app-input"
              data-testid="project-genre"
              placeholder="玄幻 / 都市 …"
            />
          </label>
          <label class="app-field">
            <span class="app-field__label">目标字数</span>
            <input
              v-model="projectForm.wordCount"
              class="app-input"
              data-testid="project-word-count"
              placeholder="100 万字"
            />
          </label>
          <div class="app-actions span2">
            <button type="submit" class="app-btn app-btn--primary" data-testid="project-create">创建作品</button>
            <button
              type="button"
              class="app-btn app-btn--secondary"
              data-testid="project-continuation"
              @click="router.push('/continuation')"
            >
              作品续写
            </button>
            <button
              type="button"
              class="app-btn app-btn--secondary"
              data-testid="project-import"
              :disabled="importing"
              @click="pickImportFile"
            >
              {{ importing ? '导入中…' : '导入 .carc' }}
            </button>
            <input
              ref="importInput"
              type="file"
              accept=".carc"
              hidden
              data-testid="project-import-input"
              @change="onImportFile"
            />
          </div>
        </form>
        <p v-if="importMessage" class="app-hint" data-testid="project-import-message">{{ importMessage }}</p>
        <p v-if="workspace.error" class="app-hint app-hint--error">{{ workspace.error }}</p>
        <ul v-if="workspace.projects.length" class="project-list" data-testid="project-list">
          <li v-for="p in workspace.projects" :key="p.id" data-testid="project-item">
            <div class="project-list__row">
              <div>
                <strong>{{ p.title }}</strong>
                <span class="muted">{{ p.genre || '未分类' }} · {{ p.lastEdited }}</span>
              </div>
              <button
                type="button"
                class="app-btn app-btn--secondary app-btn--compact"
                data-testid="project-open"
                @click="openProject(p.id)"
              >
                打开写作台
              </button>
            </div>
          </li>
        </ul>
        <p v-else class="app-empty" data-testid="project-empty">暂无作品，创建第一本吧。</p>
      </section>

      <section class="app-panel ai-panel">
        <div class="app-panel__head ai-panel__head">
          <div>
            <h2>AI 配置</h2>
            <p class="app-panel__subtitle">配置供应商，并为初稿 / 修复 / 审查分别绑定模型</p>
          </div>
          <span class="ai-panel__badge" data-testid="ai-current-provider-label">{{ savedSupplierSummary }}</span>
        </div>

        <div class="ai-panel__form">
          <div class="ai-suppliers">
            <div class="ai-suppliers__layout">
              <aside class="ai-suppliers__sidebar">
                <p class="ai-suppliers__sidebar-title">供应商列表</p>
                <button
                  v-for="opt in supplierSelectOptions"
                  :key="`supplier-item-${opt.value}`"
                  type="button"
                  class="ai-suppliers__item"
                  :class="{ 'is-active': activeProfileIndex === opt.index }"
                  @click="selectProfileTab(opt.index)"
                >
                  <span class="ai-suppliers__item-name">{{ opt.shortLabel }}</span>
                  <span class="ai-suppliers__item-meta">{{ opt.label }}</span>
                </button>
                <button
                  type="button"
                  class="ai-suppliers__add"
                  data-testid="ai-add-profile"
                  @click="addProfile"
                >
                  + 添加供应商
                </button>
              </aside>

              <div
                v-if="activeProfile"
                :key="activeProfile.id"
                class="ai-supplier-panel"
                :data-testid="`ai-profile-card-${activeProfileIndex}`"
              >
                <div class="ai-supplier-panel__top">
                  <div class="ai-preset-chips">
                    <span class="ai-preset-chips__label">快捷填入</span>
                    <button
                      type="button"
                      class="ai-preset-chip"
                      :class="{ 'is-active': isProfilePresetActive(activeProfile, 'deepseek') }"
                      @click="applyAiPresetToProfile(activeProfile, 'deepseek')"
                    >
                      DeepSeek
                    </button>
                    <button
                      type="button"
                      class="ai-preset-chip"
                      :class="{ 'is-active': isProfilePresetActive(activeProfile, 'opencode') }"
                      @click="applyAiPresetToProfile(activeProfile, 'opencode')"
                    >
                      OpenCode
                    </button>
                    <button
                      type="button"
                      class="ai-preset-chip"
                      :class="{ 'is-active': isProfilePresetActive(activeProfile, 'centos') }"
                      @click="applyAiPresetToProfile(activeProfile, 'centos')"
                    >
                      CentOS
                    </button>
                  </div>
                  <button
                    v-if="profileForms.length > 1"
                    type="button"
                    class="ai-supplier-panel__delete"
                    @click="removeProfile(activeProfile.id)"
                  >
                    删除
                  </button>
                </div>

                <div class="app-form-grid ai-supplier-panel__grid">
                  <label class="app-field span2">
                    <span class="app-field__label">名称</span>
                    <input
                      :id="`profile-name-${activeProfile.id}`"
                      v-model="profileForms[activeProfileIndex].name"
                      class="app-input"
                      placeholder="例如 CentOS DeepSeek"
                    />
                  </label>
                  <label class="app-field">
                    <span class="app-field__label">Provider</span>
                    <select v-model="profileForms[activeProfileIndex].provider" class="app-input">
                      <option value="deepseek">DeepSeek</option>
                      <option value="openai-compatible">OpenAI Compatible</option>
                    </select>
                  </label>
                  <label class="app-field span2">
                    <span class="app-field__label">Base URL</span>
                    <input
                      v-model="profileForms[activeProfileIndex].baseUrl"
                      class="app-input"
                      placeholder="https://..."
                    />
                  </label>
                  <label class="app-field span2">
                    <span class="app-field__label">API Key</span>
                    <input
                      v-model="profileForms[activeProfileIndex].apiKey"
                      class="app-input app-input--mono"
                      type="password"
                      :placeholder="activeProfile.hasApiKey ? '已保存旧密钥；换新 Key 请粘贴后点保存供应商' : '必填'"
                    />
                  </label>
                </div>

                <div class="ai-supplier-panel__actions">
                  <button
                    type="button"
                    class="app-btn app-btn--primary"
                    data-testid="ai-save-suppliers"
                    :disabled="savingSuppliers"
                    @click="saveSuppliers"
                  >
                    {{ savingSuppliers ? '保存中…' : '保存供应商' }}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div class="ai-production">
            <h3 class="ai-production__title">章节生产分模型</h3>
            <p class="app-hint ai-production__hint">
              每个阶段单独选供应商并拉取模型。模型必须与所选供应商的网关一致；切换供应商后会清空模型，请重新拉取。
            </p>
            <div class="ai-production__grid">
              <div
                v-for="role in (['draft', 'repair', 'audit'] as ProductionRole[])"
                :key="`${role}-${productionProfileId(role)}`"
                class="ai-production__item"
              >
                <span class="ai-production__item-label">{{ productionRoleMeta[role].label }}</span>
                <label class="app-field">
                  <span class="app-field__label">供应商</span>
                  <select
                    class="app-input"
                    :data-testid="`${productionRoleMeta[role].testId}-profile`"
                    :value="productionProfileId(role)"
                    required
                    @change="setProductionProfile(role, ($event.target as HTMLSelectElement).value)"
                  >
                    <option value="" disabled>请选择</option>
                    <option
                      v-for="opt in supplierSelectOptions"
                      :key="`${role}-supplier-${opt.value}`"
                      :value="opt.value"
                    >
                      {{ opt.label }}
                    </option>
                  </select>
                </label>
                <label class="app-field">
                  <span class="app-field__label">模型</span>
                  <AiModelField
                    :key="`${role}-${productionProfileId(role)}-${productionCredentials(role).baseUrl ?? ''}`"
                    :model-value="productionModelValue(role)"
                    :credentials="productionCredentials(role)"
                    :test-id="`${productionRoleMeta[role].testId}-model`"
                    placeholder="拉取或手填"
                    @update:model-value="setProductionModel(role, $event)"
                  />
                </label>
              </div>
            </div>
          </div>

          <div class="ai-panel__actions">
            <button type="button" class="app-btn app-btn--primary" data-testid="ai-save" @click="save">
              保存全部配置
            </button>
            <button type="button" class="app-btn app-btn--secondary" data-testid="ai-test" @click="testConnection">
              测试连接
            </button>
          </div>
        </div>
        <p v-if="testResult" data-testid="ai-test-result" class="app-hint">{{ testResult }}</p>
      </section>

      <section v-if="auth.isAdmin" class="app-panel">
        <div class="app-panel__head">
          <h2>管理员</h2>
          <p class="app-panel__subtitle">生成邀请码供新用户注册</p>
        </div>
        <button type="button" class="app-btn app-btn--primary" data-testid="admin-gen-invite" @click="genInvite">
          生成邀请码（5 次）
        </button>
        <p v-if="newInvite" class="app-hint">
          新邀请码：<code data-testid="admin-invite-code">{{ newInvite }}</code>
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.project-list {
  list-style: none;
  padding: 0;
  margin: 1rem 0 0;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.project-list li {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.85rem 0;
  border-bottom: 1px solid rgba(148, 163, 184, 0.12);
}

.project-list__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.project-list li:last-child {
  border-bottom: none;
}

.project-list strong {
  font-size: 1rem;
}

/* ── AI 配置面板 ── */
.ai-panel {
  padding: 1.35rem 1.25rem;
}

@media (min-width: 900px) {
  .ai-panel {
    padding: 1.5rem 1.65rem;
  }
}

.ai-panel__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}

.ai-panel__badge {
  flex-shrink: 0;
  padding: 0.3rem 0.65rem;
  border-radius: 999px;
  font-size: 0.78rem;
  font-weight: 600;
  color: #bfdbfe;
  background: rgba(59, 130, 246, 0.15);
  border: 1px solid rgba(96, 165, 250, 0.35);
}

.ai-panel__form {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

/* 供应商：左侧列表 + 右侧编辑 */
.ai-suppliers__layout {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1rem;
}

@media (min-width: 720px) {
  .ai-suppliers__layout {
    grid-template-columns: minmax(12rem, 14rem) minmax(0, 1fr);
    gap: 1.15rem;
    align-items: start;
  }
}

@media (min-width: 900px) {
  .ai-suppliers__layout {
    grid-template-columns: minmax(14rem, 16.5rem) minmax(0, 1fr);
    gap: 1.35rem;
  }
}

.ai-suppliers__sidebar {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.ai-suppliers__sidebar-title {
  margin: 0 0 0.25rem;
  font-size: 0.78rem;
  font-weight: 600;
  color: #64748b;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.ai-suppliers__item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.15rem;
  width: 100%;
  padding: 0.55rem 0.7rem;
  border-radius: 10px;
  border: 1px solid rgba(100, 116, 139, 0.28);
  background: rgba(15, 23, 42, 0.45);
  color: #cbd5e1;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.ai-suppliers__item:hover {
  border-color: rgba(148, 163, 184, 0.45);
}

.ai-suppliers__item.is-active {
  border-color: rgba(96, 165, 250, 0.55);
  background: rgba(59, 130, 246, 0.14);
}

.ai-suppliers__item-name {
  font-size: 0.88rem;
  font-weight: 600;
  color: #f1f5f9;
  line-height: 1.3;
}

.ai-suppliers__item-meta {
  font-size: 0.72rem;
  color: #64748b;
  line-height: 1.35;
  word-break: break-all;
}

.ai-suppliers__add {
  margin-top: 0.25rem;
  padding: 0.5rem 0.7rem;
  border-radius: 10px;
  border: 1px dashed rgba(100, 116, 139, 0.45);
  background: transparent;
  color: #94a3b8;
  font: inherit;
  font-size: 0.84rem;
  cursor: pointer;
  text-align: left;
  transition: color 0.15s, border-color 0.15s;
}

.ai-suppliers__add:hover {
  color: #e2e8f0;
  border-color: rgba(96, 165, 250, 0.5);
}

.ai-supplier-panel__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.85rem;
  padding-top: 0.85rem;
  border-top: 1px solid rgba(148, 163, 184, 0.12);
}

.ai-supplier-panel__actions .app-btn {
  width: auto;
  min-width: 7rem;
}

/* 供应商编辑面板 */
.ai-supplier-panel {
  padding: 1.15rem 1.25rem;
  border-radius: 12px;
  border: 1px solid rgba(100, 116, 139, 0.25);
  background: rgba(15, 23, 42, 0.45);
}

@media (min-width: 900px) {
  .ai-supplier-panel {
    padding: 1.35rem 1.5rem;
  }
}

.ai-supplier-panel__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.85rem;
  flex-wrap: wrap;
}

.ai-preset-chips {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.ai-preset-chips__label {
  font-size: 0.78rem;
  color: #64748b;
  margin-right: 0.15rem;
}

.ai-preset-chip {
  padding: 0.28rem 0.65rem;
  border-radius: 999px;
  border: 1px solid rgba(100, 116, 139, 0.4);
  background: rgba(30, 41, 59, 0.6);
  color: #cbd5e1;
  font: inherit;
  font-size: 0.78rem;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
  width: auto;
  min-height: unset;
}

.ai-preset-chip:hover {
  border-color: rgba(148, 163, 184, 0.55);
  color: #f1f5f9;
}

.ai-preset-chip.is-active {
  background: rgba(59, 130, 246, 0.2);
  border-color: rgba(96, 165, 250, 0.6);
  color: #bfdbfe;
}

.ai-supplier-panel__delete {
  padding: 0.28rem 0.6rem;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #f87171;
  font: inherit;
  font-size: 0.78rem;
  cursor: pointer;
  opacity: 0.75;
  transition: opacity 0.15s;
}

.ai-supplier-panel__delete:hover {
  opacity: 1;
}

.ai-supplier-panel__grid {
  gap: 0.9rem;
}

@media (min-width: 900px) {
  .ai-supplier-panel__grid {
    gap: 1rem;
  }
}

/* 章节生产分模型 */
.ai-production {
  padding-top: 0.5rem;
  border-top: 1px solid rgba(148, 163, 184, 0.12);
}

.ai-production__title {
  margin: 0 0 0.25rem;
  font-size: 0.95rem;
}

.ai-production__hint {
  margin: 0 0 0.85rem;
  font-size: 0.82rem;
}

.ai-production__grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0.85rem;
}

@media (min-width: 860px) {
  .ai-production__grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1rem;
  }
}

.ai-production__item {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  padding: 0.95rem 1rem;
  border-radius: 10px;
  border: 1px solid rgba(100, 116, 139, 0.2);
  background: rgba(15, 23, 42, 0.35);
}

.ai-production__item-label {
  font-size: 0.82rem;
  font-weight: 600;
  color: #e2e8f0;
  line-height: 1.35;
}

.ai-panel__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  padding-top: 0.5rem;
}

.ai-panel__actions .app-btn {
  width: auto;
  min-width: 7rem;
}
</style>
