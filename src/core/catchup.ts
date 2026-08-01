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
import { chat } from '../ai/llm.js'
import { exaSearch, research, researchMode } from '../ai/research.js'
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

/** What to actually type into a search box for this entry. */
function searchQuery(entry: Entry): string {
  const site = typeof entry.data?.source === 'string' ? entry.data.source : null
  // The site name ("DFNS") beats a page title ("Colossus — Overview"), which
  // is about a page rather than about the company.
  const subject = site ?? entry.title ?? ''
  let domain = ''
  try {
    if (typeof entry.data?.url === 'string') domain = new URL(entry.data.url).hostname.replace(/^www\./, '')
  } catch {
    /* not a usable url */
  }
  return [subject, domain, 'news funding launch acquisition'].filter(Boolean).join(' ')
}

/**
 * Retrieval path: Exa finds documents published since the last check, and our
 * own model turns them into a note. The date window is enforced by the index,
 * so the model is only ever summarising things that are genuinely new.
 */
async function retrieveAndSummarise(
  entry: Entry & { notes?: { body: string; source: string }[] },
  since: string,
  page: { title?: string; description?: string } | null,
): Promise<{ text: string; citations: string[] } | undefined> {
  const docs = await exaSearch({ query: searchQuery(entry), since, numResults: 8 })
  if (!docs.length) return undefined

  // Repeat sweeps re-find the same articles, so tell the model what it has
  // already recorded rather than writing the same note again.
  const already = (entry.notes ?? [])
    .filter((n) => n.source === 'research')
    .slice(-3)
    .map((n) => n.body.split('\n\nSources:')[0])
    .join('\n')

  const context = docs
    .map((d) => `- ${d.title} (${d.published?.slice(0, 10) ?? 'undated'})\n  ${d.url}\n  ${d.highlights.slice(0, 2).join(' … ')}`)
    .join('\n')

  const text = await chat({
    system: [
      'You summarise what has newly happened to something the user is tracking, using only the',
      'search results given. They are already filtered to items published after the last check.',
      '',
      'Rules:',
      `- If nothing here is materially new or notable, reply with exactly ${NOTHING} and nothing else.`,
      '- At most three short sentences. Lead with the most significant item. Always include dates.',
      '- Cite with the URL in brackets after the claim it supports.',
      '- Concrete developments only: funding, launches, partnerships, acquisitions, shutdowns,',
      '  pivots, leadership changes. Ignore SEO filler, listicles and undated pages.',
      '- Never repeat anything under "already recorded".',
      '- Do not restate what the thing is. The user knows; they saved it.',
    ].join('\n'),
    user: [
      `Tracking: ${entry.title ?? 'unknown'}${entry.data?.url ? ` (${String(entry.data.url)})` : ''}`,
      entry.data?.summary ? `Known as: ${String(entry.data.summary)}` : '',
      page?.description && page.description !== entry.data?.summary ? `Its page now says: ${page.description}` : '',
      already ? `\nAlready recorded:\n${already}` : '',
      `\nSearch results since ${since.slice(0, 10)}:\n${context}`,
    ]
      .filter(Boolean)
      .join('\n'),
  })

  const trimmed = text.trim()
  if (!trimmed || trimmed.toUpperCase().startsWith(NOTHING)) return undefined

  // Only credit sources the summary actually used.
  const cited = docs.filter((d) => trimmed.includes(d.url)).map((d) => d.url)
  return { text: trimmed, citations: cited.length ? cited : docs.slice(0, 3).map((d) => d.url) }
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

  const mode = researchMode()

  if (mode === 'exa') {
    try {
      const found = await retrieveAndSummarise(entry, since, page)
      noteBody = found?.text
      citations = found?.citations
    } catch (err) {
      skipped = err instanceof Error ? err.message : String(err)
    }
  } else if (mode === 'agentic') {
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

/**
 * The entries on a shelf, oldest-checked first — what to catch up on.
 * Includes sub-shelves, so sweeping `ai` covers `ai/harness` too.
 */
export async function shelfQueue(tag: string, limit = 25): Promise<Entry[]> {
  return q<Entry>(
    `select id, kind, title, body, data, tags, status, rating, occurred_at, remind_at,
            source, archived_at, created_at, updated_at, last_checked_at
       from flow.entries e
      where archived_at is null
        and exists (select 1 from unnest(e.tags) tg
                     where tg = $1 or starts_with(tg, $1 || '/'))
      order by last_checked_at asc nulls first, created_at desc
      limit $2`,
    [tag.trim().toLowerCase().replace(/^#/, ''), Math.min(limit, 50)],
  )
}
