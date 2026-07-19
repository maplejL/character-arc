import { config } from '../config.js'
import { query } from '../db/pool.js'
import { hashPassword } from '../lib/password.js'
import { encryptSecret } from '../lib/crypto.js'
import { getUserAiConfig, upsertUserAiConfig } from '../services/ai-config.js'

export async function seedDevData(): Promise<void> {
  const { rows: existing } = await query<{ id: string }>(
    'SELECT id FROM users WHERE email = $1',
    [config.seedAdminEmail],
  )

  let adminId = existing[0]?.id
  const hash = await hashPassword(config.seedAdminPassword)
  if (!adminId) {
    const inserted = await query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, 'ADMIN')
       RETURNING id`,
      [config.seedAdminEmail, hash],
    )
    adminId = inserted.rows[0]!.id
    console.log(`[seed] admin user ${config.seedAdminEmail}`)
  } else {
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, adminId])
    console.log(`[seed] admin password synced for ${config.seedAdminEmail}`)
  }

  const { rows: codes } = await query(
    'SELECT code FROM invite_codes WHERE code = $1',
    [config.seedInviteCode],
  )
  if (codes.length === 0) {
    await query(
      `INSERT INTO invite_codes (code, created_by, max_uses, note)
       VALUES ($1, $2, 100, 'P0 seed invite')`,
      [config.seedInviteCode, adminId],
    )
    console.log(`[seed] invite code ${config.seedInviteCode}`)
  }

  if (config.seedAdminAiApiKey) {
    const existing = await getUserAiConfig(adminId)
    if (!existing?.api_key_enc) {
      await upsertUserAiConfig(adminId, {
        provider: config.seedAdminAiProvider,
        model: config.seedAdminAiModel,
        baseUrl: config.seedAdminAiBaseUrl,
        apiKeyEnc: encryptSecret(config.seedAdminAiApiKey),
      })
      console.log(`[seed] admin AI config (${config.seedAdminAiProvider} / ${config.seedAdminAiModel})`)
    }
  }
}
