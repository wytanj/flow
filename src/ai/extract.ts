/**
 * Smart capture: unstructured text in, structured memories out.
 *
 * One sentence can hold several memories ("watched Perfect Days, 9/10, and
 * Aisha says I should read the dark forest essay") and they belong in separate
 * entries with different kinds. The rule throughout is that nothing said is
 * allowed to go unstored — the model splits and types, it does not summarise
 * or judge what deserves keeping.
 */
import * as flow from '../core/flow.js'
import { DATA_HINTS, KINDS } from '../core/kinds.js'
import { chatJson, nullableNumber, nullableString, type JsonSchemaSpec } from './llm.js'

interface ExtractedEntry {
  kind: string
  title: string
  body: string | null
  tags: string[]
  data: { key: string; value: string }[]
  status: string | null
  rating: number | null
  occurred_at: string | null
  remind_at: string | null
}

const SCHEMA: JsonSchemaSpec = {
  name: 'captures',
  schema: {
    type: 'object',
    properties: {
      entries: {
        type: 'array',
        description: 'One per distinct thing worth remembering. Never merge unrelated things.',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', description: `One of: ${KINDS.join(', ')}` },
            title: { type: 'string', description: 'Short label — the name of the thing, not a sentence about it' },
            body: { ...nullableString, description: "Detail, in the user's own words wherever possible" },
            tags: { type: 'array', items: { type: 'string' }, description: 'Lowercase topics, no # prefix' },
            data: {
              type: 'array',
              description: 'Structured fields for this kind, as key/value pairs',
              items: {
                type: 'object',
                properties: { key: { type: 'string' }, value: { type: 'string' } },
                required: ['key', 'value'],
                additionalProperties: false,
              },
            },
            status: { ...nullableString, description: 'movie: want|watching|watched|dropped. task: open|done. reading: queued|read. Null if not implied.' },
            rating: { ...nullableNumber, description: 'Out of 10, only if the user actually rated it' },
            occurred_at: { ...nullableString, description: 'ISO 8601 timestamp of when this happened, if stated' },
            remind_at: { ...nullableString, description: 'ISO 8601 timestamp, only if the user asked to be reminded or to follow up' },
          },
          required: ['kind', 'title', 'body', 'tags', 'data', 'status', 'rating', 'occurred_at', 'remind_at'],
          additionalProperties: false,
        },
      },
    },
    required: ['entries'],
    additionalProperties: false,
  },
}

function systemPrompt(now: string): string {
  return [
    'You turn a person\'s offhand notes into structured entries for their personal memory system.',
    `The current date and time is ${now}. Resolve relative dates ("last Tuesday", "next week") against it.`,
    '',
    `Kinds: ${KINDS.join(', ')}. Use the closest fit; prefer "thought" over inventing a kind.`,
    'Suggested data fields per kind:',
    ...Object.entries(DATA_HINTS).map(([k, v]) => `  ${k}: ${v}`),
    '',
    'Rules:',
    '- Split the input into one entry per distinct thing. A note about a film and a note about a',
    '  person are two entries, never one.',
    '- Lose nothing. Every claim in the input must survive into some entry\'s body or data.',
    '- Do not invent facts. If the year, company or director was not stated, leave it out — a',
    '  confidently wrong detail in a memory system is worse than a missing one.',
    '- Keep the user\'s own phrasing in `body`. Their words are the memory; do not smooth them out.',
    '- title is the name of the thing ("Perfect Days", "Daniel Oh"), not a description of it. For a',
    '  bare thought with no name, use a short distinctive phrase from the thought itself.',
    '- Shelves are tags. "put this into hardware", "file under X", "shelf this with Y" — that word is',
    '  a tag, never the title. Naming an entry after its shelf makes every entry on that shelf',
    '  identical and unfindable.',
    '- Shelves nest with a slash: ai/harness, ai/frontier. Use the most specific one only; the parent',
    '  is implied and must not be added as a second tag. Hyphens are literal (open-source is flat).',
    '- For a link: leave the title empty unless the user named the thing themselves. flow fetches the',
    '  page title on save. Put the URL in data.url and keep the user\'s own reaction in body — their',
    '  take on a link is the part worth remembering, and it is not the same as what the page says.',
    '- status only when the input implies one. Do not put commentary in status.',
    '- remind_at only when the user actually asked to be reminded or to follow up.',
  ].join('\n')
}

export interface SmartCaptureResult {
  entries: flow.Entry[]
  duplicates: { entry_id: string; existing: { id: string; title: string | null; status: string | null }[] }[]
}

/**
 * Extracts entries from free text and writes them. Returns what was stored.
 *
 * One jot can become several entries, so the caller's capture_id is suffixed
 * per entry: a retry of the same jot lands on the same rows rather than
 * duplicating the lot. The extraction is re-run, which costs a model call, but
 * the writes stay idempotent — and the ordering is stable enough for the
 * suffixes to line up.
 */
export async function smartCapture(
  text: string,
  source = 'ai',
  captureId?: string | null,
): Promise<SmartCaptureResult> {
  const input = text.trim()
  if (!input) throw new Error('Nothing to capture.')

  const { entries: extracted } = await chatJson<{ entries: ExtractedEntry[] }>({
    system: systemPrompt(new Date().toISOString()),
    user: input,
    schema: SCHEMA,
  })

  if (!extracted?.length) {
    // Rather than lose the input to a model that found nothing in it, keep it verbatim.
    const { entry } = await flow.capture({
      kind: 'thought',
      body: input,
      source,
      capture_id: captureId ? `${captureId}#0` : null,
    })
    return { entries: [entry], duplicates: [] }
  }

  const results: SmartCaptureResult = { entries: [], duplicates: [] }
  for (const [index, e] of extracted.entries()) {
    const data: Record<string, string> = {}
    for (const { key, value } of e.data ?? []) {
      if (key && value) data[key] = value
    }
    const { entry, possible_duplicates } = await flow.capture({
      kind: e.kind,
      title: e.title,
      body: e.body,
      data,
      tags: e.tags,
      status: e.status,
      rating: e.rating,
      occurred_at: e.occurred_at,
      remind_at: e.remind_at,
      source,
      capture_id: captureId ? `${captureId}#${index}` : null,
    })
    results.entries.push(entry)
    if (possible_duplicates.length) {
      results.duplicates.push({
        entry_id: entry.id,
        existing: possible_duplicates.map((d) => ({ id: d.id, title: d.title, status: d.status })),
      })
    }
  }
  return results
}
