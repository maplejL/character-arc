<script setup lang="ts">
import { computed, watch } from 'vue'
import { useAiModelPicker, type AiModelCredential } from '../composables/useAiModelPicker'

const props = defineProps<{
  modelValue: string
  credentials: AiModelCredential
  testId?: string
  placeholder?: string
  required?: boolean
}>()

const usingSavedKey = computed(
  () => Boolean(props.credentials.hasSavedApiKey && !props.credentials.apiKey?.trim()),
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const { models, loading, error, fetched, lastMeta, reset, fetchModels } = useAiModelPicker()

const canFetch = computed(
  () =>
    Boolean(props.credentials.baseUrl?.trim())
    && Boolean(props.credentials.apiKey?.trim() || props.credentials.hasSavedApiKey || props.credentials.profileId),
)

const showSelect = computed(() => fetched.value && models.value.length > 0)

const hint = computed(() => {
  if (loading.value) return '正在拉取模型列表…'
  if (error.value) return error.value
  const resolved = lastMeta.value?.baseUrl?.trim()
  if (fetched.value && models.value.length > 0) {
    return resolved
      ? `共 ${models.value.length} 个模型 · 拉取自 ${resolved}`
      : `共 ${models.value.length} 个可用模型`
  }
  if (usingSavedKey.value) {
    const target = props.credentials.baseUrl?.trim()
    return target
      ? `将用已保存密钥从 ${target} 拉取；换 Key 请先粘贴并保存供应商`
      : '将用已保存的密钥拉取；若网关已换 Key，请先粘贴新 Key 并保存供应商'
  }
  const target = props.credentials.baseUrl?.trim()
  if (target) return `将从 ${target} 拉取；失败时可手动输入`
  return '填写 Base URL 与 Key 后点击拉取；失败时可手动输入'
})

watch(
  () => [
    props.credentials.provider,
    props.credentials.baseUrl,
    props.credentials.profileId,
  ],
  () => {
    reset()
  },
)

async function handleFetch(): Promise<void> {
  const list = await fetchModels(props.credentials)
  if (list.length > 0 && props.modelValue && !list.some((m) => m.id === props.modelValue)) {
    emit('update:modelValue', list[0]?.id ?? '')
  }
}
</script>

<template>
  <div class="ai-model-field">
    <div class="ai-model-field__row">
      <select
        v-if="showSelect"
        :value="modelValue"
        class="app-input ai-model-field__input"
        :data-testid="testId"
        :required="required"
        @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
      >
        <option v-if="!modelValue" value="" disabled>选择模型</option>
        <option v-for="m in models" :key="m.id" :value="m.id">{{ m.id }}</option>
        <option v-if="modelValue && !models.some((m) => m.id === modelValue)" :value="modelValue">
          {{ modelValue }}（当前）
        </option>
      </select>
      <input
        v-else
        :value="modelValue"
        class="app-input ai-model-field__input"
        :data-testid="testId"
        :placeholder="placeholder || '模型名称'"
        :required="required"
        @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      />
      <button
        type="button"
        class="app-btn app-btn--secondary app-btn--compact ai-model-field__fetch"
        :disabled="loading || !canFetch"
        :data-testid="testId ? `${testId}-fetch` : undefined"
        @click="handleFetch"
      >
        {{ loading ? '…' : fetched ? '刷新' : '拉取' }}
      </button>
    </div>
    <p class="app-hint ai-model-field__hint">{{ hint }}</p>
  </div>
</template>

<style scoped>
.ai-model-field {
  width: 100%;
  min-width: 0;
}

.ai-model-field__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.5rem;
  align-items: center;
}

.ai-model-field__input {
  width: 100%;
  min-width: 0;
}

.ai-model-field__fetch {
  white-space: nowrap;
  padding-inline: 0.75rem;
}

.ai-model-field__hint {
  margin: 0.35rem 0 0;
  font-size: 0.8rem;
}
</style>
