import { closePool, pool, readSchemaSql } from './db.js'

// The schema is idempotent, so migrating is just replaying it.
async function main() {
  const client = await pool.connect()
  try {
    console.log('[flow] applying schema…')
    await client.query(readSchemaSql())
    const { rows } = await client.query<{ count: string }>('select count(*)::text from flow.entries')
    console.log(`[flow] schema ready. entries in store: ${rows[0]?.count ?? '0'}`)
  } finally {
    client.release()
  }
}

main()
  .catch((err) => {
    console.error('[flow] migration failed:', err.message)
    process.exitCode = 1
  })
  .finally(closePool)
