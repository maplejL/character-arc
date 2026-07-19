import { randomUUID } from 'node:crypto'
import { query } from '../db/pool.js'

export class InviteError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

export async function redeemInviteCode(code: string, userId: string): Promise<void> {
  const { rows } = await query<{
    code: string
    max_uses: number
    used_count: number
    expires_at: Date | null
  }>('SELECT code, max_uses, used_count, expires_at FROM invite_codes WHERE code = $1', [code])

  const row = rows[0]
  if (!row) throw new InviteError('invite_invalid', '邀请码无效')

  if (row.expires_at && row.expires_at.getTime() < Date.now()) {
    throw new InviteError('invite_expired', '邀请码已过期')
  }
  if (row.used_count >= row.max_uses) {
    throw new InviteError('invite_exhausted', '邀请码已达使用上限')
  }

  await query(
    `UPDATE invite_codes SET used_count = used_count + 1 WHERE code = $1`,
    [code],
  )
  await query(
    `INSERT INTO invite_code_redemptions (code, user_id) VALUES ($1, $2)`,
    [code, userId],
  )
}

export async function createInviteCode(input: {
  createdBy: string
  maxUses?: number
  expiresAt?: string | null
  note?: string
}): Promise<{ code: string; maxUses: number; expiresAt: string | null }> {
  const code = `CA-${randomUUID().slice(0, 8).toUpperCase()}`
  const maxUses = input.maxUses ?? 1
  await query(
    `INSERT INTO invite_codes (code, created_by, max_uses, expires_at, note)
     VALUES ($1, $2, $3, $4, $5)`,
    [code, input.createdBy, maxUses, input.expiresAt ?? null, input.note ?? ''],
  )
  return { code, maxUses, expiresAt: input.expiresAt ?? null }
}

export async function listInviteCodes(): Promise<
  Array<{
    code: string
    maxUses: number
    usedCount: number
    expiresAt: string | null
    note: string
    createdAt: string
  }>
> {
  const { rows } = await query<{
    code: string
    max_uses: number
    used_count: number
    expires_at: Date | null
    note: string
    created_at: Date
  }>(
    `SELECT code, max_uses, used_count, expires_at, note, created_at
     FROM invite_codes ORDER BY created_at DESC`,
  )
  return rows.map((r: {
    code: string
    max_uses: number
    used_count: number
    expires_at: Date | null
    note: string
    created_at: Date
  }) => ({
    code: r.code,
    maxUses: r.max_uses,
    usedCount: r.used_count,
    expiresAt: r.expires_at?.toISOString() ?? null,
    note: r.note,
    createdAt: r.created_at.toISOString(),
  }))
}
