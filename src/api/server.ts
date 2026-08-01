/**
 * Local runner. The app itself lives in src/app.ts and is shared with the
 * Vercel entry point in api/index.ts.
 */
import { serve } from '@hono/node-server'
import { createApp } from '../app.js'
import { closePool } from '../db.js'

const PORT = Number(process.env.FLOW_API_PORT ?? 8787)
// Localhost by default: this store holds a person's whole life. Binding it to
// 0.0.0.0 is an explicit choice, and pointless without a token anyway.
const HOST = process.env.FLOW_API_HOST ?? '127.0.0.1'
const TOKEN = process.env.FLOW_API_TOKEN

if (!TOKEN) {
  console.error(
    'FLOW_API_TOKEN is not set. Add a long random value to .env before starting the API:\n' +
      "  node -e \"console.log('FLOW_API_TOKEN=' + require('crypto').randomBytes(32).toString('hex'))\" >> .env",
  )
  process.exit(1)
}
if (HOST !== '127.0.0.1' && HOST !== 'localhost' && TOKEN.length < 32) {
  console.error('Refusing to bind a non-local interface with a token shorter than 32 characters.')
  process.exit(1)
}

const server = serve({ fetch: createApp().fetch, hostname: HOST, port: PORT }, (info) => {
  console.log(`[flow:api] listening on http://${HOST}:${info.port}`)
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(() => void closePool().finally(() => process.exit(0)))
  })
}
