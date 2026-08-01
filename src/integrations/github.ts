/**
 * GitHub stars.
 *
 * You star things as you find them and think about them later. Syncing brings
 * the set into flow so "that agent-harness project from my git" is a question
 * flow can answer — and so your take on one lands on the same entry as the
 * repo itself, the way a link and your commentary do.
 *
 * Works with no token at all if your stars are public (GITHUB_USER); a token
 * adds private stars and lifts the rate limit.
 */
import { capture } from '../core/flow.js'
import type { Integration, SyncResult } from './types.js'

interface StarredItem {
  starred_at?: string
  repo?: GitHubRepo
}

interface GitHubRepo {
  id: number
  full_name: string
  html_url: string
  description: string | null
  language: string | null
  stargazers_count: number
  topics?: string[]
  homepage?: string | null
  pushed_at?: string
  archived?: boolean
  owner?: { login: string }
}

const API = 'https://api.github.com'

function token(): string | undefined {
  return process.env.GITHUB_TOKEN?.trim() || undefined
}

function user(): string | undefined {
  return process.env.GITHUB_USER?.trim() || undefined
}

async function fetchPage(page: number): Promise<StarredItem[]> {
  // /user/starred is the authenticated user's own stars, including private
  // ones; /users/:login/starred needs no token but only sees public stars.
  const url = token()
    ? `${API}/user/starred?per_page=100&page=${page}`
    : `${API}/users/${user()}/starred?per_page=100&page=${page}`

  const res = await fetch(url, {
    headers: {
      // this Accept is what makes GitHub return starred_at alongside the repo
      accept: 'application/vnd.github.star+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'flow-personal-memory',
      ...(token() ? { authorization: `Bearer ${token()}` } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  })

  if (res.status === 401 || res.status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining')
    throw new Error(
      remaining === '0'
        ? 'GitHub rate limit reached. Set GITHUB_TOKEN to raise it from 60/hour to 5000.'
        : `GitHub rejected the request (${res.status}). Check GITHUB_TOKEN.`,
    )
  }
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`)

  const json = (await res.json()) as StarredItem[] | GitHubRepo[]
  // with the star+json Accept we get {starred_at, repo}; without it, bare repos
  return (json as StarredItem[]).map((item) =>
    item.repo ? item : ({ repo: item as unknown as GitHubRepo } as StarredItem),
  )
}

export const github: Integration = {
  id: 'github',
  label: 'GitHub stars',
  requires: 'GITHUB_USER (public stars) or GITHUB_TOKEN (adds private stars, higher rate limit)',

  configured() {
    return Boolean(token() || user())
  },

  async sync(opts = {}): Promise<SyncResult> {
    if (!this.configured()) throw new Error(`Not configured — needs ${this.requires}`)

    const limit = opts.limit ?? 500
    const items: StarredItem[] = []
    for (let page = 1; page <= 10 && items.length < limit; page++) {
      const batch = await fetchPage(page)
      items.push(...batch)
      if (batch.length < 100) break
    }

    let imported = 0
    let skipped = 0

    for (const item of items.slice(0, limit)) {
      const repo = item.repo
      if (!repo?.id) continue

      // The repo's own words go in data, exactly as a fetched page's do — the
      // body stays empty and reserved for whatever you eventually say about it.
      const { created } = await capture({
        kind: 'repo',
        title: repo.full_name,
        data: {
          url: repo.html_url,
          summary: repo.description ?? undefined,
          owner: repo.owner?.login,
          language: repo.language ?? undefined,
          stars: repo.stargazers_count,
          topics: repo.topics?.length ? repo.topics.join(', ') : undefined,
          homepage: repo.homepage || undefined,
          pushed_at: repo.pushed_at,
          archived: repo.archived ? 'yes' : undefined,
          source: 'github',
        },
        // 'starred' means collected but not yet thought about; it is what keeps
        // imports out of the briefing until you engage with one.
        status: 'starred',
        occurred_at: item.starred_at,
        source: 'github',
        capture_id: `github:repo:${repo.id}`,
        // we already have better metadata than a page fetch would give us
        enrich: false,
      })

      if (created) imported++
      else skipped++
    }

    return {
      source: this.id,
      imported,
      skipped,
      total_seen: items.length,
      note: token() ? undefined : 'Public stars only — set GITHUB_TOKEN to include private ones.',
    }
  },
}
