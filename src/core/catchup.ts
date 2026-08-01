/**
 * "What's up with these guys?"
 *
 * Re-reads an entry's link and asks the world what has changed since you last
 * looked, then writes the answer into your memory as a dated, sourced note.
 *
 * Three rules, all of them deliberate:
 *
 *   1. **Append only.** Nothing here rewrites a title, body, tag or shelf.
 *      Where a thing sits is your judgement about what it is to you, and a web
 *      search does not get to overrule that. Identity changes are reported in
 *      the note for you to act on, not applied.
 *   2. **Silence is a valid result.** If nothing has happened, it records the
 *      check and writes no note. A memory full of "nothing changed" is worse
 *      than one that is quiet.
 *   3. **Your words stay yours.** Research notes carry source='research' so
 *      they are never mistaken for something you thought.
 */
import { research, researchEnabled } from '../ai/research.js'
import { q, q1 } from '../db.js'
import { fetchLinkMeta } from './enrich.js'
import { type Entry, addNote, getEntry } from './flow.js'

export interface CatchUpResult {
  entry_id: string
  title: string | null
  checked_at: string
  /** True when something was learned and a note was written. */
  changed: boolean
  note?: string
  citations?: string[]
  /** The page's own title/description moved since we last looked. */
  page_changed?: boolean
  skipped?: string
}

const NOTHING = 'NOTHING_NEW'

function prompt(entry: Entry, since: string, page: { title?: string; description?: string } | null): string {
  const known = [
    `Name: ${entry.title ?? 'unknown'}`,
    entry.data?.url ? `URL: ${String(entry.data.url)}` : '',
    entry.data?.summary ? `How it described itself when saved: ${String(entry.data.summary)}` : '',
    entry.body ? `What I wrote about it at the time: ${entry.body}` : '',
    page?.title && page.title !== entry.title ? `Its page is now titled: ${page.title}` : '',
    page?.description && page.description !== entry.data?.summary
      ? `Its page now describes itself as: ${page.description}`
      : '',
  ]
    .filter(Boolean)
    .join('\n')

  return [
    'Search the web and tell me what has genuinely changed or is newly notable about this,',
    `since ${since.slice(0, 10)}.`,
    '',
    known,
    '',
    'Rules:',
    `- If nothing meaningful has happened since that date, reply with exactly ${NOTHING} and nothing else.`,
    '- Report only concrete, checkable developments: funding, launches, acquisitions, shutdowns,',
    '  pivots, leadership changes, notable coverage. No filler, no restating what I already know above.',
    '- If the company appears to have pivoted or been acquired, say so first and plainly.',
    '- Be brief: at most three short sentences. Include dates.',
    '- Do not speculate. If sources disagree or are thin, say so rather than smoothing it over.',
  ].join('\n')
}

/** Checks one entry. Never throws for ordinary failures — returns what it learned. */
export async function catchUpEntry(entryId: string): Promise<CatchUpResult> {
  const entry = await getEntry(entryId)
  if (!entry) throw new Error(`No entry ${entryId}`)

  const url = typeof entry.data?.url === 'string' ? entry.data.url : null
  const since = entry.last_checked_at ?? entry.occurred_at ?? entry.created_at

  // Re-read the page. Works with no model at all, and catches rebrands and
  // pivots announced on the site itself.
  let page: Awaited<ReturnType<typeof fetchLinkMeta>> = null
  if (url) page = await fetchLinkMeta(url).catch(() => null)
  const pageChanged = Boolean(
    page &&
      ((page.title && page.title !== entry.title) ||
        (page.description && page.description !== entry.data?.summary)),
  )

  let noteBody: string | undefined
  let citations: string[] | undefined
  let skipped: string | undefined

  if (researchEnabled()) {
    try {
      const found = await research(prompt(entry, since, page))
      const text = found?.text?.trim()
      if (text && !text.toUpperCase().startsWith(NOTHING)) {
        noteBody = text
        citations = found?.citations
      }
    } catch (err) {
      skipped = err instanceof Error ? err.message : String(err)
    }
  } else if (pageChanged) {
    // No search available: the page diff is still worth recording.
    noteBody = [
      'Its own page changed since last check.',
      page?.title && page.title !== entry.title ? `Now titled: ${page.title}` : '',
      page?.description && page.description !== entry.data?.summary ? `Now says: ${page.description}` : '',
    ]
      .filter(Boolean)
      .join(' ')
  } else {
    skipped = 'no research provider configured'
  }

  if (noteBody) {
    const withSources = citations?.length
      ? `${noteBody}\n\nSources: ${citations.slice(0, 5).join(' · ')}`
      : noteBody
    await addNote(entry.id, withSources, 'research')
  }

  // Only record a check that actually happened. Stamping last_checked_at after
  // a timeout would quietly retire the entry from the queue without ever
  // having looked at it — the one outcome worse than a slow catch-up.
  const failed = Boolean(skipped) && skipped !== 'no research provider configured'
  const row = failed
    ? null
    : await q1<{ last_checked_at: string }>(
        `update flow.entries set last_checked_at = now() where id = $1 returning last_checked_at`,
        [entry.id],
      )

  return {
    entry_id: entry.id,
    title: entry.title,
    checked_at: row?.last_checked_at ?? entry.last_checked_at ?? '',
    changed: Boolean(noteBody),
    note: noteBody,
    citations,
    page_changed: pageChanged,
    skipped,
  }
}

/** The entries on a shelf, oldest-checked first — what to catch up on. */
export async function shelfQueue(tag: string, limit = 25): Promise<Entry[]> {
  return q<Entry>(
    `select id, kind, title, body, data, tags, status, rating, occurred_at, remind_at,
            source, archived_at, created_at, updated_at, last_checked_at
       from flow.entries
      where archived_at is null and $1 = any(tags)
      order by last_checked_at asc nulls first, created_at desc
      limit $2`,
    [tag.trim().toLowerCase(), Math.min(limit, 50)],
  )
}
