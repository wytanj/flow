/**
 * Link enrichment.
 *
 * A bare URL carries no words of its own, so an entry built from one has
 * nothing to title itself with and ends up borrowing whatever was nearby —
 * often the shelf it was being filed under. Fetching the page's own title and
 * description fixes that at the source.
 *
 * The division of labour matters: what comes back from the page describes the
 * *link*, and goes in `data`. The body stays reserved for what you said about
 * it. A fetched summary must never overwrite your own take.
 */

export interface LinkMeta {
  url: string
  title?: string
  description?: string
  site?: string
  author?: string
}

const URL_RE = /https?:\/\/[^\s<>()"'\]]+/i

export function extractUrl(...texts: (string | null | undefined)[]): string | null {
  for (const text of texts) {
    const match = text?.match(URL_RE)
    if (match) return match[0].replace(/[.,;:!?]+$/, '')
  }
  return null
}

export function isUrlOnly(text: string | null | undefined): boolean {
  const t = text?.trim()
  return Boolean(t && /^https?:\/\/\S+$/i.test(t))
}

/**
 * A title is weak when it does not identify the thing: absent, a raw URL, or
 * simply the name of the shelf it was filed under (the failure this exists to
 * prevent — "put this link into hardware" titling the entry "hardware").
 */
export function isWeakTitle(title: string | null | undefined, tags: string[] = []): boolean {
  const t = title?.trim()
  if (!t || t.length < 3) return true
  if (isUrlOnly(t)) return true
  if (/^https?:\/\//i.test(t)) return true
  const lower = t.toLowerCase()
  // one bare word that is also a tag on this entry is a shelf name, not a title
  if (!t.includes(' ') && tags.some((tag) => tag.toLowerCase() === lower)) return true
  return false
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", mdash: '—', ndash: '–',
}

function decode(s: string): string {
  return s
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
      const key = code.toLowerCase()
      if (ENTITIES[key]) return ENTITIES[key]
      if (key.startsWith('#x')) return String.fromCodePoint(parseInt(key.slice(2), 16))
      if (key.startsWith('#')) return String.fromCodePoint(Number(key.slice(1)))
      return whole
    })
    .replace(/\s+/g, ' ')
    .trim()
}

function meta(html: string, ...names: string[]): string | undefined {
  for (const name of names) {
    // property= and name= appear in either order relative to content=
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${name}["']`, 'i'),
    ]
    for (const re of patterns) {
      const found = html.match(re)?.[1]
      if (found?.trim()) return decode(found)
    }
  }
  return undefined
}

/** Reads at most `cap` bytes — the head is all we need, and pages can be huge. */
async function readCapped(res: Response, cap = 250_000): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < cap) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.length
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(
    chunks.length === 1 ? chunks[0] : Buffer.concat(chunks.map((c) => Buffer.from(c))),
  )
}

/**
 * Best-effort. Returns null on anything unexpected — a slow or hostile page
 * must never stop a thought being saved.
 */
export async function fetchLinkMeta(url: string, timeoutMs = 6_000): Promise<LinkMeta | null> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        // plenty of sites serve nothing useful to an unidentified client
        'user-agent': 'Mozilla/5.0 (compatible; flow/0.1; +personal memory bot)',
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en',
      },
    })
    if (!res.ok) return null
    if (!(res.headers.get('content-type') ?? '').includes('html')) return null

    const html = await readCapped(res)
    const title =
      meta(html, 'og:title', 'twitter:title') ??
      (html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i)?.[1]
        ? decode(html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i)![1]!)
        : undefined)

    const description = meta(html, 'og:description', 'twitter:description', 'description')
    const site = meta(html, 'og:site_name') ?? new URL(res.url || url).hostname.replace(/^www\./, '')
    const author = meta(html, 'author', 'article:author')

    return {
      url: res.url || url,
      title: title?.slice(0, 200),
      description: description?.slice(0, 500),
      site,
      author: author?.slice(0, 120),
    }
  } catch {
    return null
  }
}
