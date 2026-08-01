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

/**
 * Titles that identify a page within a site but say nothing on their own. A
 * docs page called "Overview" is indistinguishable from every other docs page
 * called "Overview" once it is sitting on a shelf.
 */
const GENERIC_TITLES = new Set([
  'overview', 'home', 'homepage', 'docs', 'documentation', 'introduction', 'intro',
  'getting started', 'welcome', 'index', 'readme', 'about', 'blog', 'api', 'guide',
  'reference', 'dashboard', 'login', 'sign in', 'untitled', 'faq', 'pricing',
])

// subdomains that describe a section rather than the thing itself
const SUBDOMAINS = new Set(['docs', 'blog', 'app', 'www', 'developer', 'developers', 'help', 'support', 'en'])

/** A human name for the site: og:site_name if it is a real name, else the domain. */
function siteName(metaSite: string | undefined, url: string): string | undefined {
  // og:site_name is sometimes just the hostname again, which is no better
  if (metaSite && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(metaSite)) return metaSite
  try {
    const parts = new URL(url).hostname.replace(/^www\./, '').split('.').filter((p) => !SUBDOMAINS.has(p))
    const label = parts.length > 1 ? parts[parts.length - 2] : parts[0]
    return label ? label.charAt(0).toUpperCase() + label.slice(1) : metaSite
  } catch {
    return metaSite
  }
}

/**
 * Last resort when the page yields no metadata at all — a PDF, a login wall, a
 * dead host. The URL's final segment is often the title in disguise:
 * ".../1a%20Occasional%20Paper%20on%20Income%20Growth..." is a real title once
 * decoded, and infinitely better than storing the raw URL as the name.
 */
export function titleFromUrl(url: string): string | undefined {
  try {
    const path = new URL(url).pathname
    const last = path.split('/').filter(Boolean).pop()
    if (!last) return undefined
    const cleaned = decodeURIComponent(last)
      .replace(/\.(pdf|html?|php|aspx?|md|txt|docx?)$/i, '')
      .replace(/[_+-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    // ids and hashes are not titles
    if (cleaned.length < 4 || cleaned.length > 120) return undefined
    if (!/[a-z]{3}/i.test(cleaned)) return undefined
    if (/^[0-9a-f-]{16,}$/i.test(cleaned)) return undefined
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
  } catch {
    return undefined
  }
}

/** "Overview" on docs.colossus.credit becomes "Colossus — Overview". */
function qualifyTitle(title: string | undefined, site: string | undefined, url: string): string | undefined {
  const t = title?.trim()
  if (!t) return undefined
  if (!GENERIC_TITLES.has(t.toLowerCase()) && t.length >= 8) return t
  const name = siteName(site, url)
  if (!name || t.toLowerCase().includes(name.toLowerCase())) return t
  return `${name} — ${t}`
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
    const finalUrl = res.url || url
    const site = siteName(meta(html, 'og:site_name'), finalUrl)
    const author = meta(html, 'author', 'article:author')

    return {
      url: finalUrl,
      title: qualifyTitle(title, site, finalUrl)?.slice(0, 200),
      description: description?.slice(0, 500),
      site,
      author: author?.slice(0, 120),
    }
  } catch {
    return null
  }
}
