/**
 * End-to-end check of the MCP server: spawns it over stdio exactly as a client
 * would, exercises every tool, then deletes everything it created — this runs
 * against the real store, so it must leave no trace.
 *
 *   npm run smoke
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TAG = '_smoke'
const created = []
let failures = 0

const transport = new StdioClientTransport({
  command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
  args: ['tsx', join(root, 'src/mcp/server.ts')],
  cwd: root,
  stderr: 'ignore',
})
const client = new Client({ name: 'flow-smoke', version: '1.0.0' })
await client.connect(transport)

async function call(name, args, expect) {
  const res = await client.callTool({ name, arguments: args })
  const text = res.content.map((c) => c.text).join('\n')
  const ok = expect ? expect(text, res) : !res.isError
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
  if (!ok) console.log(text.split('\n').map((l) => `       ${l}`).join('\n'))
  // Only ever track ids this script created. Scraping ids out of any tool's
  // output would sweep up pre-existing entries listed by flow_due or
  // flow_briefing — and the cleanup below deletes permanently.
  if (name === 'flow_capture' && !res.isError) {
    const id = text.match(/Captured:\n- \[([0-9a-f]{8})\]/)?.[1]
    if (id) created.push(id)
  }
  return text
}

const { tools } = await client.listTools()
console.log(`${tools.length} tools: ${tools.map((t) => t.name).join(', ')}\n`)

await call('flow_capture', {
  kind: 'movie',
  title: 'Smoke Test: A Film',
  data: { year: 2026, director: 'Nobody' },
  tags: [TAG],
})
await call('flow_capture', {
  kind: 'person',
  title: 'Smoke Testperson',
  body: 'Works at Testco. Met at a conference that did not happen.',
  data: { company: 'Testco' },
  tags: [TAG],
})
await call('flow_recall', { query: 'testco' }, (t) => t.includes('Smoke Testperson'))
await call('flow_recall', { query: 'smoke testprson' }, (t) => t.includes('Smoke Testperson')) // fuzzy
await call('flow_update', { id: 'Smoke Test: A Film', status: 'watched', rating: 7 }, (t) => t.includes('7/10'))
await call('flow_note', { id: 'Smoke Test: A Film', body: 'A note added later.' })
await call('flow_get', { id: 'Smoke Test: A Film' }, (t) => t.includes('A note added later'))
await call('flow_recall', { query: 'added later' }, (t) => t.includes('Smoke Test')) // notes are searchable
await call('flow_link', { from: 'Smoke Testperson', to: 'Smoke Test: A Film', rel: 'recommended' })
await call('flow_watchlist', { show: 'watched' }, (t) => t.includes('Smoke Test: A Film'))
await call('flow_people', { query: 'testco' }, (t) => t.includes('Smoke Testperson'))
await call('flow_list', { kind: 'movie', tags: [TAG] }, (t) => t.includes('Smoke Test'))
await call('flow_due', { within_days: 365 })
await call('flow_briefing', {}, (t) => t.includes('memories'))
await call('flow_get', { id: 'definitely-not-a-real-entry' }, (_t, r) => r.isError === true) // errors are errors

const ids = [...new Set(created)]
for (const id of ids) await client.callTool({ name: 'flow_delete', arguments: { id } })
console.log(`\ncleaned up ${ids.length} test entries`)
console.log(failures ? `${failures} FAILED` : 'all passed')

await client.close()
process.exit(failures ? 1 : 0)
