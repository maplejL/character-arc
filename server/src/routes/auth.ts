import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { query } from '../db/pool.js'
import { hashPassword, verifyPassword } from '../lib/password.js'
import { toUserRead } from '../lib/auth.js'
import { InviteError, redeemInviteCode } from '../services/invite.js'
import type { JwtUserPayload, UserRole } from '../config.js'

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  inviteCode: z.string().min(1),
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

function signTokens(app: FastifyInstance, user: { id: string; email: string; role: UserRole }) {
  const accessToken = app.jwt.sign(
    { sub: user.id, email: user.email, role: user.role } satisfies JwtUserPayload,
    { expiresIn: app.config.jwtAccessExpires },
  )
  const refreshToken = app.jwt.sign(
    { sub: user.id, email: user.email, role: user.role, type: 'refresh' } satisfies JwtUserPayload,
    { expiresIn: app.config.jwtRefreshExpires },
  )
  return { accessToken, refreshToken }
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/character-arc/v1/auth/register', async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ code: 'validation_error', message: parsed.error.message })
    }

    const { email, password, inviteCode } = parsed.data
    const { rows: taken } = await query('SELECT id FROM users WHERE email = $1', [email])
    if (taken.length > 0) {
      return reply.status(409).send({ code: 'email_taken', message: '邮箱已注册' })
    }

    const hash = await hashPassword(password)
    const client = await query<{ id: string; email: string; role: UserRole; created_at: Date }>(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, 'USER')
       RETURNING id, email, role, created_at`,
      [email, hash],
    )
    const user = client.rows[0]!

    try {
      await redeemInviteCode(inviteCode, user.id)
    } catch (err) {
      await query('DELETE FROM users WHERE id = $1', [user.id])
      if (err instanceof InviteError) {
        return reply.status(403).send({ code: err.code, message: err.message })
      }
      throw err
    }

    const tokens = signTokens(app, user)
    return {
      ...tokens,
      user: toUserRead(user),
    }
  })

  app.post('/api/character-arc/v1/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ code: 'validation_error', message: parsed.error.message })
    }

    const { email, password } = parsed.data
    const { rows } = await query<{
      id: string
      email: string
      role: UserRole
      password_hash: string
      created_at: Date
    }>('SELECT id, email, role, password_hash, created_at FROM users WHERE email = $1', [email])

    const user = rows[0]
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return reply.status(401).send({ code: 'invalid_credentials', message: '邮箱或密码错误' })
    }

    const tokens = signTokens(app, user)
    return {
      ...tokens,
      user: toUserRead(user),
    }
  })

  app.post('/api/character-arc/v1/auth/refresh', async (request, reply) => {
    const body = request.body as { refreshToken?: string }
    if (!body?.refreshToken) {
      return reply.status(400).send({ code: 'validation_error', message: '缺少 refreshToken' })
    }

    try {
      const payload = app.jwt.verify<JwtUserPayload>(body.refreshToken)
      if (payload.type !== 'refresh') {
        return reply.status(401).send({ code: 'token_invalid', message: '无效的 refresh token' })
      }
      const tokens = signTokens(app, { id: payload.sub, email: payload.email, role: payload.role })
      return tokens
    } catch {
      return reply.status(401).send({ code: 'token_invalid', message: '无效的 refresh token' })
    }
  })

  app.get(
    '/api/character-arc/v1/auth/me',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const jwtUser = request.user as JwtUserPayload
      const { rows } = await query<{
        id: string
        email: string
        role: UserRole
        created_at: Date
      }>('SELECT id, email, role, created_at FROM users WHERE id = $1', [jwtUser.sub])

      const user = rows[0]
      if (!user) {
        return reply.status(401).send({ code: 'unauthorized', message: '用户不存在' })
      }
      return toUserRead(user)
    },
  )
}

declare module 'fastify' {
  interface FastifyInstance {
    config: {
      jwtAccessExpires: string
      jwtRefreshExpires: string
    }
  }
}
