import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { config as loadEnv } from 'dotenv'

const here = dirname(fileURLToPath(import.meta.url))
export const projectRoot = join(here, '..')

loadEnv({ path: join(projectRoot, '.env'), quiet: true })

const connectionString = process.env.FLOW_DATABASE_URL ?? process.env.SUPABASE_POOLER
if (!connectionString) {
  throw new Error('No database connection string. Set SUPABASE_POOLER (or FLOW_DATABASE_URL) in .env')
}

// Timestamps come back as ISO-8601 strings rather than local-timezone Date
// objects, so what the API returns is exactly what the database holds.
// Postgres renders "2026-07-31 09:14:29.026382+00"; normalise the separator and
// pad the offset rather than round-tripping through Date, which would drop the
// microseconds and re-interpret the zone.
const toIso = (v: string) => v.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')
pg.types.setTypeParser(1184, toIso) // timestamptz
pg.types.setTypeParser(1114, toIso) // timestamp

// Serverless invocations are single-request and may run many at once, so each
// holds one connection and drops it quickly. A long-running local process can
// afford a small pool. Point FLOW_DATABASE_URL at Supabase's *transaction*
// pooler (port 6543) when deploying — the session pooler on 5432 will run out
// of connections under concurrent lambdas.
const serverless = Boolean(process.env.VERCEL)

export const pool = new pg.Pool({
  connectionString,
  // Supabase's pooler terminates TLS with a cert chain Node does not ship a
  // root for; the connection is still encrypted.
  ssl: { rejectUnauthorized: false },
  max: serverless ? 1 : 4,
  idleTimeoutMillis: serverless ? 2_000 : 10_000,
  connectionTimeoutMillis: 15_000,
})

pool.on('error', (err) => {
  console.error('[flow:db] idle client error:', err.message)
})

export async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query<T>(text, params)
  return res.rows
}

export async function q1<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await q<T>(text, params)
  return rows[0] ?? null
}

export function readSchemaSql(): string {
  return readFileSync(join(here, 'schema.sql'), 'utf8')
}

export async function closePool(): Promise<void> {
  await pool.end()
}
