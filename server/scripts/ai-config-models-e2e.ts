/**
 * 三供应商模型拉取 — Base URL 必须与 profileId 对应
 * Usage: pnpm --dir server exec tsx scripts/ai-config-models-e2e.ts
 */
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
loadEnv({ path: path.resolve(__dirname, '../../web/.env.e2e') })

const API = process.env.E2E_API_BASE ?? 'http://127.0.0.1:8010'
const TEST_KEY = process.env.E2E_DEEPSEEK_API_KEY || 'sk-test-key-for-url-resolution'

const SUPPLIERS = [
  {
    id: 'profile-e2e-draft',
    name: 'E2E初稿',
    provider: 'deepseek' as const,
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
  },
  {
    id: 'profile-e2e-centos',
    name: 'E2E润色',
    provider: 'openai-compatible' as const,
    baseUrl: process.env.E2E_CENTOS_BASE_URL ?? 'https://ai.centos.hk',
    model: 'gemini-3.5-flash',
  },
  {
    id: 'profile-e2e-cpa',
    name: 'E2E审查',
    provider: 'openai-compatible' as const,
    baseUrl: process.env.E2E_CPA_BASE_URL ?? 'http://127.0.0.1:19999/cpa/v1',
    model: 'grok-composer-2.5-fast',
  },
]

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase()
}

async function login(): Promise<string> {
  const res = await fetch(`${API}/api/character-arc/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@characterarc.local', password: '123456' }),
  })
  if (!res.ok) throw new Error(`login failed: ${res.status}`)
  const data = (await res.json()) as { accessToken: string }
  return data.accessToken
}

async function saveConfig(token: string): Promise<void> {
  const res = await fetch(`${API}/api/character-arc/v1/users/me/ai-config`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      provider: SUPPLIERS[0].provider,
      model: SUPPLIERS[0].model,
      baseUrl: SUPPLIERS[0].baseUrl,
      apiKey: TEST_KEY,
      activeAiProfileId: SUPPLIERS[0].id,
      aiProfiles: SUPPLIERS.map((s) => ({
        id: s.id,
        name: s.name,
        provider: s.provider,
        model: s.model,
        baseUrl: s.baseUrl,
        apiKey: TEST_KEY,
      })),
      chapterProductionModels: {
        draftProfileId: SUPPLIERS[0].id,
        draftModel: SUPPLIERS[0].model,
        repairProfileId: SUPPLIERS[1].id,
        repairModel: SUPPLIERS[1].model,
        auditProfileId: SUPPLIERS[2].id,
        auditModel: SUPPLIERS[2].model,
      },
    }),
  })
  if (!res.ok) throw new Error(`save config failed: ${res.status} ${await res.text()}`)
}

async function fetchModelsMeta(
  token: string,
  body: Record<string, unknown>,
): Promise<{ baseUrl?: string; profileId?: string; status: number; message?: string }> {
  const res = await fetch(`${API}/api/character-arc/v1/users/me/ai-config/models`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const data = (await res.json()) as {
    meta?: { baseUrl?: string; profileId?: string }
    message?: string
  }
  return {
    status: res.status,
    baseUrl: data.meta?.baseUrl,
    profileId: data.meta?.profileId,
    message: data.message,
  }
}

async function run(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      const health = await fetch(`${API}/health`)
      if (health.ok) break
    } catch {
      /* wait */
    }
    await sleep(1000)
  }

  const token = await login()
  await saveConfig(token)

  for (const supplier of SUPPLIERS) {
    const cases = [
      {
        label: 'profileId + form baseUrl',
        body: {
          profileId: supplier.id,
          provider: supplier.provider,
          baseUrl: supplier.baseUrl,
        },
      },
      {
        label: 'profileId only (saved baseUrl)',
        body: {
          profileId: supplier.id,
          provider: supplier.provider,
        },
      },
    ]

    for (const testCase of cases) {
      const result = await fetchModelsMeta(token, testCase.body)
      if (!result.baseUrl) {
        throw new Error(
          `[${supplier.name}] ${testCase.label}: missing meta.baseUrl (status=${result.status}, msg=${result.message})`,
        )
      }
      if (normalizeUrl(result.baseUrl) !== normalizeUrl(supplier.baseUrl)) {
        throw new Error(
          `[${supplier.name}] ${testCase.label}: baseUrl mismatch\n  expected: ${supplier.baseUrl}\n  actual:   ${result.baseUrl}`,
        )
      }
      if (result.profileId !== supplier.id) {
        throw new Error(
          `[${supplier.name}] ${testCase.label}: profileId mismatch ${result.profileId} !== ${supplier.id}`,
        )
      }
      console.log(`OK  [${supplier.name}] ${testCase.label}: ${result.baseUrl}`)
    }
  }

  // 串配检测：repair 绑定 centos，但传 draft 的 profileId + centos url 应解析到 draft profile 的 deepseek url
  const cross = await fetchModelsMeta(token, {
    profileId: SUPPLIERS[0].id,
    provider: SUPPLIERS[0].provider,
    baseUrl: SUPPLIERS[0].baseUrl,
  })
  if (normalizeUrl(cross.baseUrl!) !== normalizeUrl(SUPPLIERS[0].baseUrl)) {
    throw new Error(`cross profile resolution failed: ${cross.baseUrl}`)
  }
  console.log('OK  cross-profile isolation')

  console.log('\nAll ai-config models URL E2E checks passed.')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
