import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createInviteCode, listInviteCodes } from '../services/invite.js'
import type { JwtUserPayload } from '../config.js'

const createSchema = z.object({
  maxUses: z.number().int().positive().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  note: z.string().optional(),
})

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/character-arc/v1/admin/invite-codes',
    { preHandler: [app.authenticate, app.requireAdmin] },
    async (request, reply) => {
      const parsed = createSchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        return reply.status(400).send({ code: 'validation_error', message: parsed.error.message })
      }

      const user = request.user as JwtUserPayload
      const created = await createInviteCode({
        createdBy: user.sub,
        maxUses: parsed.data.maxUses,
        expiresAt: parsed.data.expiresAt ?? null,
        note: parsed.data.note,
      })
      return created
    },
  )

  app.get(
    '/api/character-arc/v1/admin/invite-codes',
    { preHandler: [app.authenticate, app.requireAdmin] },
    async () => listInviteCodes(),
  )
}

declare module 'fastify' {
  interface FastifyInstance {
    requireAdmin: (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>
  }
}
