/**
 * Looking things up in the world.
 *
 * Distinct from ./llm.ts on purpose. That one answers *from your entries* and
 * is forbidden from using outside knowledge — the guarantee that flow can never
 * invent your past. This one does the opposite: it reaches out, and whatever it
 * returns is written into your memory clearly marked as such, dated and sourced.
 *
 * Uses the Responses API with a server-side web_search tool (xAI and OpenAI
 * both expose this shape). Without it, catch-up still works — it just falls
 * back to re-reading the page itself.
 */
import '../db.js'

export interface ResearchResult {
  text: string
  citations: string[]
}

export interface ResearchDoc {
  title: string
  url: string
  published?: string
  highlights: string[]
}

/**
 * Two shapes, because they are genuinely different tools.
 *
 *   agentic    you ask a question, the model decides what to search
 *              (xAI / OpenAI hosted web_search). Thorough, ~30s.
 *   retrieval  you specify the query and the filters, and summarise the
 *              results yourself (Exa). ~1s, and the date window is a hard
 *              constraint rather than a request the model may ignore.
 *
 * Catch-up is entirely "what happened *since I last looked*", so retrieval is
 * the better fit where available: the date filter is enforced at the source.
 */
export type ResearchMode = 'exa' | 'agentic' | null

export function researchMode(): ResearchMode {
  const forced = process.env.FLOW_RESEARCH?.toLowerCase()
  if (forced === 'off') return null
  if (forced === 'exa') return process.env.EXA_API_KEY ? 'exa' : null
  if (forced === 'agentic' || forced === 'on') return apiKey() ? 'agentic' : null
  if (process.env.EXA_API_KEY) return 'exa'
  return apiKey() && /(^|\/\/)(api\.)?(x\.ai|openai\.com)/.test(baseUrl()) ? 'agentic' : null
}

/**
 * Exa search. `since` becomes startPublishedDate, which is the whole reason to
 * prefer this for catch-up — "only things published after I last checked" is
 * applied by the index, not hoped for in a prompt.
 */
export async function exaSearch(opts: {
  query: string
  since?: string | null
  numResults?: number
  category?: string
  timeoutMs?: number
}): Promise<ResearchDoc[]> {
  const key = process.env.EXA_API_KEY
  if (!key) return []

  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      query: opts.query,
      type: process.env.EXA_SEARCH_TYPE ?? 'auto',
      numResults: opts.numResults ?? 8,
      ...(opts.since ? { startPublishedDate: opts.since } : {}),
      ...(opts.category ? { category: opts.category } : {}),
      contents: { highlights: true },
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  })

  const json = (await res.json().catch(() => null)) as {
    results?: { title?: string; url?: string; publishedDate?: string; highlights?: string[] }[]
    error?: string
  } | null

  if (!res.ok || !json) throw new Error(`exa search failed (${res.status}): ${json?.error ?? res.statusText}`)

  return (json.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({
      title: r.title ?? r.url!,
      url: r.url!,
      published: r.publishedDate,
      highlights: (r.highlights ?? []).map((h) => h.replace(/\s+/g, ' ').trim()).filter(Boolean),
    }))
}

function baseUrl(): string {
  return (process.env.FLOW_RESEARCH_URL ?? process.env.FLOW_LLM_URL ?? 'https://api.x.ai/v1').replace(/\/$/, '')
}

function apiKey(): string {
  return process.env.FLOW_RESEARCH_KEY ?? process.env.FLOW_LLM_KEY ?? process.env.XAI_KEY ?? process.env.OPENAI_API_KEY ?? ''
}

function model(): string {
  return process.env.FLOW_RESEARCH_MODEL ?? process.env.FLOW_MODEL ?? 'grok-4.5'
}

/**
 * Only endpoints known to serve a hosted search tool. Guessing wrong means a
 * hard 400 on every catch-up, so this stays opt-in-by-recognition: set
 * FLOW_RESEARCH=on to force it for an endpoint not listed here.
 */
export function researchEnabled(): boolean {
  return researchMode() !== null
}

/**
 * A hosted search agent runs several queries per question, so this is tens of
 * seconds, not one round trip. The timeout must sit *below* the platform's
 * function limit — otherwise the platform kills the request and the caller
 * gets an opaque 504 instead of a handled failure.
 */
function budgetMs(): number {
  const env = Number(process.env.FLOW_RESEARCH_TIMEOUT_MS)
  if (Number.isFinite(env) && env > 0) return env
  const fnLimit = Number(process.env.FLOW_FUNCTION_MAX_SECONDS ?? (process.env.VERCEL ? 300 : 0))
  return fnLimit > 0 ? Math.max(20_000, (fnLimit - 20) * 1000) : 180_000
}

/** Whatever the web says, with its sources. Returns null if search is unavailable. */
export async function research(prompt: string, timeoutMs = budgetMs()): Promise<ResearchResult | null> {
  if (!researchEnabled()) return null

  const res = await fetch(`${baseUrl()}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey()}` },
    body: JSON.stringify({
      model: model(),
      input: [{ role: 'user', content: prompt }],
      tools: [{ type: process.env.FLOW_RESEARCH_TOOL ?? 'web_search' }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })

  const json = (await res.json().catch(() => null)) as {
    output?: {
      type: string
      content?: { type: string; text?: string; annotations?: { url?: string }[] }[]
    }[]
    error?: string | { message?: string }
  } | null

  if (!res.ok || !json) {
    const detail = typeof json?.error === 'string' ? json.error : json?.error?.message
    throw new Error(`research request failed (${res.status}): ${detail ?? res.statusText}`)
  }

  // The output is a transcript — reasoning, tool calls, then the final message.
  const messages = (json.output ?? []).filter((o) => o.type === 'message')
  const last = messages[messages.length - 1]
  if (!last?.content) return null

  const text = last.content
    .filter((c) => c.type === 'output_text')
    .map((c) => c.text ?? '')
    .join('')
    .trim()

  const citations = [
    ...new Set(
      last.content
        .flatMap((c) => c.annotations ?? [])
        .map((a) => a.url)
        .filter((u): u is string => Boolean(u)),
    ),
  ]

  return text ? { text, citations } : null
}
