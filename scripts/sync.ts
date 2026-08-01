/**
 * Pull in things collected elsewhere.
 *
 *   npm run sync              list integrations and whether they are configured
 *   npm run sync -- github    import starred repos (safe to re-run)
 */
import { closePool } from '../src/db.js'
import { getIntegration, listIntegrations } from '../src/integrations/index.js'

const args = process.argv.slice(2)
const name = args.find((a) => !a.startsWith('--'))
const limitFlag = args.find((a) => a.startsWith('--limit='))
const limit = limitFlag ? Number(limitFlag.split('=')[1]) : undefined

async function main() {
  if (!name) {
    for (const i of listIntegrations()) {
      console.log(`${i.id.padEnd(10)} ${i.configured ? 'ready' : 'not configured'}  — ${i.label}`)
      if (!i.configured) console.log(`${''.padEnd(10)} needs ${i.requires}`)
    }
    return
  }

  const integration = getIntegration(name)
  if (!integration) {
    console.error(`No integration called "${name}". Run without arguments to list them.`)
    process.exitCode = 1
    return
  }

  console.log(`syncing ${integration.label}…`)
  const r = await integration.sync({ limit })
  console.log(`${r.imported} new, ${r.skipped} already had, ${r.total_seen} seen.`)
  if (r.note) console.log(r.note)
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(closePool)
