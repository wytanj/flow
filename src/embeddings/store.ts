/**
 * The vector index.
 *
 * Deliberately a side table, never a column on `flow.entries`. Vectors are
 * derived state: they can be dropped and rebuilt from the entries at any time,
 * which is what makes switching provider a non-event rather than a migration
 * against the table holding someone's life.
 *
 * A provider change is detected, not accommodated. Vectors from two models do
 * not share a space, so mixing them silently degrades every result — the sync
 * refuses and tells you to rebuild.
 */
import { q, q1 } from '../db.js'
import type { Entry } from '../core/flow.js'
import { type EmbeddingProvider, getProvider, probeDimensions } from './provider.js'

export interface IndexConfig {
  provider: string
  dimensions: number
  indexed: boolean
  created_at: string
}

export interface IndexStatus {
  enabled: boolean
  configured_provider: string | null
  index?: IndexConfig
  total_entries: number
  embedded: number
  stale: number
  provider_mismatch: boolean
  ready: boolean
  note?: string
}

// pgvector can build an ANN index up to 2000 dimensions. Beyond that we simply
// do not create one — an exact scan over a personal store is milliseconds.
const MAX_INDEXABLE_DIMS = 2000

async function tableExists(): Promise<boolean> {
  const row = await q1<{ ok: boolean }>(
    `select exists (
       select 1 from information_schema.tables
        where table_schema = 'flow' and table_name = 'embeddings'
     ) as ok`,
  )
  return row?.ok ?? false
}

export async function readConfig(): Promise<IndexConfig | null> {
  if (!(await tableExists())) return null
  return q1<IndexConfig>(
    `select provider, dimensions, indexed, created_at from flow.embedding_config where id`,
  )
}

/**
 * Creates the extension, the table sized to this provider, and the ANN index.
 * Idempotent unless the provider changed, which requires `rebuild`.
 */
export async function initIndex(opts: { rebuild?: boolean } = {}): Promise<IndexConfig> {
  const provider = getProvider()
  if (!provider) throw new Error('FLOW_EMBEDDINGS is not set — nothing to initialise.')

  await q('create extension if not exists vector')

  const dims = await probeDimensions(provider)
  if (!Number.isInteger(dims) || dims < 1 || dims > 16000) {
    throw new Error(`Provider reported an implausible dimension count: ${dims}`)
  }

  const existing = await readConfig()
  if (existing && !opts.rebuild) {
    if (existing.provider !== provider.id || existing.dimensions !== dims) {
      throw new Error(
        `Index was built with ${existing.provider} (${existing.dimensions}d) but ` +
          `${provider.id} (${dims}d) is configured. Vectors from different models are not ` +
          `comparable — rebuild with: npm run embeddings:sync -- --rebuild`,
      )
    }
    return existing
  }

  if (opts.rebuild) {
    await q('drop table if exists flow.embeddings')
    await q('drop table if exists flow.embedding_config')
  }

  // dims is an integer we just validated, not caller input
  await q(`create table if not exists flow.embeddings (
    entry_id          uuid primary key references flow.entries(id) on delete cascade,
    provider          text not null,
    vec               vector(${dims}) not null,
    source_updated_at timestamptz not null,
    embedded_at       timestamptz not null default now()
  )`)

  const indexed = dims <= MAX_INDEXABLE_DIMS
  if (indexed) {
    // cosine, to match the normalised vectors every provider here returns
    await q(`create index if not exists embeddings_vec_idx
               on flow.embeddings using hnsw (vec vector_cosine_ops)`)
  }

  await q(`create table if not exists flow.embedding_config (
    id         bool primary key default true check (id),
    provider   text not null,
    dimensions int  not null,
    indexed    bool not null default true,
    created_at timestamptz not null default now()
  )`)
  await q(
    `insert into flow.embedding_config (id, provider, dimensions, indexed)
     values (true, $1, $2, $3)
     on conflict (id) do update set provider = excluded.provider,
       dimensions = excluded.dimensions, indexed = excluded.indexed, created_at = now()`,
    [provider.id, dims, indexed],
  )

  const config = await readConfig()
  if (!config) throw new Error('failed to record embedding config')
  return config
}

/**
 * What gets embedded. Title and tags carry disproportionate signal for a
 * personal store, and notes hold the later thinking, so all of it goes in.
 */
export function embeddingText(e: Entry & { notes?: { body: string }[] }): string {
  const parts = [e.title ?? '', e.kind]
  if (e.tags?.length) parts.push(e.tags.join(' '))
  if (e.body) parts.push(e.body)
  for (const [k, v] of Object.entries(e.data ?? {})) {
    if (v != null && v !== '' && k !== 'url') parts.push(`${k}: ${String(v)}`)
  }
  for (const n of e.notes ?? []) parts.push(n.body)
  return parts.filter(Boolean).join('\n').slice(0, 8_000)
}

const toVectorLiteral = (v: number[]) => `[${v.join(',')}]`

async function writeVectors(
  provider: EmbeddingProvider,
  rows: { id: string; text: string; updated_at: string }[],
): Promise<number> {
  if (!rows.length) return 0
  const vectors = await provider.embed(rows.map((r) => r.text), 'document')
  if (vectors.length !== rows.length) {
    throw new Error(`provider returned ${vectors.length} vectors for ${rows.length} inputs`)
  }
  for (const [i, row] of rows.entries()) {
    await q(
      `insert into flow.embeddings (entry_id, provider, vec, source_updated_at)
       values ($1, $2, $3::vector, $4)
       on conflict (entry_id) do update set
         provider = excluded.provider, vec = excluded.vec,
         source_updated_at = excluded.source_updated_at, embedded_at = now()`,
      [row.id, provider.id, toVectorLiteral(vectors[i]!), row.updated_at],
    )
  }
  return rows.length
}

/**
 * Embeds one entry inline on capture or update. Best-effort by design: a
 * provider being down must never stop a thought being saved.
 */
export async function embedEntry(entry: Entry): Promise<boolean> {
  const provider = getProvider()
  if (!provider) return false
  try {
    if (!(await readConfig())) return false
    await writeVectors(provider, [
      { id: entry.id, text: embeddingText(entry), updated_at: entry.updated_at },
    ])
    return true
  } catch (err) {
    console.error('[flow:embeddings] inline embed failed:', err instanceof Error ? err.message : err)
    return false
  }
}

/**
 * Brings the index up to date: anything never embedded, anything edited since
 * it was embedded, anything embedded by a different provider.
 */
export async function sync(opts: { rebuild?: boolean; onProgress?: (done: number, total: number) => void } = {}) {
  const provider = getProvider()
  if (!provider) throw new Error('FLOW_EMBEDDINGS is not set.')

  const config = await initIndex({ rebuild: opts.rebuild })
  provider.dimensions = config.dimensions

  // notes and edits both bump entries.updated_at (the search-vector refresh
  // fires the touch trigger), so this one comparison catches every change
  const pending = await q<{ id: string; updated_at: string }>(
    `select e.id, e.updated_at
       from flow.entries e
       left join flow.embeddings m on m.entry_id = e.id
      where e.archived_at is null
        and (m.entry_id is null
             or m.provider <> $1
             or m.source_updated_at < e.updated_at)
      order by e.updated_at desc`,
    [config.provider],
  )

  let done = 0
  for (let i = 0; i < pending.length; i += provider.batchSize) {
    const slice = pending.slice(i, i + provider.batchSize)
    const full = await q<Entry & { notes: { body: string }[] }>(
      `select e.*, coalesce(
                (select json_agg(json_build_object('body', n.body) order by n.created_at)
                   from flow.notes n where n.entry_id = e.id), '[]'::json) as notes
         from flow.entries e where e.id = any($1::uuid[])`,
      [slice.map((s) => s.id)],
    )
    await writeVectors(
      provider,
      full.map((e) => ({ id: e.id, text: embeddingText(e), updated_at: e.updated_at })),
    )
    done += full.length
    opts.onProgress?.(done, pending.length)
  }

  // entries deleted while archived leave nothing behind; archived ones do
  await q(`delete from flow.embeddings m
            using flow.entries e
            where m.entry_id = e.id and e.archived_at is not null`)

  return { embedded: done, total: pending.length, provider: config.provider, dimensions: config.dimensions }
}

export async function status(): Promise<IndexStatus> {
  const spec = process.env.FLOW_EMBEDDINGS?.trim() || null
  const totals = await q1<{ n: number }>(
    `select count(*)::int as n from flow.entries where archived_at is null`,
  )
  const total_entries = totals?.n ?? 0

  if (!spec) {
    return {
      enabled: false, configured_provider: null, total_entries, embedded: 0, stale: 0,
      provider_mismatch: false, ready: false,
      note: 'FLOW_EMBEDDINGS is not set — recall is full-text only.',
    }
  }

  const config = await readConfig()
  if (!config) {
    return {
      enabled: true, configured_provider: spec, total_entries, embedded: 0, stale: 0,
      provider_mismatch: false, ready: false,
      note: 'Index not built yet — run: npm run embeddings:sync',
    }
  }

  const counts = await q1<{ embedded: number; stale: number; foreign: number }>(
    `select count(*) filter (where m.entry_id is not null)::int as embedded,
            count(*) filter (where m.entry_id is not null and m.source_updated_at < e.updated_at)::int as stale,
            count(*) filter (where m.entry_id is not null and m.provider <> $1)::int as foreign
       from flow.entries e left join flow.embeddings m on m.entry_id = e.id
      where e.archived_at is null`,
    [config.provider],
  )

  let provider_mismatch = false
  try {
    provider_mismatch = getProvider()?.id !== config.provider
  } catch {
    provider_mismatch = true
  }

  return {
    enabled: true,
    configured_provider: spec,
    index: config,
    total_entries,
    embedded: counts?.embedded ?? 0,
    stale: (counts?.stale ?? 0) + (counts?.foreign ?? 0),
    provider_mismatch,
    ready: !provider_mismatch && (counts?.embedded ?? 0) > 0,
    note: provider_mismatch
      ? `Configured provider differs from the index (${config.provider}). Rebuild: npm run embeddings:sync -- --rebuild`
      : undefined,
  }
}

/**
 * Nearest neighbours have no notion of "no match" — ask for 30 and you get 30,
 * however unrelated, so without a cutoff every query returns the whole store.
 *
 * Two filters, because they reject different things:
 *
 *   ceiling  "is this plausibly related at all?"  — kills unrelated and gibberish
 *   margin   "is this as good as the best hit?"   — kills the long tail behind a good match
 *
 * The ceiling has to be per-model. Measured against this store, Gemini's space
 * is far more compressed than the textbook one: on-topic 0.32–0.34, gibberish
 * 0.43, unrelated real text 0.48–0.57 — so the usual 0.6 admits everything.
 * The margin is relative and needs no such calibration, which is what makes it
 * worth having for models nobody has measured.
 *
 * These defaults were tuned on a small corpus and are a starting point, not a
 * law; both are overridable, and worth revisiting as the store grows.
 */
function tuning(providerId: string) {
  const ceilingEnv = Number(process.env.FLOW_EMBEDDINGS_MAX_DISTANCE)
  const marginEnv = Number(process.env.FLOW_EMBEDDINGS_MARGIN)
  return {
    ceiling: Number.isFinite(ceilingEnv) && ceilingEnv > 0
      ? ceilingEnv
      : /^gemini:/.test(providerId) ? 0.42 : 0.6,
    margin: Number.isFinite(marginEnv) && marginEnv > 0 ? marginEnv : 0.08,
  }
}

/** Nearest neighbours by cosine distance, in rank order. */
export async function vectorSearch(query: string, limit = 30): Promise<string[]> {
  const provider = getProvider()
  if (!provider) return []
  const config = await readConfig()
  if (!config) return []
  if (provider.id !== config.provider) return [] // mismatched space — worse than nothing

  const [vec] = await provider.embed([query], 'query')
  if (!vec) return []

  const { ceiling, margin } = tuning(provider.id)
  const rows = await q<{ entry_id: string; dist: number }>(
    `select m.entry_id, (m.vec <=> $1::vector)::float8 as dist
       from flow.embeddings m
       join flow.entries e on e.id = m.entry_id
      where e.archived_at is null
        and (m.vec <=> $1::vector) < $2
      order by dist
      limit $3`,
    [toVectorLiteral(vec), ceiling, limit],
  )
  if (!rows.length) return []

  const best = rows[0]!.dist
  return rows.filter((r) => r.dist <= best + margin).map((r) => r.entry_id)
}
