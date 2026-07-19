#!/usr/bin/env node
/** Dump production model bindings with masked keys */
import { config as loadEnv } from 'dotenv'
import { resolve } from 'node:path'

loadEnv({ path: resolve(process.cwd(), '.env') })

const API = `http://127.0.0.1:${process.env.PORT ?? 8010}`

function maskKey(key) {
  if (!key) return '(无)'
  if (key.length <= 8) return '****'
  return `${key.slice(0, 7)}…${key.slice(-4)} (${key.length} chars)`
}

async function main() {
  const { initDb } = await import('../src/db/pool.js')
  const { decryptSecret } = await import('../src/lib/crypto.js')
  const { getUserProductionAiRow, listStoredProfiles } = await import('../src/services/ai-production-config.js')

  await initDb()

  const login = await fetch(`${API}/api/character-arc/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@characterarc.local', password: '123456' }),
  }).then((r) => r.json())

  const cfg = await fetch(`${API}/api/character-arc/v1/users/me/ai-config`, {
    headers: { Authorization: `Bearer ${login.accessToken}` },
  }).then((r) => r.json())

  const me = await fetch(`${API}/api/character-arc/v1/auth/me`, {
    headers: { Authorization: `Bearer ${login.accessToken}` },
  }).then((r) => r.json())

  const row = await getUserProductionAiRow(me.id)
  const stored = listStoredProfiles(row)
  const prod = cfg.chapterProductionModels ?? {}

  const roles = [
    { role: '初稿 draft', profileId: prod.draftProfileId, model: prod.draftModel },
    { role: '修复 repair', profileId: prod.repairProfileId, model: prod.repairModel },
    { role: '审查 audit', profileId: prod.auditProfileId, model: prod.auditModel },
  ]

  const globalKey = row?.api_key_enc ? decryptSecret(row.api_key_enc) : ''

  console.log(JSON.stringify({
    globalActive: {
      provider: cfg.provider,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      key: maskKey(globalKey),
    },
    bindings: roles.map(({ role, profileId, model }) => {
      const pub = cfg.aiProfiles?.find((p) => p.id === profileId)
      const sec = stored.find((p) => p.id === profileId)
      const key = sec?.apiKeyEnc ? decryptSecret(sec.apiKeyEnc) : ''
      return {
        role,
        profileId,
        supplierName: pub?.name ?? '(未找到)',
        provider: pub?.provider,
        baseUrl: pub?.baseUrl,
        boundModel: model,
        supplierDefaultModel: pub?.model,
        key: maskKey(key),
        keyFull: key,
      }
    }),
    allSuppliers: cfg.aiProfiles?.map((p) => {
      const sec = stored.find((s) => s.id === p.id)
      const key = sec?.apiKeyEnc ? decryptSecret(sec.apiKeyEnc) : ''
      return {
        id: p.id,
        name: p.name,
        provider: p.provider,
        baseUrl: p.baseUrl,
        model: p.model,
        key: maskKey(key),
        keyFull: key,
      }
    }),
  }, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
