import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { initDb, query, closeDb } from './pool.js'

const serverRoot = process.env.SERVER_ROOT ?? process.cwd()
const migrationsDir = process.env.MIGRATIONS_DIR ?? join(serverRoot, 'migrations')

export async function runMigrations(): Promise<void> {
  await initDb()
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  for (const file of files) {
    const { rows } = await query<{ name: string }>(
      'SELECT name FROM schema_migrations WHERE name = $1',
      [file],
    )
    if (rows.length > 0) continue

    const sql = readFileSync(join(migrationsDir, file), 'utf8')
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('--'))
    for (const stmt of statements) {
      await query(stmt)
    }
    await query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
    console.log(`[migrate] applied ${file}`)
  }
}

if (process.argv[1]?.includes('migrate')) {
  runMigrations()
    .then(() => {
      console.log('[migrate] done')
      return closeDb()
    })
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}
