import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { catchUpEntry, shelfQueue } from '../core/catchup.js'
import { getIntegration, listIntegrations } from '../integrations/index.js'
import * as flow from '../core/flow.js'
import { formatEntryFull, formatEntryLine, formatList, formatSearch } from '../core/format.js'
import { DATA_HINTS, KINDS } from '../core/kinds.js'

/**
 * The flow toolset, built fresh on demand.
 *
 * A factory rather than a singleton because the HTTP transport is stateless:
 * every request gets its own server and transport, which is what lets the same
 * tools run in a serverless function and over stdio without either interfering
 * with the other.
 */

const log = (...args: unknown[]) => console.error('[flow:mcp]', ...args)

const text = (body: string) => ({ content: [{ type: 'text' as const, text: body }] })
const fail = (err: unknown) => ({
  content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
  isError: true,
})

/** Wraps a handler so a database hiccup becomes a tool error, not a crash. */
function guard<A>(fn: (args: A) => Promise<{ content: { type: 'text'; text: string }[] }>) {
  return async (args: A) => {
    try {
      return await fn(args)
    } catch (err) {
      log('tool error:', err)
      return fail(err)
    }
  }
}

const filterShape = {
  kind: z.string().optional().describe('Restrict to one kind, e.g. movie, person, reading, task'),
  tags: z.array(z.string()).optional().describe('Only entries carrying all of these tags'),
  status: z.string().optional(),
  since: z.string().optional().describe('ISO date — only entries captured on or after this'),
  until: z.string().optional().describe('ISO date — only entries captured on or before this'),
  limit: z.number().int().min(1).max(200).optional(),
  include_archived: z.boolean().optional(),
}

export function createFlowServer(): McpServer {
  const server = new McpServer(
    { name: 'flow', version: '0.1.0' },
    {
      instructions: [
        'flow is the user\'s personal memory. Write to it liberally and read from it before answering',
        'anything about their life, plans, opinions, or the people they know.',
        '',
        'Capture whenever the user shares something worth keeping: a stray thought, a film they want to',
        'watch, their take on something they read, a person they met. Do not ask permission to remember —',
        'capture it, then carry on with the conversation.',
        '',
        'Shelves are tags. When the user says "put this into hardware", "file this under X" or',
        '"shelf this with Y", that word is a TAG, never the title. Titling an entry after its shelf',
        'makes it unrecognisable later — every link on the shelf ends up with the same name.',
        '',
        'Shelves nest with a forward slash: `ai/harness`, `ai/frontier`. Tag with the most specific',
        'shelf only — `ai` is implied by `ai/harness` and asking for `ai` returns everything beneath',
        'it, so never add the parent as a second tag. Hyphens are literal, not nesting:',
        '`open-source` is one flat shelf.',
        '',
        'For a link: the title is what the thing is called, and the body is what the USER said about',
        'it. If they gave no title, pass the URL and leave the title empty — flow fetches the page',
        'title itself. Never invent a title for a URL you have not read.',
        '',
        `Kinds: ${KINDS.join(', ')} (any other string is allowed too).`,
        'Put kind-specific detail in `data`, e.g. ' +
          Object.entries(DATA_HINTS)
            .map(([k, v]) => `${k} → {${v}}`)
            .join('; '),
        '',
        'Starred GitHub repos sync in as kind=repo with status=starred. "That project from my git" means',
        'flow_repos. A star is only a bookmark — when the user says one is interesting, capture WHY with',
        'flow_note, because their reason is the part worth remembering.',
        '',
        'When the user hands over work done elsewhere — an analysis from another model, a report,',
        'a comparison they had Grok write — record WHO produced it. Their own words go in an entry',
        'body; anything produced by a model or copied from elsewhere goes in a note with source set',
        'to its origin. Use flow_capture_many for a handover covering several subjects: one entry',
        'per subject, one for the analysis, links between them, in a single call.',
        '',
        'Recall with flow_recall before saying you do not know something about the user.',
        'Entry references accept a full id, the short id shown in listings, or an exact title.',
      ].join('\n'),
    },
  )

  // ---------------------------------------------------------------------------

  server.registerTool(
    'flow_capture',
    {
      title: 'Capture a memory',
      description:
        'Save anything the user wants remembered — a thought, a movie for the watchlist, a person they met, ' +
        'a reading with their take on it, a task. Use this eagerly and without asking. ' +
        'Returns the new entry, plus possible duplicates if a similar named entry already exists.',
      inputSchema: {
        kind: z.string().optional().describe(`One of ${KINDS.join(', ')}, or any custom kind. Defaults to thought.`),
        title: z.string().optional().describe('Short label. Derived from the body if omitted.'),
        body: z.string().optional().describe("The content, in the user's own words where possible."),
        data: z
          .record(z.any())
          .optional()
          .describe('Structured detail for the kind, e.g. {company, role, linkedin} for a person'),
        tags: z.array(z.string()).optional(),
        status: z.string().optional().describe('Defaults per kind: movie→want, task→open, reading→queued'),
        rating: z.number().int().min(1).max(10).optional(),
        occurred_at: z.string().optional().describe('ISO timestamp for when this actually happened'),
        remind_at: z.string().optional().describe('ISO timestamp to resurface this'),
      },
    },
    guard(async (args) => {
      const { entry, possible_duplicates } = await flow.capture({ ...args, source: 'mcp' })
      const lines = [`Captured:\n${formatEntryLine(entry)}`]
      if (possible_duplicates.length) {
        lines.push(
          '',
          `Note — similar ${entry.kind} entries already exist. Consider adding a note to one instead:`,
          ...possible_duplicates.map((d) => `- [${d.id.slice(0, 8)}] ${d.title} (${d.status ?? 'no status'})`),
        )
      }
      return text(lines.join('\n'))
    }),
  )

  server.registerTool(
    'flow_capture_many',
    {
      title: 'Capture several linked things at once',
      description:
        'Save multiple entries and the links between them in one call. Built for handing over a ' +
        'chunk of work done elsewhere — a comparison of two products, research on a shortlist, ' +
        'notes from a call covering several people.\n\n' +
        'The pattern for "here is an analysis another model produced": one entry per subject, one ' +
        'entry for the analysis itself, and links from the analysis to each subject. Put the ' +
        'analysis text in that entry\'s `note` with `note_source` set to whatever produced it — ' +
        'not in `body`, which belongs to the user. Give each entry a `ref` so links can point at ' +
        'things being created in the same call.\n\n' +
        'Subjects that already exist are reused, not duplicated: a `ref` matching an existing ' +
        'title resolves to it.',
      inputSchema: {
        entries: z
          .array(
            z.object({
              ref: z.string().optional().describe('Short handle for linking within this call, e.g. "a"'),
              kind: z.string().optional(),
              title: z.string().optional(),
              body: z.string().optional().describe("The USER's own words only"),
              data: z.record(z.any()).optional(),
              tags: z.array(z.string()).optional(),
              status: z.string().optional(),
              rating: z.number().int().min(1).max(10).optional(),
              occurred_at: z.string().optional(),
              remind_at: z.string().optional(),
              note: z.string().optional().describe('An initial note to attach'),
              note_source: z
                .string()
                .optional()
                .describe("Who wrote `note`: 'me', or the model/tool it came from"),
            }),
          )
          .min(1)
          .max(20),
        links: z
          .array(
            z.object({
              from: z.string().describe('A ref from this call, or an existing id/title'),
              to: z.string(),
              rel: z.string().optional().describe('e.g. compares, about, prompted_by'),
            }),
          )
          .optional(),
      },
    },
    guard(async ({ entries, links }) => {
      const refs = new Map<string, string>()
      const made: flow.Entry[] = []
      const reused: flow.Entry[] = []

      for (const item of entries) {
        const { ref, note, note_source, ...input } = item

        // A ref naming something already stored means "attach to that", not
        // "make another one" — the whole point when adding to known subjects.
        let existing: string | null = null
        if (input.title) {
          existing = await flow.resolveId(input.title).catch(() => null)
        }

        if (existing) {
          const e = await flow.getEntry(existing)
          if (e) reused.push(e)
          if (ref) refs.set(ref, existing)
          if (note) await flow.addNote(existing, note, note_source?.trim() || 'me')
          continue
        }

        const { entry } = await flow.capture({ ...input, source: 'mcp' })
        made.push(entry)
        if (ref) refs.set(ref, entry.id)
        if (note) await flow.addNote(entry.id, note, note_source?.trim() || 'me')
      }

      const resolve = async (r: string) => refs.get(r) ?? (await flow.resolveId(r))
      let linked = 0
      for (const l of links ?? []) {
        try {
          await flow.linkEntries(await resolve(l.from), await resolve(l.to), l.rel ?? 'related')
          linked++
        } catch (err) {
          log('link failed:', err)
        }
      }

      const lines = [`Captured ${made.length}${reused.length ? `, added to ${reused.length} existing` : ''}${linked ? `, ${linked} links` : ''}:`]
      if (made.length) lines.push(formatList(made))
      if (reused.length) lines.push('Existing:', formatList(reused))
      return text(lines.join('\n'))
    }),
  )

  server.registerTool(
    'flow_recall',
    {
      title: 'Recall from memory',
      description:
        'Search everything the user has ever captured. Use this before claiming not to know something about ' +
        'them — their opinions, plans, watchlist, or the people they know. Matches titles, bodies, notes, ' +
        'tags and structured detail, and tolerates half-remembered names.',
      inputSchema: {
        query: z.string().describe('Natural words to look for. Empty string lists recent entries.'),
        ...filterShape,
      },
    },
    guard(async ({ query, ...f }) => text(formatSearch(query, await flow.search(query, f)))),
  )

  server.registerTool(
    'flow_get',
    {
      title: 'Open an entry',
      description: 'Full detail for one entry: body, structured data, every note added over time, and links.',
      inputSchema: { id: z.string().describe('Full id, short id, or exact title') },
    },
    guard(async ({ id }) => {
      const entry = await flow.getEntry(await flow.resolveId(id))
      return text(entry ? formatEntryFull(entry) : 'Not found.')
    }),
  )

  server.registerTool(
    'flow_list',
    {
      title: 'List entries',
      description: 'Browse entries by kind, tag, status or date, newest first. For open-ended questions use flow_recall.',
      inputSchema: filterShape,
    },
    guard(async (f) => text(formatList(await flow.listEntries(f)))),
  )

  server.registerTool(
    'flow_update',
    {
      title: 'Update an entry',
      description:
        'Change an existing entry — mark a movie watched, rate it, set a status, add tags, correct a detail, ' +
        'or archive it. Only the fields provided are touched; data is merged, not replaced.',
      inputSchema: {
        id: z.string().describe('Full id, short id, or exact title'),
        title: z.string().optional(),
        body: z.string().optional(),
        kind: z.string().optional(),
        data: z.record(z.any()).optional().describe('Merged into existing data; set a key to null to remove it'),
        tags: z.array(z.string()).optional().describe('Replaces all tags'),
        add_tags: z.array(z.string()).optional().describe('Adds to existing tags'),
        status: z.string().optional().describe('e.g. watched, done, read, dropped'),
        rating: z.number().int().min(1).max(10).optional(),
        occurred_at: z.string().optional(),
        remind_at: z.string().optional(),
        archived: z.boolean().optional(),
      },
    },
    guard(async ({ id, ...patch }) => {
      const entry = await flow.updateEntry(await flow.resolveId(id), patch)
      return text(entry ? `Updated:\n${formatEntryLine(entry)}` : 'Not found.')
    }),
  )

  server.registerTool(
    'flow_note',
    {
      title: 'Add a note to an entry',
      description:
        'Append a timestamped thought to something already remembered — a new impression of a person, a ' +
        'reaction after watching a film, a further thought on an essay. Keeps history instead of overwriting.',
      inputSchema: {
        id: z.string().describe('Full id, short id, or exact title'),
        body: z.string().describe('The thought to append'),
        source: z
          .string()
          .optional()
          .describe(
            "Who produced this text. 'me' (the default) means the user's own words. If it came " +
              'from anywhere else — another model, a report they pasted, a search — name it ' +
              "('grok', 'chatgpt', 'perplexity'). Never file someone else's analysis as the " +
              "user's own thinking: in a year they must still be able to tell which was which.",
          ),
      },
    },
    guard(async ({ id, body, source }) => {
      const entryId = await flow.resolveId(id)
      await flow.addNote(entryId, body, source?.trim() || 'me')
      const entry = await flow.getEntry(entryId)
      return text(
        `Noted on "${entry?.title ?? entryId}"${source && source !== 'me' ? ` (attributed to ${source})` : ''} — ${entry?.notes.length ?? 1} notes total.`,
      )
    }),
  )

  server.registerTool(
    'flow_link',
    {
      title: 'Link two entries',
      description:
        'Connect two memories, e.g. a person to the film they recommended, or a thought to the essay that ' +
        'prompted it. Links surface whenever either entry is opened.',
      inputSchema: {
        from: z.string().describe('Full id, short id, or exact title'),
        to: z.string().describe('Full id, short id, or exact title'),
        rel: z.string().optional().describe('e.g. recommended, about, prompted_by, works_with. Default: related'),
      },
    },
    guard(async ({ from, to, rel }) => {
      const [a, b] = await Promise.all([flow.resolveId(from), flow.resolveId(to)])
      await flow.linkEntries(a, b, rel ?? 'related')
      return text(`Linked ${a.slice(0, 8)} —${rel ?? 'related'}→ ${b.slice(0, 8)}.`)
    }),
  )

  server.registerTool(
    'flow_watchlist',
    {
      title: 'Movie watchlist',
      description:
        'The watchlist view: what the user still wants to watch, or what they have already seen with ratings. ' +
        'Add with flow_capture (kind: movie); mark watched with flow_update (status: watched, rating: n).',
      inputSchema: {
        show: z.enum(['want', 'watched', 'all']).optional().describe('Default: want'),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    guard(async ({ show = 'want', limit }) => {
      const entries =
        show === 'all'
          ? await flow.listEntries({ kind: 'movie', limit })
          : show === 'watched'
            ? await flow.listEntries({ kind: 'movie', status: 'watched', limit })
            : await flow.open('movie', limit ?? 50)
      return text(formatList(entries, show === 'want' ? 'Watchlist is empty.' : 'Nothing watched yet.'))
    }),
  )

  server.registerTool(
    'flow_people',
    {
      title: 'People the user knows',
      description:
        'Look up remembered people — LinkedIn connections, colleagues, anyone they have met. Searches names, ' +
        'companies, roles, where they met and every note since.',
      inputSchema: {
        query: z.string().optional().describe('Name, company, role, or context. Omit to list recent people.'),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    guard(async ({ query, limit }) => {
      const entries = query
        ? await flow.search(query, { kind: 'person', limit })
        : await flow.listEntries({ kind: 'person', limit })
      return text(formatList(entries, query ? `No one matching "${query}".` : 'No people remembered yet.'))
    }),
  )

  server.registerTool(
    'flow_due',
    {
      title: 'What needs resurfacing',
      description: 'Entries whose reminder has come due (or falls within the next N days).',
      inputSchema: { within_days: z.number().int().min(0).max(365).optional().describe('Default 0 — due now') },
    },
    guard(async ({ within_days }) =>
      text(formatList(await flow.due(within_days ?? 0), 'Nothing due.')),
    ),
  )

  server.registerTool(
    'flow_briefing',
    {
      title: 'Briefing',
      description:
        'A snapshot of the user\'s memory: what is due, what they captured recently, the open watchlist, ' +
        'open tasks and totals. Good opening move when they ask "what have I got going on?".',
      inputSchema: {},
    },
    guard(async () => {
      const b = await flow.briefing()
      const section = (title: string, entries: flow.Entry[]) =>
        entries.length ? `\n## ${title}\n${formatList(entries)}` : ''
      return text(
        [
          `# flow — ${b.stats.total} memories, ${b.stats.captured_last_7_days} captured this week`,
          b.stats.by_kind.map((k) => `${k.kind}: ${k.count}${k.open ? ` (${k.open} open)` : ''}`).join(' · '),
          section('Due now', b.due),
          section('Recent', b.recent),
          section('Watchlist', b.watchlist),
          section('Open tasks', b.open_tasks),
          b.stats.top_tags.length
            ? `\n## Tags\n${b.stats.top_tags.map((t) => `#${t.tag} (${t.count})`).join(' ')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
    }),
  )

  server.registerTool(
    'flow_repos',
    {
      title: 'Starred repos',
      description:
        'Code projects the user has starred on GitHub, synced into flow. Use this whenever they ' +
        'refer to something "from my git", "that repo I starred", or a project by a half-remembered ' +
        'name. Matches the repo name, its description, language and topics. ' +
        'When they say one is interesting, add their reason with flow_note and set status via ' +
        'flow_update — that is what turns a passive star into something they actually thought about.',
      inputSchema: {
        query: z.string().optional().describe('Name, topic, language or what it does. Omit to list recent stars.'),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    guard(async ({ query, limit }) => {
      const entries = query
        ? await flow.search(query, { kind: 'repo', limit })
        : await flow.listEntries({ kind: 'repo', limit })
      return text(
        formatList(entries, query ? `No starred repo matches "${query}".` : 'No repos synced yet.'),
      )
    }),
  )

  server.registerTool(
    'flow_sync',
    {
      title: 'Sync an integration',
      description:
        'Pull in things collected elsewhere — currently GitHub stars. Safe to run repeatedly: ' +
        'already-imported items are recognised and left alone. Call with no arguments to see what ' +
        'is available and configured.',
      inputSchema: {
        source: z.string().optional().describe('Integration id, e.g. github. Omit to list them.'),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    guard(async ({ source, limit }) => {
      if (!source) {
        const list = listIntegrations()
          .map((i) => `- ${i.id} (${i.label}) — ${i.configured ? 'configured' : `needs ${i.requires}`}`)
          .join('\n')
        return text(`Integrations:\n${list}`)
      }
      const integration = getIntegration(source)
      if (!integration) return text(`No integration called "${source}".`)
      if (!integration.configured()) return text(`${integration.id} needs ${integration.requires}`)
      const r = await integration.sync({ limit })
      return text(
        `Synced ${r.source}: ${r.imported} new, ${r.skipped} already had, ${r.total_seen} seen.` +
          (r.note ? `\n${r.note}` : ''),
      )
    }),
  )

  server.registerTool(
    'flow_catch_up',
    {
      title: 'Catch up on what changed',
      description:
        'Look up what has happened in the world to something already saved — "what\'s up with these ' +
        'guys?". Searches the web, then appends what it finds as a dated, sourced note. Pass a shelf ' +
        'to sweep everything on it, oldest-checked first. Append-only: it never rewrites titles, ' +
        'tags or shelves, it only reports. Slow — a few seconds per entry.',
      inputSchema: {
        id: z.string().optional().describe('One entry: full id, short id, or exact title'),
        shelf: z.string().optional().describe('A shelf (tag) to sweep instead'),
        limit: z.number().int().min(1).max(10).optional().describe('Max entries when sweeping a shelf. Default 5.'),
      },
    },
    guard(async ({ id, shelf, limit }) => {
      if (!id && !shelf) return text('Give either an entry id or a shelf.')

      const targets = shelf
        ? (await shelfQueue(shelf, limit ?? 5)).map((e) => e.id)
        : [await flow.resolveId(id!)]
      if (!targets.length) return text(`Nothing on a shelf called "${shelf}".`)

      const lines: string[] = []
      for (const target of targets) {
        const r = await catchUpEntry(target)
        lines.push(
          r.changed
            ? `**${r.title}**\n${r.note}`
            : `**${r.title}** — nothing new${r.skipped ? ` (${r.skipped})` : ''}`,
        )
      }
      return text(
        `Checked ${targets.length} ${targets.length === 1 ? 'entry' : 'entries'}:\n\n${lines.join('\n\n')}`,
      )
    }),
  )

  server.registerTool(
    'flow_rename_shelf',
    {
      title: 'Rename a shelf',
      description:
        'Rename a shelf (tag) across every entry carrying it. Renaming onto an existing shelf ' +
        'merges the two. Use when the user wants a shelf called something else.',
      inputSchema: {
        from: z.string().describe('The shelf as it is now'),
        to: z.string().describe('What it should be called'),
      },
    },
    guard(async ({ from, to }) => {
      const moved = await flow.renameShelf(from, to)
      return text(
        moved.length
          ? `Renamed "${from}" to "${to}" on ${moved.length} ${moved.length === 1 ? 'entry' : 'entries'}:\n${formatList(moved)}`
          : `No entries are on a shelf called "${from}".`,
      )
    }),
  )

  server.registerTool(
    'flow_delete',
    {
      title: 'Delete an entry',
      description:
        'Permanently remove an entry and its notes. Prefer flow_update with archived: true unless the user ' +
        'clearly wants it gone.',
      inputSchema: { id: z.string().describe('Full id, short id, or exact title') },
    },
    guard(async ({ id }) => {
      const resolved = await flow.resolveId(id)
      return text((await flow.deleteEntry(resolved)) ? `Deleted ${resolved.slice(0, 8)}.` : 'Not found.')
    }),
  )


  return server
}
