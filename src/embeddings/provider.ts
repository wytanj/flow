/**
 * Bring-your-own embedding provider.
 *
 * Configured with one env var, `FLOW_EMBEDDINGS=<provider>:<model>`:
 *
 *   ollama:qwen3-embedding:0.6b     local, Apache 2.0, nothing leaves the machine (default choice)
 *   gemini:gemini-embedding-001     hosted, generous free tier
 *   openai:text-embedding-3-small   also covers any OpenAI-shaped endpoint via FLOW_EMBEDDINGS_URL
 *                                   (LM Studio, llama.cpp, TEI, vLLM, Voyage, …)
 *   stub:64                         deterministic nonsense, for tests only
 *
 * Unset means embeddings are off and recall stays full-text — flow must work
 * with nothing but a database URL.
 *
 * Vectors from different models are not comparable, so the provider id is
 * recorded with every row and a change is treated as "rebuild the index",
 * never as "carry on".
 */

export type EmbedRole = 'document' | 'query'

export interface EmbeddingProvider {
  /** Stored per row; a change here invalidates the index. */
  readonly id: string
  /** Filled in by probing at init — never hardcoded per model. */
  dimensions: number
  /** Largest batch to send in one request. */
  readonly batchSize: number
  embed(texts: string[], role: EmbedRole): Promise<number[][]>
}

const timeout = (ms = 60_000) => AbortSignal.timeout(ms)

async function jsonPost(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: timeout(),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`embedding request failed (${res.status}): ${text.slice(0, 300)}`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`embedding provider returned non-JSON: ${text.slice(0, 200)}`)
  }
}

// ---------------------------------------------------------------------------
// ollama — the default: local, no key, no data leaving the machine
// ---------------------------------------------------------------------------
class OllamaProvider implements EmbeddingProvider {
  readonly id: string
  dimensions = 0
  readonly batchSize = 32
  private base: string
  private model: string

  constructor(model: string, base?: string) {
    this.model = model
    this.base = (base ?? 'http://localhost:11434').replace(/\/$/, '')
    this.id = `ollama:${model}`
  }

  async embed(texts: string[], role: EmbedRole): Promise<number[][]> {
    // Qwen3-Embedding is trained to take an instruction on the query side only;
    // giving it one measurably improves retrieval, and other models ignore it.
    const input =
      role === 'query' && /qwen3-embedding/i.test(this.model)
        ? texts.map((t) => `Instruct: Given a search query, retrieve relevant passages\nQuery: ${t}`)
        : texts
    const json = await jsonPost(`${this.base}/api/embed`, { model: this.model, input })
    const vecs = json.embeddings as number[][] | undefined
    if (!vecs?.length) throw new Error('ollama returned no embeddings')
    return vecs
  }
}

// ---------------------------------------------------------------------------
// gemini
// ---------------------------------------------------------------------------
class GeminiProvider implements EmbeddingProvider {
  readonly id: string
  dimensions = 0
  readonly batchSize = 100
  private model: string
  private key: string
  private outputDim: number

  constructor(model: string, key: string, outputDim: number) {
    this.model = model
    this.key = key
    // pgvector can only index up to 2000 dimensions, and Gemini defaults to
    // 3072. Truncating via Matryoshka keeps the index usable at no real cost.
    this.outputDim = outputDim
    this.id = `gemini:${model}@${outputDim}`
  }

  async embed(texts: string[], role: EmbedRole): Promise<number[][]> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:batchEmbedContents?key=${this.key}`
    const json = await jsonPost(url, {
      requests: texts.map((text) => ({
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
        taskType: role === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
        outputDimensionality: this.outputDim,
      })),
    })
    const vecs = (json.embeddings as { values: number[] }[] | undefined)?.map((e) => e.values)
    if (!vecs?.length) throw new Error('gemini returned no embeddings')
    // Truncated Matryoshka vectors need renormalising to stay unit length
    return vecs.map(normalise)
  }
}

// ---------------------------------------------------------------------------
// openai-compatible — OpenAI, Voyage, LM Studio, TEI, vLLM, llama.cpp …
// ---------------------------------------------------------------------------
class OpenAICompatProvider implements EmbeddingProvider {
  readonly id: string
  dimensions = 0
  readonly batchSize = 64
  private base: string
  private model: string
  private key: string
  private outputDim?: number

  constructor(model: string, key: string, base?: string, outputDim?: number) {
    this.model = model
    this.key = key
    this.base = (base ?? 'https://api.openai.com/v1').replace(/\/$/, '')
    this.outputDim = outputDim
    this.id = `openai:${model}${outputDim ? `@${outputDim}` : ''}`
  }

  async embed(texts: string[]): Promise<number[][]> {
    const json = await jsonPost(
      `${this.base}/embeddings`,
      { model: this.model, input: texts, ...(this.outputDim ? { dimensions: this.outputDim } : {}) },
      this.key ? { authorization: `Bearer ${this.key}` } : {},
    )
    const rows = json.data as { index: number; embedding: number[] }[] | undefined
    if (!rows?.length) throw new Error('provider returned no embeddings')
    // the spec allows results out of order
    return rows.sort((a, b) => a.index - b.index).map((r) => r.embedding)
  }
}

// ---------------------------------------------------------------------------
// stub — deterministic vectors so the pipeline can be tested with no provider
// ---------------------------------------------------------------------------
class StubProvider implements EmbeddingProvider {
  readonly id: string
  dimensions: number
  readonly batchSize = 256

  constructor(dims: number) {
    this.dimensions = dims
    this.id = `stub:${dims}`
  }

  async embed(texts: string[]): Promise<number[][]> {
    // A bag-of-words hash. Not semantic — related texts land near each other
    // only when they share words — but enough to prove the plumbing works.
    return texts.map((text) => {
      const v = new Array<number>(this.dimensions).fill(0)
      for (const word of text.toLowerCase().match(/[a-z0-9']+/g) ?? []) {
        let h = 2166136261
        for (let i = 0; i < word.length; i++) {
          h ^= word.charCodeAt(i)
          h = Math.imul(h, 16777619)
        }
        const slot = Math.abs(h) % this.dimensions
        v[slot] = (v[slot] ?? 0) + 1
      }
      return normalise(v)
    })
  }
}

function normalise(v: number[]): number[] {
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return mag > 0 ? v.map((x) => x / mag) : v
}

// ---------------------------------------------------------------------------

export function embeddingsConfigured(): boolean {
  return Boolean(process.env.FLOW_EMBEDDINGS?.trim())
}

/** Builds the configured provider, or null when embeddings are switched off. */
export function getProvider(): EmbeddingProvider | null {
  const spec = process.env.FLOW_EMBEDDINGS?.trim()
  if (!spec) return null

  // provider:model, where the model itself may contain colons (ollama tags)
  const idx = spec.indexOf(':')
  if (idx < 1) throw new Error(`FLOW_EMBEDDINGS must look like "provider:model", got "${spec}"`)
  const kind = spec.slice(0, idx).toLowerCase()
  const model = spec.slice(idx + 1)
  const base = process.env.FLOW_EMBEDDINGS_URL?.trim() || undefined
  const dimEnv = Number(process.env.FLOW_EMBEDDINGS_DIM)
  const outputDim = Number.isFinite(dimEnv) && dimEnv > 0 ? dimEnv : undefined

  switch (kind) {
    case 'ollama':
      return new OllamaProvider(model, base)
    case 'gemini': {
      const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
      if (!key) throw new Error('gemini embeddings need GEMINI_API_KEY')
      return new GeminiProvider(model, key, outputDim ?? 1536)
    }
    case 'openai':
    case 'voyage':
    case 'compat': {
      const key = process.env.FLOW_EMBEDDINGS_KEY ?? process.env.OPENAI_API_KEY ?? ''
      if (!key && !base) throw new Error('set FLOW_EMBEDDINGS_KEY, or FLOW_EMBEDDINGS_URL for a local endpoint')
      return new OpenAICompatProvider(model, key, base, outputDim)
    }
    case 'stub':
      return new StubProvider(Number(model) || 64)
    default:
      throw new Error(`Unknown embedding provider "${kind}". Use ollama, gemini, openai or stub.`)
  }
}

/**
 * Asks the provider for one vector to learn its width. Probing beats a lookup
 * table: it is right for models that did not exist when this was written, and
 * for endpoints serving something other than what their name suggests.
 */
export async function probeDimensions(provider: EmbeddingProvider): Promise<number> {
  const [vec] = await provider.embed(['flow'], 'document')
  if (!vec?.length) throw new Error('provider returned an empty vector while probing dimensions')
  provider.dimensions = vec.length
  return vec.length
}
