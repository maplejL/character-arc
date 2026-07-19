#!/usr/bin/env node
/**
 * Test CPA profile on prod: models list + chat for composer-2.5-fast
 * Usage (on server): cd /opt/character-arc/server && npx tsx scripts/prod-test-cpa.ts
 */
import { config as loadEnv } from 'dotenv'
import { resolve } from 'node:path'

loadEnv({ path: resolve(process.cwd(), '.env') })

const API = `http://127.0.0.1:${process.env.PORT ?? 8010}`
const MODEL_CANDIDATES = ['grok-composer-2.5-fast', 'composer-2.5-fast', 'composer-2.5']

async function login(): Promise<string> {
  const res = await fetch(`${API}/api/character-arc/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@characterarc.local', password: '123456' }),
  })
  const data = (await res.json()) as { accessToken?: string }
  if (!data.accessToken) throw new Error('login failed')
  return data.accessToken
}

async function testChat(baseUrl: string, apiKey: string, model: string) {
  const root = baseUrl.replace(/\/v1\/chat\/completions\/?$/i, '').replace(/\/+$/, '')
  const url = `${root}/chat/completions`
  const start = Date.now()
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      max_tokens: 16,
    }),
    signal: AbortSignal.timeout(90_000),
  })
  const text = await res.text()
  let data: { choices?: Array<{ message?: { content?: string } }> } = {}
  try {
    data = JSON.parse(text) as typeof data
  } catch {
    /* ignore */
  }
  const content = data.choices?.[0]?.message?.content ?? ''
  return {
    ok: res.ok,
    status: res.status,
    latencyMs: Date.now() - start,
    content: String(content).slice(0, 120),
    error: res.ok ? '' : text.slice(0, 400),
  }
}

async function main(): Promise<void> {
  const { initDb } = await import('../src/db/pool.js')
  const { decryptSecret } = await import('../src/lib/crypto.js')
  const { getUserProductionAiRow, listStoredProfiles } = await import('../src/services/ai-production-config.js')

  await initDb()

  const token = await login()
  const cfg = await fetch(`${API}/api/character-arc/v1/users/me/ai-config`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then((r) => r.json()) as {
    aiProfiles: Array<{ id: string; name: string; baseUrl: string; model: string; provider: string; hasApiKey: boolean }>
    chapterProductionModels?: { auditModel?: string }
  }

  const cpa = cfg.aiProfiles.find(
    (p) => /cpa/i.test(p.baseUrl) || /124\.222\.218\.97/.test(p.baseUrl),
  )
  if (!cpa) {
    console.error('No CPA profile. Profiles:', cfg.aiProfiles)
    process.exit(1)
  }

  console.log('CPA profile:', cpa)
  console.log('Audit binding:', cfg.chapterProductionModels?.auditModel)

  const modelsRes = await fetch(`${API}/api/character-arc/v1/users/me/ai-config/models`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      profileId: cpa.id,
      provider: cpa.provider,
      baseUrl: cpa.baseUrl,
    }),
  })
  const modelsBody = await modelsRes.json() as {
    result?: Array<{ id: string }>
    meta?: { baseUrl?: string }
    message?: string
  }
  const ids = (modelsBody.result ?? []).map((m) => m.id)
  const composerIds = ids.filter((id) => /composer/i.test(id))
  console.log('\n[models] status', modelsRes.status, 'meta', modelsBody.meta)
  console.log('[models] composer ids:', composerIds.length ? composerIds : ids.slice(0, 15))

  const me = await fetch(`${API}/api/character-arc/v1/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then((r) => r.json()) as { id: string }
  const userId = me.id
  if (!userId) throw new Error('admin user not found')

  const row = await getUserProductionAiRow(userId)
  const stored = listStoredProfiles(row)
  const storedCpa = stored.find((p) => p.id === cpa.id)
  const apiKey = storedCpa?.apiKeyEnc ? decryptSecret(storedCpa.apiKeyEnc) : ''
  if (!apiKey) {
    console.error('CPA profile has no decryptable API key')
    process.exit(1)
  }

  const preferred = cfg.chapterProductionModels?.auditModel || cpa.model
  const candidates = [...new Set([preferred, ...composerIds, ...MODEL_CANDIDATES].filter(Boolean))]

  for (const model of candidates) {
    if (!/composer/i.test(model) && model !== preferred) continue
    console.log(`\n[chat] ${model}`)
    const result = await testChat(cpa.baseUrl, apiKey, model)
    console.log(result)
    if (result.ok) {
      console.log(`\n✅ CPA OK — model: ${model}, latency: ${result.latencyMs}ms, reply: ${result.content}`)
      process.exit(0)
    }
  }

  console.error('\n❌ CPA composer model test failed')
  process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
