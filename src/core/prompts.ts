/**
 * Prompt logging.
 *
 * Entries record what you remembered; this records *how you asked*. The two
 * answer different questions — the store tells you what is on the crypto shelf,
 * the log tells you that links arrive with a reason attached about a third of
 * the time, which is the thing worth changing.
 *
 * Logged verbatim and before interpretation, because the phrasing is the data.
 * Writing is best-effort: a logging failure must never cost a capture.
 *
 * Set FLOW_LOG_PROMPTS=off to disable. The log lives in your own database and
 * goes nowhere else, but it is a record of everything you say to flow, so it
 * deserves the same care as the entries themselves.
 */
import { q, q1 } from '../db.js'
import type { Entry } from './flow.js'

export type Surface = 'web' | 'api' | 'cli' | 'telegram' | 'mcp'

export interface PromptLog {
  id: string
  at: string
  surface: string
  action: string
  input: string | null
  entry_ids: string[]
  tags: string[]
  kinds: string[]
  ms: number | null
  ok: boolean
  error: string | null
}

export function loggingEnabled(): boolean {
  return (process.env.FLOW_LOG_PROMPTS ?? 'on').toLowerCase() !== 'off'
}

export async function logPrompt(p: {
  surface: Surface
  action: string
  input?: string | null
  entries?: Pick<Entry, 'id' | 'kind' | 'tags'>[]
  ms?: number
  ok?: boolean
  error?: string | null
}): Promise<void> {
  if (!loggingEnabled()) return
  try {
    const entries = p.entries ?? []
    await q(
      `insert into flow.prompts (surface, action, input, entry_ids, tags, kinds, ms, ok, error)
       values ($1, $2, $3, $4::uuid[], $5, $6, $7, $8, $9)`,
      [
        p.surface,
        p.action,
        p.input?.slice(0, 8000) ?? null,
        entries.map((e) => e.id),
        [...new Set(entries.flatMap((e) => e.tags ?? []))],
        [...new Set(entries.map((e) => e.kind))],
        p.ms ?? null,
        p.ok ?? true,
        p.error?.slice(0, 500) ?? null,
      ],
    )
  } catch (err) {
    console.error('[flow:prompts] log failed:', err instanceof Error ? err.message : err)
  }
}

/** Wraps a surface handler so every call is timed and recorded, pass or fail. */
export async function logged<T>(
  meta: { surface: Surface; action: string; input?: string | null },
  run: () => Promise<T>,
  entriesOf: (result: T) => Pick<Entry, 'id' | 'kind' | 'tags'>[] = () => [],
): Promise<T> {
  const started = Date.now()
  try {
    const result = await run()
    // Awaited, not detached: a serverless invocation is killed the moment it
    // responds, so a fire-and-forget insert would simply never land. One row,
    // and logPrompt swallows its own errors, so it cannot cost the caller.
    await logPrompt({ ...meta, entries: entriesOf(result), ms: Date.now() - started })
    return result
  } catch (err) {
    await logPrompt({
      ...meta,
      ms: Date.now() - started,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

export async function recentPrompts(limit = 50, surface?: string): Promise<PromptLog[]> {
  return q<PromptLog>(
    `select id, at, surface, action, input, entry_ids, tags, kinds, ms, ok, error
       from flow.prompts
      ${surface ? 'where surface = $2' : ''}
      order by at desc limit $1`,
    surface ? [Math.min(limit, 500), surface] : [Math.min(limit, 500)],
  )
}

export interface PromptPatterns {
  total: number
  since: string | null
  by_surface: { surface: string; n: number }[]
  by_action: { action: string; n: number }[]
  length: { median: number; p90: number; shortest: number; longest: number }
  /** The habits worth knowing about, as percentages of capture-type prompts. */
  habits: {
    captures: number
    with_url: number
    url_with_reason: number
    bare_url: number
    with_hashtags: number
    multi_entry: number
  }
  top_shelves: { tag: string; n: number }[]
  by_hour: { hour: number; n: number }[]
  failures: { action: string; error: string; n: number }[]
}

const CAPTURE_ACTIONS = ['jot', 'capture', 'flow_capture', 'flow_capture_many', 'telegram_capture']

/**
 * The digest. Deliberately opinionated about which numbers matter: the one
 * that predicts whether a memory is worth anything later is whether a link
 * arrived with a reason attached.
 */
export async function promptPatterns(): Promise<PromptPatterns> {
  const [totals, bySurface, byAction, lengths, habits, shelves, hours, failures] = await Promise.all([
    q1<{ n: number; since: string | null }>(
      `select count(*)::int as n, min(at)::text as since from flow.prompts`,
    ),
    q<{ surface: string; n: number }>(
      `select surface, count(*)::int as n from flow.prompts group by surface order by n desc`,
    ),
    q<{ action: string; n: number }>(
      `select action, count(*)::int as n from flow.prompts group by action order by n desc`,
    ),
    q1<{ median: number; p90: number; shortest: number; longest: number }>(
      `select coalesce(percentile_cont(0.5) within group (order by length(input)), 0)::int as median,
              coalesce(percentile_cont(0.9) within group (order by length(input)), 0)::int as p90,
              coalesce(min(length(input)), 0) as shortest,
              coalesce(max(length(input)), 0) as longest
         from flow.prompts where input is not null`,
    ),
    q1<{
      captures: number; with_url: number; url_with_reason: number
      bare_url: number; with_hashtags: number; multi_entry: number
    }>(
      `select count(*)::int as captures,
              count(*) filter (where input ~* 'https?://')::int as with_url,
              -- a URL plus at least 25 characters of anything else
              count(*) filter (where input ~* 'https?://'
                and length(regexp_replace(input, 'https?://\\S+', '', 'g')) > 25)::int as url_with_reason,
              count(*) filter (where input ~* 'https?://'
                and length(regexp_replace(input, 'https?://\\S+', '', 'g')) <= 25)::int as bare_url,
              count(*) filter (where input ~ '(^|\\s)#[[:alnum:]]')::int as with_hashtags,
              count(*) filter (where array_length(entry_ids, 1) > 1)::int as multi_entry
         from flow.prompts
        where action = any($1::text[]) and input is not null`,
      [CAPTURE_ACTIONS],
    ),
    q<{ tag: string; n: number }>(
      `select t as tag, count(*)::int as n
         from flow.prompts p, unnest(p.tags) as t
        group by t order by n desc limit 12`,
    ),
    q<{ hour: number; n: number }>(
      `select extract(hour from at)::int as hour, count(*)::int as n
         from flow.prompts group by 1 order by 1`,
    ),
    q<{ action: string; error: string; n: number }>(
      `select action, coalesce(error, '?') as error, count(*)::int as n
         from flow.prompts where not ok group by 1, 2 order by n desc limit 10`,
    ),
  ])

  return {
    total: totals?.n ?? 0,
    since: totals?.since ?? null,
    by_surface: bySurface,
    by_action: byAction,
    length: lengths ?? { median: 0, p90: 0, shortest: 0, longest: 0 },
    habits: habits ?? {
      captures: 0, with_url: 0, url_with_reason: 0, bare_url: 0, with_hashtags: 0, multi_entry: 0,
    },
    top_shelves: shelves,
    by_hour: hours,
    failures,
  }
}

/** Human-readable digest, for the CLI and the MCP tool. */
export function formatPatterns(p: PromptPatterns): string {
  if (!p.total) return 'No prompts logged yet.'
  const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '—')
  const h = p.habits
  const lines = [
    `${p.total} prompts logged since ${p.since?.slice(0, 10) ?? '?'}`,
    `surfaces: ${p.by_surface.map((s) => `${s.surface} ${s.n}`).join(' · ')}`,
    `actions:  ${p.by_action.map((a) => `${a.action} ${a.n}`).join(' · ')}`,
    `length:   median ${p.length.median} chars, p90 ${p.length.p90}, longest ${p.length.longest}`,
    '',
    `captures: ${h.captures}`,
    `  contain a link          ${h.with_url} (${pct(h.with_url, h.captures)})`,
    `  link WITH your reason   ${h.url_with_reason} (${pct(h.url_with_reason, h.with_url)} of links)`,
    `  bare link, no reason    ${h.bare_url} (${pct(h.bare_url, h.with_url)} of links)`,
    `  used #hashtags          ${h.with_hashtags} (${pct(h.with_hashtags, h.captures)})`,
    `  produced >1 entry       ${h.multi_entry}`,
  ]
  if (p.top_shelves.length) {
    lines.push('', `shelves reached for: ${p.top_shelves.map((s) => `${s.tag} ${s.n}`).join(' · ')}`)
  }
  if (p.by_hour.length) {
    const peak = [...p.by_hour].sort((a, b) => b.n - a.n)[0]!
    lines.push(`busiest hour: ${String(peak.hour).padStart(2, '0')}:00 (${peak.n})`)
  }
  if (p.failures.length) {
    lines.push('', 'failures:')
    for (const f of p.failures) lines.push(`  ${f.n}× ${f.action}: ${f.error.slice(0, 70)}`)
  }
  return lines.join('\n')
}
