import type { FastifyReply, FastifyRequest } from 'fastify'
import type { JwtUserPayload, UserRole } from '../config.js'

export function requireAuth(request: FastifyRequest, reply: FastifyReply): JwtUserPayload | null {
  try {
    return request.user as JwtUserPayload
  } catch {
    reply.status(401).send({ code: 'unauthorized', message: '未登录或 token 无效' })
    return null
  }
}

export function requireAdmin(request: FastifyRequest, reply: FastifyReply): JwtUserPayload | null {
  const user = requireAuth(request, reply)
  if (!user) return null
  if (user.role !== 'ADMIN') {
    reply.status(403).send({ code: 'forbidden', message: '需要管理员权限' })
    return null
  }
  return user
}

export function toUserRead(row: {
  id: string
  email: string
  role: UserRole
  created_at: Date
}) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    createdAt: row.created_at.toISOString(),
  }
}
