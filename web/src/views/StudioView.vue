<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { createApp, type App as VueApp } from 'vue'
import { createPinia } from 'pinia'
import '../../../renderer/src/styles/global.css'

const route = useRoute()
const router = useRouter()
const host = ref<HTMLElement | null>(null)
const loadError = ref<string | null>(null)
const loading = ref(true)

let mountedApp: VueApp | null = null

onMounted(async () => {
  const projectId = String(route.params.projectId ?? '').trim()
  if (!projectId) {
    await router.replace('/')
    return
  }

  try {
    const [{ default: RendererApp }, { useAppStore }] = await Promise.all([
      import('@/App.vue'),
      import('@/stores/app'),
    ])

    const pinia = createPinia()
    mountedApp = createApp(RendererApp).use(pinia)

    const store = useAppStore(pinia)
    await store.initialize()

    if (!store.projects.some((project) => project.id === projectId)) {
      loadError.value = '作品不存在或无权访问'
      loading.value = false
      return
    }

    store.openProject(projectId)

    const wantBackfill = String(route.query.backfill ?? '') === '1'
    if (wantBackfill && typeof window.characterArc?.backfillProjectState === 'function') {
      void window.characterArc
        .backfillProjectState({
          projectId,
          settings: store.appSettings,
        })
        .catch(() => {
          /* 补录失败不阻塞进入写作台；可在项目知识库重试 */
        })
    }

    const wantReverse = String(route.query.reverseExtract ?? '') === '1'
    if (wantReverse && typeof window.characterArc?.reverseExtractContinuation === 'function') {
      void window.characterArc
        .reverseExtractContinuation({
          projectId,
          rebuildImportedOutline: true,
        })
        .then(async (response) => {
          if (response?.success) {
            await store.initialize()
            store.openProject(projectId)
          }
        })
        .catch(() => {
          /* 反推失败不阻塞写作台；可在续写横幅重试 */
        })
    }

    if (host.value) {
      mountedApp.mount(host.value)
    }
    loading.value = false
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : '写作台加载失败'
    loading.value = false
  }
})

onBeforeUnmount(() => {
  mountedApp?.unmount()
  mountedApp = null
})

function backHome(): void {
  void router.push('/')
}
</script>

<template>
  <div class="studio-shell" data-testid="studio-root">
    <div v-if="loading" class="studio-shell__loading">正在载入写作台…</div>
    <div v-else-if="loadError" class="studio-shell__error">
      <p>{{ loadError }}</p>
      <button type="button" class="studio-shell__back" data-testid="studio-back-home" @click="backHome">
        返回工作台
      </button>
    </div>
    <div ref="host" class="studio-shell__host" />
  </div>
</template>

<style scoped>
.studio-shell {
  min-height: calc(100vh - 0px);
  display: flex;
  flex-direction: column;
}

.studio-shell__host {
  flex: 1;
  min-height: 0;
}

.studio-shell__loading,
.studio-shell__error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  min-height: 40vh;
  color: #94a3b8;
}

.studio-shell__back {
  padding: 0.5rem 1rem;
  border-radius: 8px;
  border: 1px solid rgba(148, 163, 184, 0.3);
  background: transparent;
  color: inherit;
  cursor: pointer;
}
</style>
