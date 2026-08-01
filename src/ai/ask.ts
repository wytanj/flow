/**
 * Question answering over your own memory.
 *
 * Two hops: the model turns a vague question into concrete search terms
 * ("who was that Kakao guy" → kakao, seoul, VP engineering), those run against
 * the search index, and the entries that come back are the only material the
 * answer may draw on. This matters most without embeddings — one keyword query
 * often misses where three do not — but it earns its keep either way.
 */
import * as flow from '../core/flow.js'
import { KINDS } from '../core/kinds.js'
import { chat, chatJson, nullableString, type JsonSchemaSpec } from './llm.js'

const PLAN_SCHEMA: JsonSchemaSpec = {
  name: 'search_plan',
  schema: {
    type: 'object',
    properties: {
      queries: {
        type: 'array',
        description: '1-4 keyword searches likely to surface relevant entries. Vary the angle: names, topics, synonyms the user might have written instead.',
        items: { type: 'string' },
      },
      kind: { ...nullableString, description: `Restrict to one of ${KINDS.join(', ')} only if the question is clearly about that kind. Otherwise null.` },
    },
    required: ['queries', 'kind'],
    additionalProperties: false,
  },
}

const MAX_CONTEXT_ENTRIES = 24

// Only used by the last-ditch keyword pass, where question words are searched
// raw; the planner is told to skip stopwords itself.
const STOPWORDS = new Set([
  'what', 'when', 'where', 'which', 'that', 'this', 'those', 'these', 'about', 'with', 'from',
  'have', 'been', 'were', 'they', 'them', 'their', 'there', 'then', 'than', 'some', 'said',
  'tell', 'know', 'think', 'thought', 'remember', 'again', 'into', 'over', 'much', 'like',
  'would', 'could', 'should', 'does', 'did', 'was', 'the', 'and', 'for', 'you', 'your',
])

/** Renders an entry for the model: enough to answer from, cheap enough to send 24 of. */
function asContext(e: flow.Entry & { notes?: { body: string; created_at: string }[] }): string {
  const parts = [`[${e.id.slice(0, 8)}] ${e.title ?? '(untitled)'} — ${e.kind}`]
  if (e.status) parts.push(`status: ${e.status}`)
  if (e.rating != null) parts.push(`rating: ${e.rating}/10`)
  if (e.tags.length) parts.push(`tags: ${e.tags.join(', ')}`)
  parts.push(`captured: ${(e.occurred_at ?? e.created_at).slice(0, 10)}`)
  if (e.remind_at) parts.push(`reminder: ${e.remind_at.slice(0, 10)}`)
  const data = Object.entries(e.data ?? {}).filter(([, v]) => v != null && v !== '')
  if (data.length) parts.push(data.map(([k, v]) => `${k}: ${String(v)}`).join(' | '))
  if (e.body) parts.push(e.body.length > 600 ? `${e.body.slice(0, 600)}…` : e.body)
  for (const n of e.notes ?? []) parts.push(`note (${n.created_at.slice(0, 10)}): ${n.body}`)
  return parts.join('\n')
}

export interface AskResult {
  question: string
  answer: string
  searched: string[]
  sources: { id: string; kind: string; title: string | null }[]
}

export async function ask(question: string, opts: { kind?: string | null } = {}): Promise<AskResult> {
  const q = question.trim()
  if (!q) throw new Error('Ask something.')

  const now = new Date().toISOString()

  // The planner sees the store's actual vocabulary, so it can aim at words that
  // are really in there rather than words the question happens to use.
  const vocab = await flow.stats().catch(() => null)

  const plan = await chatJson<{ queries: string[]; kind: string | null }>({
    system: [
      'You plan searches over a personal memory store. Retrieval is keyword-first (Postgres',
      'full-text), optionally fused with vector search — so keyword-shaped queries always pay off,',
      'and a semantically-phrased one may too.',
      `Today is ${now.slice(0, 10)}.`,
      '',
      'The person wrote these notes themselves, so search for the words THEY would have typed, not',
      'the words in the question. The two are often different, and a query that merely restates the',
      'question is usually the one that finds nothing.',
      '',
      'Use world knowledge to bridge that gap. This is the one place it is welcome:',
      '  "that Wim Wenders film" → also search his actual film titles',
      '  "the korean tech guy"   → also search Seoul, Kakao, Naver, Samsung',
      '  "the essay about X"     → also search the likely title and author',
      'The answering step is strictly grounded in what comes back, so a speculative query costs',
      'nothing if it misses.',
      '',
      'Give 2-4 short, genuinely different queries — different angles, not rephrasings. No stopwords.',
      vocab ? `\nKinds in this store: ${vocab.by_kind.map((k) => `${k.kind}(${k.count})`).join(', ')}` : '',
      vocab?.top_tags.length ? `Tags in use: ${vocab.top_tags.map((t) => t.tag).join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    user: q,
    schema: PLAN_SCHEMA,
  })

  const kind = opts.kind ?? plan.kind ?? null
  const queries = (plan.queries?.length ? plan.queries : [q]).slice(0, 4)

  const byId = new Map<string, flow.SearchHit>()
  const collect = async (terms: string[], searchKind: string | null) => {
    const hits = await Promise.all(
      terms.map((term) => flow.search(term, { kind: searchKind, limit: 10 }).catch(() => [])),
    )
    // Merge, keeping each entry's best rank across the queries it matched.
    for (const list of hits) {
      for (const hit of list) {
        const prev = byId.get(hit.id)
        if (!prev || hit.score > prev.score) byId.set(hit.id, hit)
      }
    }
  }

  const searched = [...queries]
  await collect(queries, kind)

  // Widening passes. Retrieval failing outright is common with keyword search,
  // and answering "nothing found" when the memory is sitting right there is the
  // worst outcome this system has — so try harder before giving up.
  if (!byId.size && kind) {
    await collect(queries, null) // the kind guess may simply have been wrong
    searched.push(`${queries.join(', ')} (any kind)`)
  }
  if (!byId.size) {
    const words = [...new Set(q.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? [])]
      .filter((w) => !STOPWORDS.has(w))
      .slice(0, 6)
    if (words.length) {
      await collect(words, null)
      searched.push(...words)
    }
  }

  let candidates = [...byId.values()].sort((a, b) => b.score - a.score).slice(0, MAX_CONTEXT_ENTRIES)

  // Last resort: hand over recent entries and let the grounded answerer judge.
  // Honest for a personal store; it simply finds nothing in a very large one.
  let fellBack = false
  if (!candidates.length) {
    const recent = await flow
      .listEntries({ kind, limit: MAX_CONTEXT_ENTRIES })
      .catch(() => [] as flow.Entry[])
    candidates = recent.map((e) => ({ ...e, score: 0, snippet: null }))
    fellBack = candidates.length > 0
  }

  if (!candidates.length) {
    return {
      question: q,
      answer: `Nothing in your memory matches that. I searched for: ${searched.join(', ')}.`,
      searched,
      sources: [],
    }
  }

  // Notes carry the later thinking, which is often the actual answer.
  const enriched = await Promise.all(
    candidates.slice(0, 8).map((c) => flow.getEntry(c.id).catch(() => null)),
  )
  const context = candidates.map((c, i) => asContext(enriched[i] ?? c)).join('\n\n---\n\n')

  const answer = await chat({
    system: [
      "You answer questions about a person's own memory, using only the entries below.",
      fellBack
        ? 'Note: keyword search found nothing for this question, so these are simply their most recent entries. Most are probably irrelevant. Say you found nothing unless one genuinely answers the question.'
        : '',
      `Today is ${now.slice(0, 10)}. You are speaking to the person whose memories these are — say "you".`,
      '',
      'Rules:',
      '- Answer only from the entries. If they do not contain the answer, say so plainly and say what',
      '  you did find. Never fill a gap with general knowledge — a personal memory system that',
      '  invents your past is worthless.',
      '- Cite the entries you used by their short id in brackets, e.g. [3c94cd22].',
      '- Be brief and direct. Two or three sentences unless the question genuinely needs more.',
      '- Their own words in an entry are evidence of what they thought. Quote them where it helps.',
      '- If entries conflict or one is much older, say so rather than silently picking one.',
    ].join('\n'),
    user: `Question: ${q}\n\nEntries from memory:\n\n${context}`,
  })

  return {
    question: q,
    answer,
    searched: queries,
    sources: candidates.map((c) => ({ id: c.id, kind: c.kind, title: c.title })),
  }
}
