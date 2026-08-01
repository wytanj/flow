/**
 * The flow application, transport-agnostic.
 *
 * src/api/server.ts runs it as a local Node process; api/index.ts runs the same
 * thing as a Vercel function. Three surfaces share it:
 *
 *   /            REST, for scripts and phone shortcuts
 *   /mcp         MCP over Streamable HTTP, for the Claude apps
 *   /telegram/*  a bot webhook, dormant until a bot token is set
 */
import { StreamableHTTPTransport } from '@hono/mcp'
import { type Context, Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { ask } from './ai/ask.js'
import { smartCapture } from './ai/extract.js'
import { AiUnavailable, aiEnabled } from './ai/llm.js'
import { researchEnabled, researchMode } from './ai/research.js'
import { catchUpEntry, shelfQueue } from './core/catchup.js'
import { embeddingsConfigured } from './embeddings/provider.js'
import { getIntegration, listIntegrations } from './integrations/index.js'
import { status as embeddingStatus } from './embeddings/store.js'
import * as flow from './core/flow.js'
import { type Surface, logged, promptPatterns, recentPrompts } from './core/prompts.js'
import { createFlowServer } from './mcp/tools.js'
import { handleTelegramUpdate, telegramEnabled } from './telegram/webhook.js'

export function requireToken(): string {
  const token = process.env.FLOW_API_TOKEN
  if (!token) throw new Error('FLOW_API_TOKEN is not set')
  return token
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export function createApp(): Hono {
  const app = new Hono()

  app.get('/health', (c) =>
    c.json({
      ok: true,
      service: 'flow',
      version: '0.1.0',
      ai: aiEnabled(),
      telegram: telegramEnabled(),
      embeddings: embeddingsConfigured(),
      research: researchMode(),
    }),
  )

  // --- MCP over HTTP -------------------------------------------------------
  // Mounted before the bearer middleware because it carries its own auth: the
  // Claude apps take a URL and little else, so the token may ride in the path.
  // A URL secret is weaker than a header (it lands in browser history and
  // proxy logs) — the header form is accepted too and is the better one.
  const mcpHandler = async (c: Context) => {
    const supplied = bearerFrom(c.req.header('authorization')) ?? c.req.param('token') ?? ''
    if (!timingSafeEqual(supplied, requireToken())) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    // Stateless: a fresh server and transport per request, so concurrent
    // callers never share state and a serverless cold start is unremarkable.
    const server = createFlowServer()
    const transport = new StreamableHTTPTransport()
    await server.connect(transport)
    return transport.handleRequest(c)
  }
  app.all('/mcp', mcpHandler)
  app.all('/mcp/:token', mcpHandler)

  // --- Telegram ------------------------------------------------------------
  // Authenticated by Telegram's own secret-token header, not the flow token.
  app.post('/telegram/webhook', async (c) => {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET
    if (!secret || !timingSafeEqual(c.req.header('x-telegram-bot-api-secret-token') ?? '', secret)) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    // Always 200: Telegram retries anything else, and a retry storm on a
    // capture endpoint would duplicate memories.
    try {
      await handleTelegramUpdate(await c.req.json())
    } catch (err) {
      console.error('[flow:telegram]', err)
    }
    return c.json({ ok: true })
  })

  // --- auth for everything else -------------------------------------------
  app.use('*', async (c, next) => {
    const supplied = bearerFrom(c.req.header('authorization')) ?? c.req.header('x-flow-token') ?? ''
    if (!timingSafeEqual(supplied, requireToken())) {
      throw new HTTPException(401, { message: 'Unauthorized' })
    }
    return next()
  })

  // --- REST ----------------------------------------------------------------
  app.post('/capture', async (c) => {
    const contentType = c.req.header('content-type') ?? ''
    const input = contentType.includes('text/plain')
      ? { body: await c.req.text(), source: 'api' }
      : await body(c, captureSchema)
    const result = await logged(
      { surface: surfaceOf(c), action: 'capture', input: input.body ?? input.title ?? null },
      () =>
        flow.capture({
          ...input,
          source: input.source ?? 'api',
          capture_id: idempotencyKey(c, input),
        }),
      (r) => [r.entry],
    )
    // 200 rather than 201 on a replay, so a client can tell it was a no-op
    return c.json(result, result.created ? 201 : 200)
  })

  app.get('/search', async (c) => {
    const query = c.req.query('q') ?? c.req.query('query') ?? ''
    return c.json({ query, results: await flow.search(query, filtersFromQuery(c)) })
  })

  app.get('/entries', async (c) => c.json({ entries: await flow.listEntries(filtersFromQuery(c)) }))

  app.get('/entries/:id', async (c) => {
    const entry = await flow.getEntry(await flow.resolveId(c.req.param('id')))
    if (!entry) throw new HTTPException(404, { message: 'Not found' })
    return c.json(entry)
  })

  app.patch('/entries/:id', async (c) => {
    const patch = await body(
      c,
      captureSchema.omit({ source: true }).extend({
        add_tags: z.array(z.string()).optional(),
        archived: z.boolean().optional(),
      }),
    )
    const entry = await flow.updateEntry(await flow.resolveId(c.req.param('id')), patch)
    if (!entry) throw new HTTPException(404, { message: 'Not found' })
    return c.json(entry)
  })

  app.delete('/entries/:id', async (c) => {
    const ok = await flow.deleteEntry(await flow.resolveId(c.req.param('id')))
    if (!ok) throw new HTTPException(404, { message: 'Not found' })
    return c.json({ deleted: true })
  })

  app.post('/entries/:id/notes', async (c) => {
    const { body: noteText } = await body(c, z.object({ body: z.string().min(1) }))
    return c.json(await flow.addNote(await flow.resolveId(c.req.param('id')), noteText), 201)
  })

  app.post('/links', async (c) => {
    const input = await body(c, z.object({ from: z.string(), to: z.string(), rel: z.string().optional() }))
    const [from, to] = await Promise.all([flow.resolveId(input.from), flow.resolveId(input.to)])
    return c.json(await flow.linkEntries(from, to, input.rel ?? 'related'), 201)
  })

  app.get('/due', async (c) => c.json({ due: await flow.due(Number(c.req.query('within_days')) || 0) }))

  app.get('/watchlist', async (c) => {
    const show = c.req.query('show') ?? 'want'
    const entries =
      show === 'all'
        ? await flow.listEntries({ kind: 'movie', limit: 200 })
        : show === 'watched'
          ? await flow.listEntries({ kind: 'movie', status: 'watched', limit: 200 })
          : await flow.open('movie', 200)
    return c.json({ show, entries })
  })

  app.get('/people', async (c) => {
    const query = c.req.query('q')
    const entries = query
      ? await flow.search(query, { kind: 'person', limit: 50 })
      : await flow.listEntries({ kind: 'person', limit: 50 })
    return c.json({ people: entries })
  })

  app.get('/briefing', async (c) => c.json(await flow.briefing()))
  app.get('/stats', async (c) => c.json(await flow.stats()))
  app.get('/shelves', async (c) => c.json({ shelves: await flow.shelves() }))

  // Catch-up is one entry per request on purpose: each call stays inside a
  // serverless timeout, and the caller drives the loop so progress is real
  // rather than a spinner over an opaque batch.
  app.post('/entries/:id/catchup', async (c) => {
    const id = await flow.resolveId(c.req.param('id'))
    return c.json(await catchUpEntry(id))
  })

  /** The queue for a shelf: what to check, oldest-checked first. */
  app.get('/shelves/:tag/queue', async (c) => {
    const entries = await shelfQueue(c.req.param('tag'))
    return c.json({ shelf: c.req.param('tag'), entries, research: researchEnabled() })
  })

  app.patch('/shelves/:tag', async (c) => {
    const { to } = await body(c, z.object({ to: z.string().min(1) }))
    const moved = await flow.renameShelf(c.req.param('tag'), to)
    return c.json({ renamed: moved.length, entries: moved })
  })
  app.get('/embeddings', async (c) => c.json(await embeddingStatus()))

  // --- integrations --------------------------------------------------------
  app.get('/integrations', (c) => c.json({ integrations: listIntegrations() }))

  // GET as well as POST because scheduled runners (Vercel cron among them)
  // only issue GETs. Defensible here: sync is idempotent by construction, so
  // calling it twice is the same as calling it once.
  const syncHandler = async (c: Context) => {
    const integration = getIntegration(c.req.param('name') ?? '')
    if (!integration) throw new HTTPException(404, { message: 'No such integration' })
    if (!integration.configured()) {
      throw new HTTPException(400, { message: `Not configured — needs ${integration.requires}` })
    }
    const limit = Number(c.req.query('limit'))
    return c.json(await integration.sync({ limit: Number.isFinite(limit) && limit > 0 ? limit : undefined }))
  }
  app.post('/integrations/:name/sync', syncHandler)
  app.get('/integrations/:name/sync', syncHandler)

  /** Starred repos and anything else collected but not yet thought about. */
  app.get('/repos', async (c) => {
    const query = c.req.query('q')
    const entries = query
      ? await flow.search(query, { kind: 'repo', limit: 50 })
      : await flow.listEntries({ kind: 'repo', limit: 50 })
    return c.json({ repos: entries })
  })

  // --- model-backed --------------------------------------------------------
  // Through MCP the client's own model does this work. These give the REST and
  // CLI paths the same understanding when nothing smarter is in the loop.

  /** Free text in, structured entries out. One brain dump may become several. */
  app.post('/jot', async (c) => {
    const contentType = c.req.header('content-type') ?? ''
    const parsed = contentType.includes('text/plain')
      ? { text: await c.req.text(), capture_id: undefined }
      : await body(c, z.object({ text: z.string().min(1), capture_id: z.string().optional() }))
    const result = await logged(
      { surface: surfaceOf(c), action: 'jot', input: parsed.text },
      () => smartCapture(parsed.text, 'api', idempotencyKey(c, parsed)),
      (r) => r.entries,
    )
    return c.json(result, result.entries.length ? 201 : 200)
  })

  /** Natural-language question, answered strictly from your own entries. */
  app.post('/ask', async (c) => {
    const { question, kind } = await body(
      c,
      z.object({ question: z.string().min(1), kind: z.string().optional() }),
    )
    return c.json(
      await logged({ surface: surfaceOf(c), action: 'ask', input: question }, () => ask(question, { kind })),
    )
  })

  app.get('/ask', async (c) => {
    const question = c.req.query('q') ?? ''
    if (!question) throw new HTTPException(400, { message: 'Pass ?q=' })
    return c.json(
      await logged({ surface: surfaceOf(c), action: 'ask', input: question }, () =>
        ask(question, { kind: c.req.query('kind') }),
      ),
    )
  })

  // --- prompt log ----------------------------------------------------------
  app.get('/prompts', async (c) => {
    const limit = Number(c.req.query('limit')) || 50
    return c.json({ prompts: await recentPrompts(limit, c.req.query('surface')) })
  })

  app.get('/prompts/patterns', async (c) => c.json(await promptPatterns()))

  // --- errors --------------------------------------------------------------
  app.notFound((c) => c.json({ error: 'No such route' }, 404))
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status)
    if (err instanceof AiUnavailable) return c.json({ error: err.message }, 503)
    console.error('[flow:api]', err)
    // resolveId reports genuine user errors ("no entry matches…") as plain Errors
    const message = err instanceof Error ? err.message : 'Internal error'
    const isClientFault = /no entry match|ambiguous|empty|cannot link|nothing to capture|ask something/i.test(message)
    return c.json({ error: message }, isClientFault ? 400 : 500)
  })

  return app
}

// ---------------------------------------------------------------------------

/**
 * Idempotency key for a capture, from the body or the conventional header.
 * A phone that buffered offline and flushed twice must not create the memory
 * twice — so this is how every device client should send captures.
 */
function idempotencyKey(
  c: { req: { header: (k: string) => string | undefined } },
  input: { capture_id?: string | null },
): string | null {
  return input.capture_id?.trim() || c.req.header('idempotency-key')?.trim() || null
}

/** The web app identifies itself so its prompts can be told from a script's. */
function surfaceOf(c: { req: { header: (k: string) => string | undefined } }): Surface {
  const s = c.req.header('x-flow-surface')?.trim().toLowerCase()
  return s === 'web' || s === 'cli' || s === 'telegram' || s === 'mcp' ? s : 'api'
}

function bearerFrom(header: string | undefined): string | null {
  if (!header) return null
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null
}

const captureSchema = z.object({
  kind: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  data: z.record(z.any()).optional(),
  tags: z.array(z.string()).optional(),
  status: z.string().optional(),
  rating: z.number().int().min(1).max(10).optional(),
  occurred_at: z.string().optional(),
  remind_at: z.string().optional(),
  source: z.string().optional(),
  capture_id: z.string().optional(),
})

/** Parses a JSON body against a schema, turning failures into a 400. */
async function body<T extends z.ZodTypeAny>(
  c: { req: { json: () => Promise<unknown> } },
  schema: T,
): Promise<z.infer<T>> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw new HTTPException(400, { message: 'Body must be JSON' })
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    })
  }
  return parsed.data
}

const list = (v: string | undefined): string[] | undefined =>
  v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined

function filtersFromQuery(c: { req: { query: (k: string) => string | undefined } }): flow.Filters {
  const limit = Number(c.req.query('limit'))
  return {
    kind: c.req.query('kind') ?? null,
    kinds: list(c.req.query('kinds')) ?? null,
    status: c.req.query('status') ?? null,
    tags: list(c.req.query('tags')) ?? null,
    tags_mode: c.req.query('tags_mode') === 'any' ? 'any' : 'all',
    since: c.req.query('since') ?? null,
    until: c.req.query('until') ?? null,
    include_archived: c.req.query('include_archived') === 'true',
    limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    offset: Number(c.req.query('offset')) || 0,
  }
}
