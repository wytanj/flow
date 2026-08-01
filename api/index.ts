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
  // Catch-up runs a hosted search agent over several queries — tens of
  // seconds, sometimes more. Anything less truncates it into a 504.
  maxDuration: 300,
}

const app = createApp()

export const fetch = (request: Request): Response | Promise<Response> => app.fetch(request)
