/**
 * "Where should this go?"
 *
 * Deliberately not a capture mode. You do not know you are stuck until you are
 * already looking at the thing, and a mode you must choose up front is one you
 * will not have chosen. So capture stays instant and unblocked, and this runs
 * afterwards, on demand, against an entry that is already safely saved.
 *
 * The one thing that makes it useful is that it sees the actual shelves and
 * what is on them. A suggester without that invents a plausible new tag every
 * time, which is precisely how a taxonomy rots.
 */
import { type Entry, listEntries, shelves } from '../core/flow.js'
import { chatJson, nullableString, type JsonSchemaSpec } from './llm.js'

export interface ShelfSuggestion {
  existing: { tag: string; why: string }[]
  /** Proposed only when nothing existing genuinely fits. */
  new_shelf: { tag: string; why: string } | null
  /** Entries already stored that this sits alongside. */
  neighbours: string[]
  note: string | null
}

const SCHEMA: JsonSchemaSpec = {
  name: 'shelf_suggestion',
  schema: {
    type: 'object',
    properties: {
      existing: {
        type: 'array',
        description: '0-3 shelves from the list provided. Only ones that genuinely fit.',
        items: {
          type: 'object',
          properties: {
            tag: { type: 'string', description: 'Exactly as it appears in the shelf list' },
            why: { type: 'string', description: 'One short clause. What it shares with what is already there.' },
          },
          required: ['tag', 'why'],
          additionalProperties: false,
        },
      },
      new_shelf: {
        type: ['object', 'null'],
        description: 'Only if nothing existing fits. A plain readable word, lowercase, no invented acronyms.',
        properties: {
          tag: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['tag', 'why'],
        additionalProperties: false,
      },
      neighbours: {
        type: 'array',
        description: 'Titles from the store this most closely sits beside, at most 3.',
        items: { type: 'string' },
      },
      note: { ...nullableString, description: 'One sentence only if something is genuinely worth flagging.' },
    },
    required: ['existing', 'new_shelf', 'neighbours', 'note'],
    additionalProperties: false,
  },
}

/** A sample of what actually lives on each shelf, so "fits" means something. */
async function shelfContext(): Promise<string> {
  const all = await shelves()
  const lines: string[] = []
  for (const s of all) {
    const sample = await listEntries({ tags: [s.tag], limit: 3 })
    lines.push(
      `${s.tag} (${s.count}): ${sample.map((e) => e.title ?? 'untitled').join(' · ') || '—'}`,
    )
  }
  return lines.join('\n')
}

export async function suggestShelves(entry: Entry): Promise<ShelfSuggestion> {
  const context = await shelfContext()

  const subject = [
    `Title: ${entry.title ?? 'untitled'}`,
    `Kind: ${entry.kind}`,
    entry.data?.summary ? `Describes itself as: ${String(entry.data.summary)}` : '',
    entry.body ? `What the user said about it: ${entry.body}` : '',
    entry.data?.url ? `URL: ${String(entry.data.url)}` : '',
    entry.data?.language ? `Language: ${String(entry.data.language)}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  return chatJson<ShelfSuggestion>({
    system: [
      'You help someone file one thing into their own personal memory. Their shelves and a sample',
      'of what is on each are given. Your job is to place this thing among them.',
      '',
      'Rules:',
      '- Strongly prefer shelves that already exist. Proposing a new one for something that fits an',
      '  existing shelf is the main way a taxonomy degrades into hundreds of one-item tags.',
      '- Propose a new shelf only when nothing fits, and then a plain lowercase word someone would',
      '  still understand in a year. No invented acronyms.',
      '- Shelves nest with a slash. If the thing belongs under an existing family, suggest',
      '  parent/child (e.g. ai/legal) rather than a new top-level shelf.',
      '- Suggest at most 3, usually 1 or 2. A thing on every shelf is on no shelf.',
      '- Name the neighbours it sits beside — that is what makes a placement feel right or wrong.',
      '- Say plainly if the honest answer is that it does not belong with anything they have.',
    ].join('\n'),
    user: `Their shelves:\n${context}\n\nThe thing to file:\n${subject}`,
    schema: SCHEMA,
  })
}

export function formatSuggestion(s: ShelfSuggestion): string {
  const lines: string[] = []
  if (s.existing.length) {
    lines.push('Fits shelves you already have:')
    for (const e of s.existing) lines.push(`  #${e.tag} — ${e.why}`)
  } else {
    lines.push('Nothing you already have fits it well.')
  }
  if (s.new_shelf) lines.push('', `New shelf worth making: #${s.new_shelf.tag} — ${s.new_shelf.why}`)
  if (s.neighbours.length) lines.push('', `Sits beside: ${s.neighbours.join(' · ')}`)
  if (s.note) lines.push('', s.note)
  return lines.join('\n')
}
