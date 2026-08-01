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
  if (!apiKey()) return false
  const forced = process.env.FLOW_RESEARCH?.toLowerCase()
  if (forced === 'off') return false
  if (forced === 'on') return true
  return /(^|\/\/)(api\.)?(x\.ai|openai\.com)/.test(baseUrl())
}

/** Whatever the web says, with its sources. Returns null if search is unavailable. */
export async function research(prompt: string, timeoutMs = 120_000): Promise<ResearchResult | null> {
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
