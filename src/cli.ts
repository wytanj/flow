#!/usr/bin/env -S npx tsx
/**
 * Terminal capture, for when opening a chat window is more friction than the
 * thought is worth:
 *
 *   npm run flow -- "kubernetes retries are eating our p99"
 *   npm run flow -- movie "Perfect Days" --tags slow,japan
 *   npm run flow -- recall linkedin
 *   npm run flow -- brief
 */
import { ask } from './ai/ask.js'
import { smartCapture } from './ai/extract.js'
import { catchUpEntry, shelfQueue } from './core/catchup.js'
import * as flow from './core/flow.js'
import { formatEntryLine, formatList, formatSearch } from './core/format.js'
import { closePool } from './db.js'
import { KINDS } from './core/kinds.js'

const argv = process.argv.slice(2)

/** Pulls `--flag value` and `--flag=value` pairs out, leaving positionals. */
function parseFlags(args: string[]) {
  const flags: Record<string, string> = {}
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (!a.startsWith('--')) {
      rest.push(a)
      continue
    }
    const [key, inline] = a.slice(2).split('=', 2)
    if (!key) continue
    if (inline !== undefined) flags[key] = inline
    else if (args[i + 1] && !args[i + 1]!.startsWith('--')) flags[key] = args[++i]!
    else flags[key] = 'true'
  }
  return { flags, rest }
}

const HELP = `flow — personal memory

  flow "<thought>"                 capture a thought
  flow <kind> "<title>" [--body]   capture a typed memory (${KINDS.join(', ')})
  flow jot "<anything>"            let a model structure it — may create several entries
  flow ask "<question>"            answer a question from your own memory
  flow catchup <shelf|id>          look up what changed in the world, note it
  flow recall <query>              search everything
  flow list [--kind k]             recent entries
  flow watchlist [--all]           movies still to watch
  flow people [query]              remembered people
  flow due [--days n]              reminders that have landed
  flow brief                       everything at a glance

  flags: --tags a,b  --body text  --status s  --rating n  --remind <iso>  --limit n
`

async function main() {
  const { flags, rest } = parseFlags(argv)
  const [head, ...tail] = rest
  const tags = flags.tags?.split(',').map((t) => t.trim()).filter(Boolean)
  const limit = flags.limit ? Number(flags.limit) : undefined

  if (!head || head === 'help' || flags.help) {
    console.log(HELP)
    return
  }

  switch (head) {
    case 'jot': {
      const { entries, duplicates } = await smartCapture(tail.join(' '), 'cli', flags.id)
      for (const e of entries) console.log(formatEntryLine(e))
      for (const d of duplicates) {
        const dupe = d.existing.map((x) => `${x.id.slice(0, 8)} ${x.title}`).join(', ')
        console.log(`  ! ${d.entry_id.slice(0, 8)} may duplicate: ${dupe}`)
      }
      return
    }
    case 'ask': {
      const res = await ask(tail.join(' '), { kind: flags.kind })
      console.log(res.answer)
      if (res.sources.length) {
        console.log(`\nfrom ${res.sources.length} entries · searched: ${res.searched.join(', ')}`)
      }
      return
    }
    case 'catchup': {
      const target = tail.join(' ')
      if (!target) { console.log('Give a shelf or an entry.'); return }
      const shelfEntries = await shelfQueue(target, Number(flags.limit) || 10)
      const ids = shelfEntries.length ? shelfEntries.map((e) => e.id) : [await flow.resolveId(target)]
      for (const id of ids) {
        const r = await catchUpEntry(id)
        if (r.changed) {
          console.log(`\n${r.title}\n  ${r.note?.replace(/\n/g, '\n  ')}`)
        } else {
          console.log(`\n${r.title} — nothing new${r.skipped ? ` (${r.skipped})` : ''}`)
        }
      }
      return
    }
    case 'recall': {
      const query = tail.join(' ')
      console.log(formatSearch(query, await flow.search(query, { kind: flags.kind, tags, limit })))
      return
    }
    case 'list':
      console.log(formatList(await flow.listEntries({ kind: flags.kind, tags, status: flags.status, limit })))
      return
    case 'watchlist':
      console.log(
        formatList(
          flags.all ? await flow.listEntries({ kind: 'movie', limit: 200 }) : await flow.open('movie'),
          'Watchlist is empty.',
        ),
      )
      return
    case 'people': {
      const query = tail.join(' ')
      console.log(
        formatList(
          query ? await flow.search(query, { kind: 'person', limit }) : await flow.listEntries({ kind: 'person', limit }),
          'No people remembered yet.',
        ),
      )
      return
    }
    case 'due':
      console.log(formatList(await flow.due(Number(flags.days) || 0), 'Nothing due.'))
      return
    case 'brief': {
      const b = await flow.briefing()
      console.log(`flow — ${b.stats.total} memories, ${b.stats.captured_last_7_days} this week`)
      console.log(b.stats.by_kind.map((k) => `${k.kind}:${k.count}`).join('  '))
      for (const [label, entries] of [
        ['Due', b.due],
        ['Recent', b.recent],
        ['Watchlist', b.watchlist],
        ['Open tasks', b.open_tasks],
      ] as const) {
        if (entries.length) console.log(`\n${label}\n${formatList(entries)}`)
      }
      return
    }
  }

  // Otherwise it is a capture. A leading known kind types it; anything else is
  // a plain thought, which is the common case and should stay frictionless.
  const isKind = (KINDS as readonly string[]).includes(head)
  const { entry } = await flow.capture({
    kind: isKind ? head : 'thought',
    title: isKind ? tail.join(' ') || undefined : undefined,
    body: isKind ? flags.body : rest.join(' '),
    tags,
    status: flags.status,
    rating: flags.rating ? Number(flags.rating) : undefined,
    remind_at: flags.remind,
    source: 'cli',
    capture_id: flags.id,
  })
  console.log(`Captured [${entry.id.slice(0, 8)}] ${entry.title ?? ''} (${entry.kind})`)
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(closePool)
