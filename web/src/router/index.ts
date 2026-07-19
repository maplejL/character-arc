import { createRouter, createWebHistory } from 'vue-router'
import { clearTokens } from '../lib/api'
import { useAuthStore } from '../stores/auth'

const router = createRouter({
  history: createWebHistory('/character-arc/'),
  routes: [
    { path: '/login', component: () => import('../views/LoginView.vue'), meta: { guest: true, authPage: true } },
    { path: '/register', component: () => import('../views/RegisterView.vue'), meta: { guest: true, authPage: true } },
    { path: '/', component: () => import('../views/HomeView.vue'), meta: { auth: true } },
    {
      path: '/continuation',
      component: () => import('../views/ContinuationWizardView.vue'),
      meta: { auth: true },
    },
    {
      path: '/studio/:projectId',
      component: () => import('../views/StudioView.vue'),
      meta: { auth: true, studio: true },
    },
    { path: '/:pathMatch(.*)*', redirect: '/login' },
  ],
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()

  if (to.meta.auth && !auth.isLoggedIn) {
    return { path: '/login', query: { redirect: to.fullPath } }
  }

  if (to.meta.guest && auth.isLoggedIn) {
    if (!auth.user) {
      try {
        await auth.fetchMe()
      } catch (e) {
        // 仅会话真正失效时清 token；网络错误仍视为已登录并进首页
        if (e instanceof Error && e.message === 'session_expired') {
          clearTokens()
          auth.user = null
          return true
        }
      }
    }
    return { path: '/' }
  }

  if (to.meta.auth && auth.isLoggedIn && !auth.user) {
    try {
      await auth.fetchMe()
    } catch (e) {
      if (e instanceof Error && e.message === 'session_expired') {
        clearTokens()
        auth.user = null
        return { path: '/login', query: { redirect: to.fullPath } }
      }
      // 网络 / 服务暂时不可用：放行，页面内再拉数据
      // 避免「刚登录一刷新就回登录」
    }
  }

  return true
})

export default router
