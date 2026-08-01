/**
 * Vector index management.
 *
 *   npm run embeddings            status: provider, coverage, what is stale
 *   npm run embeddings:sync       embed anything new, edited, or from another provider
 *   npm run embeddings:sync -- --rebuild    drop and redo (after changing provider)
 */
import { closePool } from '../src/db.js'
import { status, sync } from '../src/embeddings/store.js'

const args = process.argv.slice(2)
const command = args.find((a) => !a.startsWith('--')) ?? 'status'
const rebuild = args.includes('--rebuild')

async function main() {
  if (command === 'status') {
    const s = await status()
    console.log(`embeddings: ${s.enabled ? 'configured' : 'off'}`)
    if (s.configured_provider) console.log(`provider:   ${s.configured_provider}`)
    if (s.index) console.log(`index:      ${s.index.provider} · ${s.index.dimensions}d · ${s.index.indexed ? 'hnsw' : 'exact scan (>2000d)'}`)
    console.log(`coverage:   ${s.embedded}/${s.total_entries} entries${s.stale ? `, ${s.stale} stale` : ''}`)
    console.log(`recall:     ${s.ready ? 'hybrid (full-text + vector)' : 'full-text only'}`)
    if (s.note) console.log(`\n${s.note}`)
    return
  }

  if (command === 'sync') {
    if (rebuild) console.log('rebuilding index from scratch…')
    const res = await sync({
      rebuild,
      onProgress: (done, total) => process.stdout.write(`\rembedding ${done}/${total}…`),
    })
    process.stdout.write('\r')
    console.log(`done. ${res.embedded} embedded with ${res.provider} (${res.dimensions}d).`)
    const s = await status()
    console.log(`recall: ${s.ready ? 'hybrid (full-text + vector)' : 'full-text only'}`)
    return
  }

  console.error(`Unknown command "${command}". Use: status | sync [--rebuild]`)
  process.exitCode = 1
}

main()
  .catch((err) => {
    console.error('\n' + (err instanceof Error ? err.message : String(err)))
    process.exitCode = 1
  })
  .finally(closePool)
