<script setup lang="ts">
defineProps<{
  title: string
  subtitle: string
}>()
</script>

<template>
  <div class="auth-page">
    <div class="auth-page__glow auth-page__glow--a" aria-hidden="true" />
    <div class="auth-page__glow auth-page__glow--b" aria-hidden="true" />

    <div class="auth-page__inner">
      <header class="auth-brand">
        <div class="auth-brand__mark" aria-hidden="true">CA</div>
        <div class="auth-brand__text">
          <span class="auth-brand__name">CharacterArc</span>
          <span class="auth-brand__tag">Web 写作台</span>
        </div>
      </header>

      <section class="auth-card">
        <div class="auth-card__head">
          <h1>{{ title }}</h1>
          <p class="auth-card__subtitle">{{ subtitle }}</p>
        </div>
        <slot />
      </section>

      <p class="auth-page__note">邀请制 · 数据私有 · BYOK</p>
    </div>
  </div>
</template>
