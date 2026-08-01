/**
 * stdio entry point — how a local client (Claude Code, Claude Desktop) runs
 * flow as a subprocess. The tools themselves live in ./tools.ts, shared with
 * the HTTP transport in src/app.ts.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { closePool } from '../db.js'
import { createFlowServer } from './tools.js'

// stdio transport owns stdout — every diagnostic must go to stderr.
const log = (...args: unknown[]) => console.error('[flow:mcp]', ...args)

async function main() {
  const server = createFlowServer()
  await server.connect(new StdioServerTransport())
  log('ready on stdio')
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void closePool().finally(() => process.exit(0))
  })
}

main().catch((err) => {
  log('fatal:', err)
  process.exit(1)
})
