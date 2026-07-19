import pg from 'pg'
import { PGlite } from '@electric-sql/pglite'
import { mkdirSync } from 'node:fs'
import { config } from '../config.js'

type QueryResult<T> = { rows: T[]; rowCount: number | null }

let pglite: PGlite | null = null
let pgPool: pg.Pool | null = null

export async function initDb(): Promise<void> {
  if (config.usePglite) {
    mkdirSync(config.pgliteDir, { recursive: true })
    pglite = new PGlite(config.pgliteDir)
    console.log(`[db] PGlite at ${config.pgliteDir}`)
    return
  }
  pgPool = new pg.Pool({ connectionString: config.databaseUrl })
  console.log('[db] PostgreSQL pool ready')
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  if (pglite) {
    const result = await pglite.query<T>(text, params as never[])
    return { rows: result.rows, rowCount: result.rows.length }
  }
  return pgPool!.query<T>(text, params)
}

export async function closeDb(): Promise<void> {
  if (pglite) {
    await pglite.close()
    pglite = null
    return
  }
  if (pgPool) {
    await pgPool.end()
    pgPool = null
  }
}

/** @deprecated use closeDb */
export const pool = { end: closeDb }
