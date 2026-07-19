<script setup lang="ts">
import { computed } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import { useAuthStore } from './stores/auth'

const auth = useAuthStore()
const route = useRoute()
const isAuthPage = computed(() => Boolean(route.meta.authPage))
const isStudio = computed(() => Boolean(route.meta.studio))
</script>

<template>
  <div
    class="shell"
    :class="{
      'shell--auth': isAuthPage,
      'shell--app': auth.isLoggedIn && !isAuthPage && !isStudio,
      'shell--studio': isStudio,
    }"
  >
    <header v-if="auth.isLoggedIn && !isAuthPage && !isStudio" class="app-topbar">
      <div class="app-topbar__brand">
        <div class="auth-brand__mark app-topbar__mark" aria-hidden="true">CA</div>
        <div class="app-topbar__titles">
          <strong>CharacterArc</strong>
          <span class="app-topbar__tag">Web 写作台</span>
        </div>
      </div>
      <span class="app-topbar__email muted">{{ auth.user?.email }}</span>
      <button type="button" class="app-topbar__logout" @click="auth.logout()">退出</button>
    </header>
    <main
      class="main"
      :class="{
        'main--auth': isAuthPage,
        'main--app': auth.isLoggedIn && !isAuthPage && !isStudio,
        'main--studio': isStudio,
      }"
    >
      <RouterView />
    </main>
  </div>
</template>
