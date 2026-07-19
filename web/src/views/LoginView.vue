<script setup lang="ts">
import { ref } from 'vue'
import { RouterLink } from 'vue-router'
import AuthShell from '../components/AuthShell.vue'
import { useAuthStore } from '../stores/auth'
import { DEFAULT_LOGIN_EMAIL, DEFAULT_LOGIN_PASSWORD } from '../lib/defaults'

const auth = useAuthStore()
const email = ref(DEFAULT_LOGIN_EMAIL)
const password = ref(DEFAULT_LOGIN_PASSWORD)

async function submit() {
  await auth.login(email.value, password.value)
  window.location.href = '/character-arc/'
}
</script>

<template>
  <AuthShell title="欢迎回来" subtitle="登录你的 CharacterArc 账号">
    <form class="auth-form" @submit.prevent="submit">
      <label class="auth-field">
        <span class="auth-field__label">邮箱</span>
        <input
          v-model="email"
          data-testid="login-email"
          class="auth-input"
          type="email"
          inputmode="email"
          autocomplete="username"
          placeholder="you@example.com"
          required
        />
      </label>
      <label class="auth-field">
        <span class="auth-field__label">密码</span>
        <input
          v-model="password"
          data-testid="login-password"
          class="auth-input"
          type="password"
          autocomplete="current-password"
          placeholder="输入密码"
          required
        />
      </label>

      <p v-if="auth.error" class="auth-error" role="alert">{{ auth.error }}</p>

      <button type="submit" class="auth-submit" data-testid="login-submit" :disabled="auth.loading">
        {{ auth.loading ? '登录中…' : '登录' }}
      </button>
    </form>

    <p class="auth-footer">
      没有账号？
      <RouterLink to="/register">邀请码注册</RouterLink>
    </p>
  </AuthShell>
</template>
