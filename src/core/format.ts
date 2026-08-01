import type { Entry, Note, SearchHit } from './flow.js'

// Renderers used by the MCP server and the CLI. Model-facing output is compact
// markdown rather than raw JSON: fewer tokens, and the ids stay copy-able.

function shortId(id: string): string {
  return id.slice(0, 8)
}

function day(ts: string | null): string {
  return ts ? ts.slice(0, 10) : ''
}

function meta(e: Entry): string {
  const bits: string[] = [e.kind]
  if (e.status) bits.push(e.status)
  if (e.rating != null) bits.push(`${e.rating}/10`)
  if (e.tags.length) bits.push(e.tags.map((t) => `#${t}`).join(' '))
  const when = day(e.occurred_at ?? e.created_at)
  if (when) bits.push(when)
  if (e.remind_at) bits.push(`⏰ ${day(e.remind_at)}`)
  if (e.archived_at) bits.push('archived')
  return bits.join(' · ')
}

function dataLine(e: Entry): string {
  const pairs = Object.entries(e.data ?? {}).filter(([, v]) => v !== null && v !== '')
  if (!pairs.length) return ''
  return pairs.map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' | ')
}

export function formatEntryLine(e: Entry & { snippet?: string | null }): string {
  const head = `- [${shortId(e.id)}] ${e.title ?? '(untitled)'} — ${meta(e)}`
  const extra: string[] = []
  const d = dataLine(e)
  if (d) extra.push(`  ${d}`)
  const snippet = e.snippet?.replace(/\s+/g, ' ').trim()
  if (snippet) extra.push(`  ${snippet}`)
  else if (e.body) {
    const b = e.body.replace(/\s+/g, ' ').trim()
    extra.push(`  ${b.length > 160 ? `${b.slice(0, 157)}…` : b}`)
  }
  return [head, ...extra].join('\n')
}

export function formatList(entries: (Entry & { snippet?: string | null })[], empty = 'Nothing found.'): string {
  if (!entries.length) return empty
  return entries.map(formatEntryLine).join('\n')
}

export function formatSearch(query: string, hits: SearchHit[]): string {
  if (!hits.length) return `No matches for "${query}".`
  return `${hits.length} match${hits.length === 1 ? '' : 'es'} for "${query}":\n${formatList(hits)}`
}

export function formatEntryFull(
  e: Entry & { notes: Note[]; links: { rel: string; direction: string; entry: { id: string; kind: string; title: string | null; status: string | null } }[] },
): string {
  const lines = [`# ${e.title ?? '(untitled)'}`, `id: ${e.id}`, meta(e)]
  const d = dataLine(e)
  if (d) lines.push('', d)
  if (e.body) lines.push('', e.body)
  if (e.notes.length) {
    lines.push('', `## notes (${e.notes.length})`)
    for (const n of e.notes) lines.push(`- ${day(n.created_at)} — ${n.body}`)
  }
  if (e.links.length) {
    lines.push('', '## linked')
    for (const l of e.links) {
      const arrow = l.direction === 'out' ? '→' : '←'
      lines.push(`- ${arrow} ${l.rel}: [${shortId(l.entry.id)}] ${l.entry.title ?? '(untitled)'} (${l.entry.kind})`)
    }
  }
  return lines.join('\n')
}
