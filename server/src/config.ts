import { config as loadEnv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Dev: `server/src`; prod build: `server/dist/server/src` — cwd is always `server/`. */
const serverRoot = process.env.SERVER_ROOT ?? process.cwd()

loadEnv({ path: resolve(serverRoot, '.env') })

function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? 'http://localhost:5174')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

const usePglite =
  process.env.USE_PGLITE === '1' ||
  process.env.USE_PGLITE === 'true' ||
  !process.env.DATABASE_URL?.trim()

let encryptionKey = process.env.ENCRYPTION_KEY?.trim()
if (!encryptionKey) {
  encryptionKey = randomBytes(32).toString('base64')
  console.warn('[config] ENCRYPTION_KEY not set — using ephemeral key (dev only)')
}

export const config = {
  port: Number(process.env.PORT ?? 8010),
  usePglite,
  pgliteDir: process.env.PGLITE_DIR ?? resolve(serverRoot, 'data/pglite'),
  databaseUrl: process.env.DATABASE_URL?.trim() ?? '',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-jwt-secret-change-in-production-min-32b',
  // 访问令牌默认 2h，减少「写一会儿就 401」；刷新令牌仍 7 天
  jwtAccessExpires: process.env.JWT_ACCESS_EXPIRES ?? '2h',
  jwtRefreshExpires: process.env.JWT_REFRESH_EXPIRES ?? '7d',
  encryptionKey,
  corsOrigins: parseOrigins(process.env.CORS_ORIGINS),
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
  openAiCompatibleBaseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL ?? 'https://opencode.ai/zen/go',
  seedAdminEmail: process.env.SEED_ADMIN_EMAIL ?? 'admin@characterarc.local',
  seedAdminPassword: process.env.SEED_ADMIN_PASSWORD ?? '123456',
  seedInviteCode: process.env.SEED_INVITE_CODE ?? 'CHARARC-BETA',
  /** 首次部署时为 admin 预置 OpenCode DeepSeek BYOK（见 tools/startup.sh） */
  seedAdminAiProvider: (process.env.SEED_ADMIN_AI_PROVIDER ?? 'openai-compatible') as 'deepseek' | 'openai-compatible',
  seedAdminAiModel: process.env.SEED_ADMIN_AI_MODEL ?? 'deepseek-v4-flash',
  seedAdminAiBaseUrl: process.env.SEED_ADMIN_AI_BASE_URL ?? process.env.OPENAI_COMPATIBLE_BASE_URL ?? 'https://opencode.ai/zen/go',
  seedAdminAiApiKey: process.env.SEED_ADMIN_AI_API_KEY?.trim() ?? '',
  dataRoot: process.env.DATA_ROOT ?? resolve(serverRoot, '../data'),
  /** JSON workspace PUT / import 等请求体上限（MB） */
  bodyLimitMb: Number(process.env.BODY_LIMIT_MB ?? 50),
}

/** Fastify 全局 JSON body 上限（字节），默认 50MB */
export const bodyLimitBytes = Math.floor(
  (Number.isFinite(Number(process.env.BODY_LIMIT_MB ?? 50)) ? Number(process.env.BODY_LIMIT_MB ?? 50) : 50)
    * 1024
    * 1024,
)

export type UserRole = 'USER' | 'ADMIN'

export interface JwtUserPayload {
  sub: string
  email: string
  role: UserRole
  type?: 'refresh'
}
