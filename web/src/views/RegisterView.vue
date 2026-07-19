<script setup lang="ts">
import { ref } from 'vue'
import { RouterLink } from 'vue-router'
import AuthShell from '../components/AuthShell.vue'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const email = ref('')
const password = ref('')
const inviteCode = ref('CHARARC-BETA')

async function submit() {
  await auth.register(email.value, password.value, inviteCode.value)
  window.location.href = '/character-arc/'
}
</script>

<template>
  <AuthShell title="创建账号" subtitle="需要有效邀请码才能注册">
    <form class="auth-form" @submit.prevent="submit">
      <label class="auth-field">
        <span class="auth-field__label">邀请码</span>
        <input
          v-model="inviteCode"
          data-testid="register-invite"
          class="auth-input auth-input--mono"
          autocomplete="off"
          placeholder="CHARARC-XXXX"
          required
        />
      </label>
      <label class="auth-field">
        <span class="auth-field__label">邮箱</span>
        <input
          v-model="email"
          data-testid="register-email"
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
          data-testid="register-password"
          class="auth-input"
          type="password"
          minlength="8"
          autocomplete="new-password"
          placeholder="至少 8 位"
          required
        />
      </label>

      <p v-if="auth.error" data-testid="register-error" class="auth-error" role="alert">{{ auth.error }}</p>

      <button type="submit" class="auth-submit" data-testid="register-submit" :disabled="auth.loading">
        {{ auth.loading ? '注册中…' : '注册并登录' }}
      </button>
    </form>

    <p class="auth-footer">
      已有账号？
      <RouterLink to="/login">返回登录</RouterLink>
    </p>
  </AuthShell>
</template>
