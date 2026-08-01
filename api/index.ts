/**
 * Vercel entry point. Every route is rewritten here by vercel.json, so this one
 * function serves REST, MCP and the Telegram webhook — the same app that
 * src/api/server.ts runs locally.
 *
 * Exported as `fetch`, not as a default export: Vercel's Node runtime calls a
 * default export with Node's (req, res) and discards anything it returns, which
 * leaves a Hono app hanging until the request times out. The named `fetch`
 * export gets the Web Request/Response signature Hono actually speaks.
 */
import { createApp } from '../src/app.js'

export const config = {
  runtime: 'nodejs',
  // Recall makes two model round trips plus several searches; the default 10s
  // would cut a legitimate question off midway.
  maxDuration: 60,
}

const app = createApp()

export const fetch = (request: Request): Response | Promise<Response> => app.fetch(request)
