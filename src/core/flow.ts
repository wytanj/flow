import { q, q1 } from '../db.js'
import { embeddingsConfigured } from '../embeddings/provider.js'
import { embedEntry, vectorSearch } from '../embeddings/store.js'
import { extractUrl, fetchLinkMeta, isUrlOnly, isWeakTitle, titleFromUrl } from './enrich.js'
import { DONE_STATUSES, UNTOUCHED_STATUSES, defaultStatus, normalizeKind } from './kinds.js'

export interface Entry {
  id: string
  kind: string
  title: string | null
  body: string | null
  data: Record<string, unknown>
  tags: string[]
  status: string | null
  rating: number | null
  occurred_at: string | null
  remind_at: string | null
  source: string
  archived_at: string | null
  created_at: string
  updated_at: string
  last_checked_at: string | null
  capture_id: string | null
}

export interface Note {
  id: string
  entry_id: string
  body: string
  created_at: string
  /** me = your own thinking; research = looked up, dated and sourced. */
  source: string
}

export interface LinkedEntry {
  rel: string
  direction: 'out' | 'in'
  entry: Pick<Entry, 'id' | 'kind' | 'title' | 'status'>
}

const COLS = `id, kind, title, body, data, tags, status, rating,
  occurred_at, remind_at, source, archived_at, created_at, updated_at, last_checked_at,
  capture_id`

// pg_trgm may not be installable on every project; probe once and degrade to
// plain full-text + ILIKE if it is missing.
let trgmProbe: Promise<boolean> | null = null
function hasTrigram(): Promise<boolean> {
  trgmProbe ??= q<{ ok: boolean }>(
    `select exists (select 1 from pg_extension where extname = 'pg_trgm') as ok`,
  )
    .then((rows) => rows[0]?.ok ?? false)
    .catch(() => false)
  return trgmProbe
}

/** A one-line label for an entry that has no title of its own. */
function deriveTitle(body: string | null | undefined): string | null {
  if (!body) return null
  const firstLine = body.trim().split('\n')[0]?.trim() ?? ''
  if (!firstLine) return null
  return firstLine.length > 90 ? `${firstLine.slice(0, 87).trimEnd()}…` : firstLine
}

/**
 * Shelves nest with `/`: `ai/harness` sits under `ai`. Hyphens stay literal, so
 * `open-source` and `goodmoney` are single flat shelves — inferring hierarchy
 * from `-` would split tags nobody meant to nest.
 *
 * The parent is never stored. `ai` is implied by `ai/harness`, and matching is
 * by prefix, so there is no bookkeeping to get out of step.
 */
function cleanTags(tags?: string[] | null): string[] {
  if (!tags) return []
  const seen = new Set<string>()
  for (const t of tags) {
    const tag = t
      .trim()
      .toLowerCase()
      .replace(/^#/, '')
      .replace(/\s*\/\s*/g, '/') // "ai / harness" -> "ai/harness"
      .replace(/\/{2,}/g, '/')
      .replace(/^\/+|\/+$/g, '')
    if (tag) seen.add(tag)
  }
  return [...seen]
}

/**
 * SQL matching a shelf and everything under it. `starts_with` rather than LIKE
 * so tags containing `%` or `_` need no escaping.
 */
function shelfMatch(param: string, alias = 'e'): string {
  return `exists (select 1 from unnest(${alias}.tags) tg
                   where tg = ${param} or starts_with(tg, ${param} || '/'))`
}

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

export interface CaptureInput {
  kind?: string | null
  title?: string | null
  body?: string | null
  data?: Record<string, unknown> | null
  tags?: string[] | null
  status?: string | null
  rating?: number | null
  occurred_at?: string | null
  remind_at?: string | null
  source?: string
  /** Set false to skip fetching a link's title and description. */
  enrich?: boolean
  /**
   * Client-generated id for this capture attempt. Retrying with the same id
   * returns the entry already stored instead of creating a second one — what
   * makes an offline buffer on a phone or a device safe to flush repeatedly.
   */
  capture_id?: string | null
}

export interface CaptureResult {
  entry: Entry
  /** Existing entries of the same kind with a near-identical title, if any.
   *  Not merged automatically — surfaced so the caller can decide. */
  possible_duplicates: Pick<Entry, 'id' | 'kind' | 'title' | 'status' | 'created_at'>[]
  /** False when a capture_id replay returned the entry already stored. */
  created: boolean
}

export async function capture(input: CaptureInput): Promise<CaptureResult> {
  const captureId = input.capture_id?.trim() || null

  // Check before doing any work: a retry should be cheap, and enrichment costs
  // a network fetch we have already paid for once.
  if (captureId) {
    const already = await q1<Entry>(`select ${COLS} from flow.entries where capture_id = $1`, [captureId])
    if (already) return { entry: already, possible_duplicates: [], created: false }
  }

  let kind = normalizeKind(input.kind)
  let body = input.body?.trim() || null
  const givenTitle = input.title?.trim() || null
  let title = givenTitle || deriveTitle(body)
  const data: Record<string, unknown> = { ...(input.data ?? {}) }
  const tags = cleanTags(input.tags)

  // A shelved link: fetch what the page says about itself so the entry is
  // recognisable later, instead of being named after whatever word was nearby.
  const url = extractUrl(typeof data.url === 'string' ? data.url : null, body, title)

  // A URL on its own is enough. Callers are told to omit the title for links
  // precisely so the page can name itself, so rejecting that shape here would
  // punish them for following the instructions.
  if (!title && !body && !url) {
    throw new Error('Nothing to capture: provide a title, a body, or a URL.')
  }

  if (url && input.enrich !== false) {
    data.url = url
    // A link plus your take on it is a `reading`, not a stray thought — that is
    // the shape this store expects, and the shape the views assume.
    if (kind === 'thought') kind = 'reading'

    // Only a title the caller actually chose is protected. A title derived from
    // the body is just the first line of their commentary — that is their take
    // on the link, not the name of the thing, so the page's own title wins.
    const keepTitle = givenTitle !== null && !isWeakTitle(givenTitle, tags)

    if (!keepTitle || !data.summary) {
      const meta = await fetchLinkMeta(url)
      if (meta) {
        if (meta.title && !keepTitle) title = meta.title
        // `description` describes the link; the body stays yours alone
        if (meta.description && !data.summary) data.summary = meta.description
        if (meta.site && !data.source) data.source = meta.site
        if (meta.author && !data.author) data.author = meta.author
      }
    }

    // The URL now lives in data.url, so a body that is nothing but the URL is
    // noise where your own words should be.
    if (isUrlOnly(body)) body = null
    // A raw URL is not a name. PDFs and login walls yield no metadata, but the
    // path's last segment usually carries the title.
    if (!title) title = titleFromUrl(url) ?? url
  }

  const status = input.status?.trim() || defaultStatus(kind)

  // ON CONFLICT as well as the check above: two retries can be in flight at
  // once, and the pre-check cannot see a row that is not committed yet.
  let entry = await q1<Entry>(
    `insert into flow.entries
       (kind, title, body, data, tags, status, rating, occurred_at, remind_at, source, capture_id)
     values ($1, $2, $3, coalesce($4::jsonb, '{}'::jsonb), $5, $6, $7, $8, $9, $10, $11)
     on conflict (capture_id) where capture_id is not null do nothing
     returning ${COLS}`,
    [
      kind,
      title,
      body,
      JSON.stringify(data),
      tags,
      status,
      input.rating ?? null,
      input.occurred_at ?? null,
      input.remind_at ?? null,
      input.source ?? 'api',
      captureId,
    ],
  )

  if (!entry && captureId) {
    // lost the race — the winner's row is the answer
    const winner = await q1<Entry>(`select ${COLS} from flow.entries where capture_id = $1`, [captureId])
    if (winner) return { entry: winner, possible_duplicates: [], created: false }
  }
  if (!entry) throw new Error('capture failed')

  // Inline rather than fire-and-forget: a serverless invocation is killed the
  // moment it responds, so detached work would simply never run. embedEntry
  // swallows its own failures.
  await embedEntry(entry)

  return { entry, possible_duplicates: await findDuplicates(entry), created: true }
}

// Duplicate risk is real for named things (a person, a film) and meaningless
// for stray thoughts, so only the former get checked.
const DEDUPE_KINDS = new Set(['movie', 'person', 'place', 'reading'])

async function findDuplicates(entry: Entry) {
  if (!entry.title || !DEDUPE_KINDS.has(entry.kind)) return []
  const fuzzy = await hasTrigram()
  const predicate = fuzzy
    ? `(lower(title) = lower($2) or similarity(coalesce(title, ''), $2) > 0.55)`
    : `lower(title) = lower($2)`
  return q<Pick<Entry, 'id' | 'kind' | 'title' | 'status' | 'created_at'>>(
    `select id, kind, title, status, created_at
       from flow.entries
      where kind = $1 and id <> $3 and archived_at is null and ${predicate}
      order by created_at desc limit 5`,
    [entry.kind, entry.title, entry.id],
  ).catch(() => [])
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

export async function getEntry(id: string): Promise<
  (Entry & { notes: Note[]; links: LinkedEntry[] }) | null
> {
  const entry = await q1<Entry>(`select ${COLS} from flow.entries where id = $1`, [id])
  if (!entry) return null

  const [notes, links] = await Promise.all([
    q<Note>(
      `select id, entry_id, body, created_at, source from flow.notes
        where entry_id = $1 order by created_at asc`,
      [id],
    ),
    q<LinkedEntry>(
      `select l.rel, 'out' as direction,
              jsonb_build_object('id', e.id, 'kind', e.kind, 'title', e.title, 'status', e.status) as entry
         from flow.links l join flow.entries e on e.id = l.to_id
        where l.from_id = $1
        union all
       select l.rel, 'in' as direction,
              jsonb_build_object('id', e.id, 'kind', e.kind, 'title', e.title, 'status', e.status) as entry
         from flow.links l join flow.entries e on e.id = l.from_id
        where l.to_id = $1`,
      [id],
    ),
  ])

  return { ...entry, notes, links }
}

export interface Filters {
  kind?: string | null
  kinds?: string[] | null
  status?: string | null
  tags?: string[] | null
  /** Match entries carrying every listed tag (default) or any of them. */
  tags_mode?: 'all' | 'any'
  since?: string | null
  until?: string | null
  include_archived?: boolean
  limit?: number
  offset?: number
}

interface Where {
  sql: string
  params: unknown[]
}

function buildWhere(f: Filters, startAt = 1): Where {
  const clauses: string[] = []
  const params: unknown[] = []
  let i = startAt
  const add = (sql: string, value: unknown) => {
    clauses.push(sql.replace('$?', `$${i++}`))
    params.push(value)
  }

  const kinds = f.kinds?.length ? f.kinds.map(normalizeKind) : f.kind ? [normalizeKind(f.kind)] : null
  if (kinds) add('e.kind = any($?)', kinds)
  if (f.status) add('e.status = $?', f.status.trim())

  // One clause per shelf so each can match its own descendants; joined by AND
  // for "all" and OR for "any".
  const tags = cleanTags(f.tags)
  if (tags.length) {
    const parts = tags.map((tag) => {
      params.push(tag)
      return shelfMatch(`$${i++}`)
    })
    clauses.push(`(${parts.join(f.tags_mode === 'any' ? ' or ' : ' and ')})`)
  }
  if (f.since) add('e.created_at >= $?', f.since)
  if (f.until) add('e.created_at <= $?', f.until)
  if (!f.include_archived) clauses.push('e.archived_at is null')

  return { sql: clauses.length ? `where ${clauses.join(' and ')}` : '', params }
}

function clampLimit(limit?: number): number {
  if (!limit || limit < 1) return 25
  return Math.min(limit, 200)
}

export async function listEntries(f: Filters = {}): Promise<Entry[]> {
  const where = buildWhere(f)
  const limit = clampLimit(f.limit)
  return q<Entry>(
    `select ${COLS.split(',').map((c) => `e.${c.trim()}`).join(', ')}
       from flow.entries e ${where.sql}
      order by coalesce(e.occurred_at, e.created_at) desc
      limit ${limit} offset ${Math.max(0, f.offset ?? 0)}`,
    where.params,
  )
}

export interface SearchHit extends Entry {
  score: number
  /** Highlighted fragment of whatever matched, for showing why it came back. */
  snippet: string | null
  /** Which retriever surfaced it — useful when tuning, and honest in the UI. */
  via?: 'text' | 'vector' | 'both'
}

// Reciprocal Rank Fusion. ts_rank and cosine distance have no shared scale and
// no principled mapping between them, so fuse on rank instead of score. k=60 is
// the value from the original RRF paper and needs no tuning.
const RRF_K = 60

/**
 * Full-text and vector recall, fused. Vector search only participates when an
 * index exists for the configured provider; otherwise this is exactly the
 * full-text path, which is why flow works with no provider at all.
 */
async function hybridSearch(term: string, f: Filters, textHits: SearchHit[]): Promise<SearchHit[]> {
  if (!embeddingsConfigured()) return textHits.map((h) => ({ ...h, via: 'text' as const }))

  let vectorIds: string[] = []
  try {
    vectorIds = await vectorSearch(term, 30)
  } catch (err) {
    // recall degrading to full-text beats recall failing
    console.error('[flow:search] vector search unavailable:', err instanceof Error ? err.message : err)
    return textHits.map((h) => ({ ...h, via: 'text' as const }))
  }
  if (!vectorIds.length) return textHits.map((h) => ({ ...h, via: 'text' as const }))

  const scores = new Map<string, { score: number; text: boolean; vector: boolean }>()
  textHits.forEach((hit, i) => {
    scores.set(hit.id, { score: 1 / (RRF_K + i + 1), text: true, vector: false })
  })
  vectorIds.forEach((id, i) => {
    const prev = scores.get(id)
    if (prev) {
      prev.score += 1 / (RRF_K + i + 1)
      prev.vector = true
    } else {
      scores.set(id, { score: 1 / (RRF_K + i + 1), text: false, vector: true })
    }
  })

  // entries the vector index found that full-text missed still need loading,
  // and must honour the same filters
  const missing = vectorIds.filter((id) => !textHits.some((h) => h.id === id))
  const extra = missing.length ? await listByIds(missing, f) : []

  const all = [...textHits, ...extra.map((e) => ({ ...e, score: 0, snippet: null as string | null }))]
  return all
    .map((hit) => {
      const s = scores.get(hit.id)
      return {
        ...hit,
        score: s?.score ?? 0,
        via: (s?.text && s?.vector ? 'both' : s?.vector ? 'vector' : 'text') as SearchHit['via'],
      }
    })
    .filter((hit) => scores.has(hit.id))
    .sort((a, b) => b.score - a.score)
    .slice(0, clampLimit(f.limit))
}

/** Loads specific ids while still applying the caller's filters. */
async function listByIds(ids: string[], f: Filters): Promise<Entry[]> {
  const where = buildWhere(f, 2)
  const filter = where.sql ? where.sql.replace(/^where /, 'and ') : ''
  return q<Entry>(
    `select ${COLS.split(',').map((c) => `e.${c.trim()}`).join(', ')}
       from flow.entries e
      where e.id = any($1::uuid[]) ${filter}`,
    [ids, ...where.params],
  )
}

/**
 * Recall. Ranks full-text matches (title and tags weighted above body, body
 * above jsonb detail), blends in fuzzy title similarity so half-remembered
 * names still land, and breaks ties toward recency.
 */
export async function search(query: string, f: Filters = {}): Promise<SearchHit[]> {
  const term = query.trim()
  if (!term) return (await listEntries(f)).map((e) => ({ ...e, score: 0, snippet: null }))

  const fuzzy = await hasTrigram()
  const where = buildWhere(f, 3) // $1 = term, $2 = tsquery-ready term
  const filter = where.sql ? where.sql.replace(/^where /, 'and ') : ''

  const trgmScore = fuzzy ? `similarity(coalesce(e.title, ''), $1)` : `0::real`
  const trgmMatch = fuzzy ? `or similarity(coalesce(e.title, ''), $1) > 0.3` : ''

  const rows = await q<SearchHit>(
    `with tsq as (select websearch_to_tsquery('english', $2) as q)
     select ${COLS.split(',').map((c) => `e.${c.trim()}`).join(', ')},
            (ts_rank_cd(e.search, tsq.q) * 4 + ${trgmScore}
              + case when e.title ilike '%' || $1 || '%' then 0.5 else 0 end)::real as score,
            nullif(ts_headline('english',
              coalesce(e.title, '') || ' — ' || coalesce(e.body, ''),
              tsq.q,
              'MaxFragments=1, MaxWords=28, MinWords=8, StartSel=**, StopSel=**'), '') as snippet
       from flow.entries e, tsq
      where (e.search @@ tsq.q
             or e.title ilike '%' || $1 || '%'
             or e.body ilike '%' || $1 || '%'
             ${trgmMatch})
        ${filter}
      order by score desc, coalesce(e.occurred_at, e.created_at) desc
      limit ${clampLimit(f.limit)}`,
    [term, term, ...where.params],
  )
  return hybridSearch(term, f, rows)
}

/**
 * Accepts a full uuid, a short id prefix (as printed in listings), or an exact
 * title — so "mark Dune as watched" works without a round trip to look up ids.
 * Throws when a reference is ambiguous rather than guessing.
 */
export async function resolveId(ref: string): Promise<string> {
  const s = ref.trim()
  if (!s) throw new Error('No entry reference given.')
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return s.toLowerCase()

  const rows = /^[0-9a-f]{4,}$/i.test(s)
    ? await q<{ id: string; title: string | null }>(
        `select id, title from flow.entries where id::text like $1 || '%' limit 5`,
        [s.toLowerCase()],
      )
    : await q<{ id: string; title: string | null }>(
        `select id, title from flow.entries
          where archived_at is null and lower(title) = lower($1)
          order by created_at desc limit 5`,
        [s],
      )

  if (!rows.length) throw new Error(`No entry matches "${ref}". Search for it first.`)
  if (rows.length > 1) {
    const options = rows.map((r) => `${r.id.slice(0, 8)} (${r.title ?? 'untitled'})`).join(', ')
    throw new Error(`"${ref}" is ambiguous — matches ${options}. Use a full id.`)
  }
  return rows[0]!.id
}

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

export interface UpdateInput {
  kind?: string | null
  title?: string | null
  body?: string | null
  /** Shallow-merged into existing data; null values delete their key. */
  data?: Record<string, unknown> | null
  tags?: string[] | null
  add_tags?: string[] | null
  status?: string | null
  rating?: number | null
  occurred_at?: string | null
  remind_at?: string | null
  archived?: boolean | null
}

export async function updateEntry(id: string, patch: UpdateInput): Promise<Entry | null> {
  const sets: string[] = []
  const params: unknown[] = []
  let i = 1
  const set = (sql: string, value: unknown) => {
    sets.push(sql.replace('$?', `$${i++}`))
    params.push(value)
  }

  if (patch.kind !== undefined && patch.kind !== null) set('kind = $?', normalizeKind(patch.kind))
  if (patch.title !== undefined) set('title = $?', patch.title)
  if (patch.body !== undefined) set('body = $?', patch.body)
  if (patch.status !== undefined) set('status = $?', patch.status)
  if (patch.rating !== undefined) set('rating = $?', patch.rating)
  if (patch.occurred_at !== undefined) set('occurred_at = $?', patch.occurred_at)
  if (patch.remind_at !== undefined) set('remind_at = $?', patch.remind_at)
  if (patch.tags !== undefined && patch.tags !== null) set('tags = $?', cleanTags(patch.tags))
  if (patch.add_tags?.length) {
    // union, preserving order and dropping repeats
    set(
      `tags = (select coalesce(array_agg(distinct t), '{}') from unnest(tags || $?::text[]) as t)`,
      cleanTags(patch.add_tags),
    )
  }
  if (patch.data !== undefined && patch.data !== null) {
    // strip_nulls lets a caller remove a key by setting it to null
    set(`data = jsonb_strip_nulls(data || $?::jsonb)`, JSON.stringify(patch.data))
  }
  if (patch.archived !== undefined && patch.archived !== null) {
    sets.push(`archived_at = ${patch.archived ? 'now()' : 'null'}`)
  }

  if (!sets.length) return q1<Entry>(`select ${COLS} from flow.entries where id = $1`, [id])

  params.push(id)
  const entry = await q1<Entry>(
    `update flow.entries set ${sets.join(', ')} where id = $${i} returning ${COLS}`,
    params,
  )
  if (entry) await embedEntry(entry)
  return entry
}

/** `source` marks provenance: 'me' is your own thinking, 'research' is looked up. */
export async function addNote(entryId: string, body: string, source = 'me'): Promise<Note> {
  const text = body.trim()
  if (!text) throw new Error('Note body is empty.')
  const note = await q1<Note>(
    `insert into flow.notes (entry_id, body, source) values ($1, $2, $3)
     returning id, entry_id, body, created_at, source`,
    [entryId, text, source],
  )
  if (!note) throw new Error('note failed')
  return note
}

export async function linkEntries(fromId: string, toId: string, rel = 'related') {
  if (fromId === toId) throw new Error('Cannot link an entry to itself.')
  return q1(
    `insert into flow.links (from_id, to_id, rel) values ($1, $2, $3)
     on conflict (from_id, to_id, rel) do update set rel = excluded.rel
     returning id, from_id, to_id, rel, created_at`,
    [fromId, toId, rel.trim() || 'related'],
  )
}

export async function deleteEntry(id: string): Promise<boolean> {
  const row = await q1<{ id: string }>(`delete from flow.entries where id = $1 returning id`, [id])
  return row !== null
}

// ---------------------------------------------------------------------------
// resurfacing
// ---------------------------------------------------------------------------

/** Reminders that have come due, plus anything due within `withinDays`. */
export async function due(withinDays = 0, limit = 50): Promise<Entry[]> {
  return q<Entry>(
    `select ${COLS} from flow.entries
      where archived_at is null
        and remind_at is not null
        and remind_at <= now() + make_interval(days => $1)
      order by remind_at asc limit $2`,
    [Math.max(0, withinDays), clampLimit(limit)],
  )
}

/** Everything still outstanding for a kind — the watchlist, the open tasks. */
export async function open(kind: string, limit = 50): Promise<Entry[]> {
  return q<Entry>(
    `select ${COLS} from flow.entries
      where kind = $1 and archived_at is null
        and (status is null or status <> all($2::text[]))
      order by coalesce(occurred_at, created_at) desc limit $3`,
    [normalizeKind(kind), DONE_STATUSES, clampLimit(limit)],
  )
}

/**
 * Renames a shelf everywhere at once. Merging into an existing shelf is fine —
 * duplicates are collapsed rather than rejected.
 *
 * Note this bumps `updated_at` on every entry touched (the tag change refreshes
 * the search vector), so their embeddings go stale and the next sync re-embeds
 * them. That is correct: the tag is part of what gets embedded.
 */
export async function renameShelf(from: string, to: string): Promise<Entry[]> {
  const [oldTag] = cleanTags([from])
  const [newTag] = cleanTags([to])
  if (!oldTag || !newTag) throw new Error('Both the old and new shelf names are required.')
  if (oldTag === newTag) return []

  // Renaming a shelf takes everything under it: ai -> models turns
  // ai/harness into models/harness. Leaving descendants behind would orphan them.
  return q<Entry>(
    `update flow.entries e
        set tags = (select coalesce(array_agg(distinct
                      case when t = $1 then $2
                           when starts_with(t, $1 || '/') then $2 || substr(t, length($1) + 1)
                           else t end), '{}')
                      from unnest(e.tags) as t)
      where ${shelfMatch('$1')}
      returning ${COLS}`,
    [oldTag, newTag],
  )
}

export interface Shelf {
  tag: string
  /** Entries on this shelf *or any shelf under it*. */
  count: number
  /** Entries tagged with exactly this, not a descendant. */
  own: number
  depth: number
  parent: string | null
  label: string
}

/**
 * Every shelf as a tree. Parents are synthesised from their children, so `ai`
 * appears with a rolled-up count even if nothing was ever tagged plainly `ai`
 * — otherwise nesting something would make its group vanish from the list.
 */
export async function shelves(): Promise<Shelf[]> {
  const rows = await q<{ tag: string; count: number; own: number }>(
    `with tagged as (
       select distinct t as tag, e.id
         from flow.entries e, unnest(e.tags) as t
        where e.archived_at is null
     ),
     nodes as (
       select tag as node, id from tagged
       union
       -- every ancestor path: ai/harness/mcp also counts toward ai/harness and ai
       select array_to_string((string_to_array(tag, '/'))[1:i], '/'), id
         from tagged,
              generate_series(1, coalesce(array_length(string_to_array(tag, '/'), 1), 1) - 1) as i
     )
     select n.node as tag,
            count(distinct n.id)::int as count,
            (select count(distinct t2.id)::int from tagged t2 where t2.tag = n.node) as own
       from nodes n
      where n.node <> ''
      group by n.node
      order by n.node asc`,
  )

  return rows.map((r) => {
    const parts = r.tag.split('/')
    return {
      ...r,
      depth: parts.length - 1,
      parent: parts.length > 1 ? parts.slice(0, -1).join('/') : null,
      label: parts[parts.length - 1] ?? r.tag,
    }
  })
}

export interface Stats {
  total: number
  by_kind: { kind: string; count: number; open: number }[]
  captured_last_7_days: number
  due_now: number
  top_tags: { tag: string; count: number }[]
}

export async function stats(): Promise<Stats> {
  const [totals, byKind, recent, dueNow, tags] = await Promise.all([
    q1<{ n: number }>(`select count(*)::int as n from flow.entries where archived_at is null`),
    q<{ kind: string; count: number; open: number }>(
      // "open" only counts kinds that actually have a lifecycle — a person
      // without a status is not an outstanding item.
      `select kind, count(*)::int as count,
              count(*) filter (where status is not null and status <> all($1::text[]))::int as open
         from flow.entries where archived_at is null
        group by kind order by count desc`,
      [DONE_STATUSES],
    ),
    q1<{ n: number }>(
      `select count(*)::int as n from flow.entries where created_at > now() - interval '7 days'`,
    ),
    q1<{ n: number }>(
      `select count(*)::int as n from flow.entries
        where archived_at is null and remind_at is not null and remind_at <= now()`,
    ),
    q<{ tag: string; count: number }>(
      `select t as tag, count(*)::int as count
         from flow.entries e, unnest(e.tags) as t
        where e.archived_at is null
        group by t order by count desc limit 15`,
    ),
  ])

  return {
    total: totals?.n ?? 0,
    by_kind: byKind,
    captured_last_7_days: recent?.n ?? 0,
    due_now: dueNow?.n ?? 0,
    top_tags: tags,
  }
}

/**
 * Things collected elsewhere and not yet engaged with — starred repos, imported
 * bookmarks. Kept separate from authored memories so they cannot bury them.
 */
export async function untouchedImports(limit = 8): Promise<Entry[]> {
  return q<Entry>(
    `select ${COLS} from flow.entries
      where archived_at is null and status = any($1::text[])
      order by coalesce(occurred_at, created_at) desc limit $2`,
    [UNTOUCHED_STATUSES, clampLimit(limit)],
  )
}

/** A short orientation digest: what is due, what is new, what is outstanding. */
export async function briefing() {
  const [dueItems, recent, watchlist, tasks, people, collected] = await Promise.all([
    due(0, 10),
    // "Recent" means recently *engaged with*, not recently created. A repo
    // starred two years ago that you commented on this morning belongs here;
    // ordering by occurred_at alone would hide it. Untouched imports are
    // excluded, so the 51 stars just synced cannot flood it.
    q<Entry>(
      `select ${COLS} from flow.entries
        where archived_at is null and (status is null or status <> all($1::text[]))
        order by greatest(updated_at, coalesce(occurred_at, created_at)) desc limit 10`,
      [UNTOUCHED_STATUSES],
    ),
    open('movie', 8),
    open('task', 10),
    listEntries({ kind: 'person', limit: 5 }),
    untouchedImports(6),
  ])
  return {
    due: dueItems,
    recent,
    watchlist,
    open_tasks: tasks,
    recent_people: people,
    collected,
    stats: await stats(),
  }
}
