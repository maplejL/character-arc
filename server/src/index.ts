import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import multipart from '@fastify/multipart'
import websocket from '@fastify/websocket'
import { config, bodyLimitBytes } from './config.js'
import { runMigrations } from './db/migrate.js'
import { seedDevData } from './db/seed.js'
import { initDb, closeDb } from './db/pool.js'
import { authRoutes } from './routes/auth.js'
import { aiConfigRoutes } from './routes/ai-config.js'
import { aiRoutes } from './routes/ai.js'
import { autoCreationRoutes } from './routes/auto-creation.js'
import { fileRoutes } from './routes/files.js'
import { projectModulesRoutes } from './routes/project-modules.js'
import { parityRoutes } from './routes/parity.js'
import { adminRoutes } from './routes/admin.js'
import { healthRoutes } from './routes/health.js'
import { workspaceRoutes } from './routes/workspace.js'
import { continuationRoutes } from './routes/continuation.js'
import type { JwtUserPayload } from './config.js'

import { registerElectronMock } from './ai/register-electron-mock.js'
import { startAutoCreationWorker, stopAutoCreationWorker } from './auto-creation/worker.js'

async function main(): Promise<void> {
  registerElectronMock()
  await runMigrations()
  await seedDevData()

  const app = Fastify({
    logger: true,
    bodyLimit: bodyLimitBytes,
  })
  console.log(`[CharacterArc] bodyLimit=${bodyLimitBytes} bytes (${config.bodyLimitMb}MB)`)

  app.decorate('config', {
    jwtAccessExpires: config.jwtAccessExpires,
    jwtRefreshExpires: config.jwtRefreshExpires,
  })

  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
  })

  await app.register(jwt, { secret: config.jwtSecret })

  await app.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024 },
  })

  await app.register(websocket)

  app.decorate('authenticate', async (request, reply) => {
    try {
      await request.jwtVerify()
    } catch {
      return reply.status(401).send({ code: 'unauthorized', message: '未登录或 token 无效' })
    }
  })

  app.decorate('requireAdmin', async (request, reply) => {
    const user = request.user as JwtUserPayload | undefined
    if (!user || user.role !== 'ADMIN') {
      reply.status(403).send({ code: 'forbidden', message: '需要管理员权限' })
    }
  })

  const routeOpts = { encapsulate: false as const }

  await app.register(healthRoutes, routeOpts)
  await app.register(authRoutes, routeOpts)
  await app.register(aiConfigRoutes, routeOpts)
  await app.register(aiRoutes, routeOpts)
  await app.register(autoCreationRoutes, routeOpts)
  await app.register(fileRoutes, routeOpts)
  await app.register(projectModulesRoutes, routeOpts)
  await app.register(parityRoutes, routeOpts)
  await app.register(adminRoutes, routeOpts)
  await app.register(workspaceRoutes, routeOpts)
  await app.register(continuationRoutes, routeOpts)

  startAutoCreationWorker()

  await app.listen({ port: config.port, host: '0.0.0.0' })
  console.log(`CharacterArc API listening on :${config.port}`)
}

process.on('SIGTERM', () => {
  stopAutoCreationWorker()
})
process.on('SIGINT', () => {
  stopAutoCreationWorker()
})

main().catch((err) => {
  console.error(err)
  void closeDb()
  process.exit(1)
})

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>
  }
  interface FastifyRequest {
    user: JwtUserPayload
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtUserPayload
    user: JwtUserPayload
  }
}
