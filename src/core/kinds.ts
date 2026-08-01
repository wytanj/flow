/**
 * Kinds are an open vocabulary — the database accepts any string, so a new sort
 * of memory never needs a migration. These are the ones flow understands well
 * enough to pick sensible defaults for.
 */
export const KINDS = ['thought', 'movie', 'person', 'reading', 'task', 'fact', 'place', 'idea'] as const

export type Kind = (typeof KINDS)[number] | (string & {})

const ALIASES: Record<string, string> = {
  note: 'thought',
  thoughts: 'thought',
  memo: 'thought',
  film: 'movie',
  show: 'movie',
  tv: 'movie',
  series: 'movie',
  watchlist: 'movie',
  contact: 'person',
  connection: 'person',
  linkedin: 'person',
  people: 'person',
  article: 'reading',
  essay: 'reading',
  book: 'reading',
  writing: 'reading',
  post: 'reading',
  paper: 'reading',
  todo: 'task',
  reminder: 'task',
  project: 'idea',
  restaurant: 'place',
}

export function normalizeKind(kind?: string | null): string {
  if (!kind) return 'thought'
  const k = kind.trim().toLowerCase()
  return ALIASES[k] ?? k
}

/** Default lifecycle status for a kind, when the caller did not state one. */
export function defaultStatus(kind: string): string | null {
  switch (kind) {
    case 'movie':
      return 'want'
    case 'task':
      return 'open'
    case 'reading':
      return 'queued'
    default:
      return null
  }
}

/** Statuses that mean "no longer outstanding", used by the open/pending views. */
export const DONE_STATUSES = ['watched', 'done', 'read', 'dropped', 'abandoned', 'cancelled']

/**
 * Fields worth filling in per kind. Surfaced to the model so a capture of a
 * person tends to carry a company, and a movie tends to carry a year.
 */
export const DATA_HINTS: Record<string, string> = {
  movie: 'year, director, service (where to watch), recommended_by, runtime',
  person: 'company, role, linkedin, met_at (where/event), met_on (date), location, mutual, follow_up',
  reading: 'url, author, source, published',
  place: 'city, address, cuisine, recommended_by',
  task: 'context, blocked_by',
  thought: 'anything worth keeping alongside the thought',
}
