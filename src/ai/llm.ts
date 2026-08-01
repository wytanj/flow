/**
 * The chat model — bring your own.
 *
 * flow's intelligence is normally whoever is driving the MCP server: through
 * Claude, capture and recall are already smart. This layer exists so the REST,
 * CLI and Telegram paths understand a sentence too, when no agent is in the
 * loop. It powers `/jot` (free text → structured entries) and `/ask` (question
 * → answer grounded in your entries), and nothing else.
 *
 * Any OpenAI-compatible endpoint works, which is nearly all of them:
 *
 *   FLOW_LLM_URL=https://api.x.ai/v1              FLOW_MODEL=grok-4.5
 *   FLOW_LLM_URL=https://api.openai.com/v1        FLOW_MODEL=gpt-4.1-mini
 *   FLOW_LLM_URL=http://localhost:11434/v1        FLOW_MODEL=qwen3:8b     (ollama, no key)
 *
 * Unset it all and flow still works — capture, recall, shelves and MCP need no
 * model at all.
 */
import '../db.js' // loads .env

/** Local endpoints need no key, so a base URL alone is enough to be "on". */
function baseUrl(): string {
  return (process.env.FLOW_LLM_URL ?? process.env.XAI_BASE_URL ?? 'https://api.x.ai/v1').replace(/\/$/, '')
}

function apiKey(): string {
  return process.env.FLOW_LLM_KEY ?? process.env.XAI_KEY ?? process.env.OPENAI_API_KEY ?? ''
}

/**
 * Defaults to a reasoning model even for mechanical extraction. The cheap
 * non-reasoning models silently drop entries from a multi-part brain dump, and
 * a memory you were told and never stored is the one failure this system
 * cannot recover from.
 */
function model(): string {
  return process.env.FLOW_MODEL ?? 'grok-4.5'
}

export function aiEnabled(): boolean {
  // a custom base URL implies a self-hosted endpoint, which needs no key
  return Boolean(apiKey() || process.env.FLOW_LLM_URL)
}

export class AiUnavailable extends Error {
  constructor() {
    super(
      'No chat model configured — /jot and /ask need one. Set FLOW_LLM_KEY (and FLOW_MODEL), ' +
        'or point FLOW_LLM_URL at a local endpoint such as http://localhost:11434/v1.',
    )
    this.name = 'AiUnavailable'
  }
}

export interface JsonSchemaSpec {
  name: string
  schema: Record<string, unknown>
}

interface ChatOptions {
  system: string
  user: string
  schema?: JsonSchemaSpec
  model?: string
  timeoutMs?: number
}

interface ChatResponse {
  choices?: { message?: { content?: string } }[]
  error?: string | { message?: string }
  usage?: { total_tokens?: number }
}

async function post(body: unknown, timeoutMs: number): Promise<ChatResponse> {
  const key = apiKey()
  const res = await fetch(`${baseUrl()}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const json = (await res.json().catch(() => ({}))) as ChatResponse
  if (!res.ok) {
    const detail =
      (typeof json.error === 'string' ? json.error : json.error?.message) ??
      `${res.status} ${res.statusText}`
    const err = new Error(`model request failed: ${detail}`)
    // 429 and 5xx are worth one retry; 4xx is our fault and will fail again
    ;(err as Error & { retryable?: boolean }).retryable = res.status === 429 || res.status >= 500
    throw err
  }
  return json
}

export async function chat({ system, user, schema, model: override, timeoutMs = 90_000 }: ChatOptions): Promise<string> {
  if (!aiEnabled()) throw new AiUnavailable()

  const body = {
    model: override ?? model(),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    ...(schema
      ? {
          response_format: {
            type: 'json_schema',
            json_schema: { name: schema.name, strict: true, schema: schema.schema },
          },
        }
      : {}),
  }

  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const json = await post(body, timeoutMs)
      const content = json.choices?.[0]?.message?.content
      if (!content) throw new Error('model returned an empty response')
      return content
    } catch (err) {
      lastErr = err
      const retryable = (err as Error & { retryable?: boolean }).retryable ?? err instanceof DOMException
      if (!retryable || attempt === 1) throw err
    }
  }
  throw lastErr
}

/** Chat constrained to a JSON schema, parsed. Strict mode makes this reliable. */
export async function chatJson<T>(opts: ChatOptions & { schema: JsonSchemaSpec }): Promise<T> {
  const raw = await chat(opts)
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new Error(`Model returned unparseable JSON: ${raw.slice(0, 200)}`)
  }
}

// Strict JSON-schema mode requires every property in `required`, so anything
// genuinely optional has to be declared nullable instead of omitted.
export const nullableString = { type: ['string', 'null'] }
export const nullableNumber = { type: ['number', 'null'] }
