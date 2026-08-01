# flow

**A personal memory you can talk to.** Put things in from wherever you are; get them back by
asking in plain language.

A stray thought at 2am. A film someone recommended. What you actually made of an essay. The
person you met at a conference whose name will be gone by Thursday. One store, several ways in,
and an agent that can read and write it while you're mid-conversation.

```
you  → "put this into hardware: https://blueprint.io"
flow → Blueprint — AI hardware design tool   reading · queued · #hardware
       (fetched the title itself, filed it on the shelf, kept your words separate)

you  → "did I ever save anything about designing physical things?"
flow → Blueprint — an AI platform for hardware design. You queued it to look at
       properly. [0d12129f]
```

---

## Why it exists

Note-taking apps are filing cabinets: you organise on the way in, and searching means
remembering the word you used. flow inverts that. **Capture is one sentence with no structure,
and recall is a question.** The organising happens on the way out.

Three ideas do most of the work:

**One table for everything.** A thought, a film, a person, a link with your take on it — all
`entries`, distinguished by `kind`, with kind-specific fields in JSONB. Adding a new sort of
memory never needs a migration.

**Shelves are tags, not folders.** "Put this into hardware" makes `hardware` a shelf. Things
live on several shelves at once, which is how thinking actually works.

**Your words are the memory.** When flow fetches a link's title and description, those go in
`data` — your reaction stays in `body`, untouched. What a page says about itself is not what
you thought about it.

---

## Quickstart

```bash
git clone https://github.com/wytanj/flow && cd flow
npm install
cp .env.example .env        # set a Postgres URL; everything else is optional
npm run migrate             # idempotent
npm run flow -- "first thought"
npm run flow -- recall first
```

That's the whole floor: **a Postgres URL and nothing else.** No API keys, no accounts, no
paid tier. Every model-powered feature is additive on top.

| You have | You get |
| --- | --- |
| Postgres | capture, full-text + fuzzy recall, shelves, MCP — the whole store |
| + an embeddings provider | hybrid recall, so "that thing about atoms not bits" finds it |
| + a chat model | `/jot` (free text → structured entries) and `/ask` (grounded answers) |

Any agent works at every level, because the agent brings its own intelligence.

---

## Surfaces

| | | |
| --- | --- | --- |
| **MCP** | Claude et al. read and write your memory mid-conversation | stdio, or `/mcp` when deployed |
| **Web** | open it and type | the deployment root |
| **REST** | shortcuts, scripts, cron | `/capture`, `/search`, … |
| **CLI** | capture without leaving the terminal | `npm run flow -- "…"` |
| **Telegram** | text your memory from your phone | `/telegram/webhook` |

### MCP

Twelve tools: `flow_capture`, `flow_recall`, `flow_get`, `flow_list`, `flow_update`,
`flow_note`, `flow_link`, `flow_watchlist`, `flow_people`, `flow_due`, `flow_briefing`,
`flow_delete`.

```bash
# locally, over stdio
claude mcp add flow --scope user -- npx tsx /absolute/path/to/flow/src/mcp/server.ts
```

For the Claude apps, add a custom connector pointing at your deployment:

```
https://<your-deployment>/mcp/<FLOW_API_TOKEN>
```

The token rides in the path because the apps take a URL and little else. That's weaker than a
header — URLs land in browser history and proxy logs — so treat the link as the secret it is.
`Authorization: Bearer <token>` against `/mcp` also works, and is better wherever a client can
send headers.

The server ships instructions telling the model to capture without asking permission, to treat
"file this under X" as a tag rather than a title, and to check memory before claiming it
doesn't know something about you.

### Web

Paste your token once (kept in `localStorage`, never in the URL) and the cursor lands in the
box. One input, two modes: **remember** structures what you type, **ask** answers from what
you've saved with clickable citations. Below it, shelves, kind filters, live search, and
entries that expand to show their notes and links. One static file, no build step. Add it to
your phone's home screen and it behaves like an app.

### CLI

```bash
npm run flow -- "kubernetes retries are eating our p99"   # straight capture
npm run flow -- jot "messy multi-part brain dump"         # a model structures it
npm run flow -- ask "did i like that wenders film?"
npm run flow -- movie "Perfect Days" --tags slow,japan
npm run flow -- recall linkedin
npm run flow -- watchlist | people | due | brief
```

### REST

Bearer auth on everything except `/health`.

| Route | |
| --- | --- |
| `POST /capture` | JSON, or `text/plain` for a bare thought |
| `POST /jot` | free text → structured entries (needs a chat model) |
| `GET\|POST /ask` | question answered from your entries, with citations |
| `GET /search?q=&kind=&tags=` | ranked recall with match snippets |
| `GET /entries` · `GET /entries/:id` | list / open one, with notes and links |
| `PATCH /entries/:id` · `DELETE /entries/:id` | update (merges `data`) / remove |
| `POST /entries/:id/notes` | append a timestamped thought |
| `POST /links` | `{from, to, rel}` |
| `GET /shelves` | every shelf with a count |
| `GET /watchlist` · `GET /people` | the built-in views |
| `GET /due` · `GET /briefing` · `GET /stats` | resurfacing |
| `GET /embeddings` | provider, coverage, whether recall is hybrid |
| `GET /health` | unauthenticated; reports which optional layers are on |

`:id` takes a full uuid, the short id shown in listings, **or an exact title** — so
`PATCH /entries/Perfect%20Days` works. Ambiguous references are rejected rather than guessed.

### Capturing from a device

Anything that captures offline and syncs later — a phone, a bot, a dedicated device — will
eventually retry a request it already delivered. Send a client-generated id and the retry
becomes a no-op instead of a second copy of the same memory:

```bash
curl -X POST $U/capture -H "Authorization: Bearer $T" \
     -H 'Idempotency-Key: 7f3c…' -H 'Content-Type: application/json' \
     -d '{"body":"tide tables are a scheduling problem"}'
```

Either the `Idempotency-Key` header or a `capture_id` field works, on `/capture` and `/jot`.
The response carries `created` — `true` when it stored something, `false` when it recognised a
replay — and the status is **201** or **200** to match, so a client can tell without parsing.

Replays short-circuit before any work: no link fetch, no embedding, no model call. Measured at
75ms against 1121ms for the original. Concurrent retries are safe too — a partial unique index
plus `ON CONFLICT` means two simultaneous flushes of the same id produce one row, verified.

A jot that becomes several entries suffixes the id per entry (`<id>#0`, `#1`), so retrying a
multi-part brain dump lands on the same rows rather than duplicating all of them.

**Generate one id per captured thought, not per request** — reuse it across every retry of that
thought, never across different thoughts. Without an id, repeats are allowed: two identical
captures are two entries, because nothing claimed they were the same event.

---

## Bring your own

Three layers, each independently swappable.

### 1. The agent — already yours

MCP *is* the interface. Claude Code, Claude apps, Cursor, Zed, a homemade loop. flow has no
opinion about who is driving, and no agent-specific code.

### 2. The chat model — any OpenAI-compatible endpoint

Powers `/jot` and `/ask` only. Unset it and those two return 503; nothing else notices.

```bash
FLOW_LLM_URL=https://api.x.ai/v1        FLOW_MODEL=grok-4.5
FLOW_LLM_URL=https://api.openai.com/v1  FLOW_MODEL=gpt-4.1-mini
FLOW_LLM_URL=http://localhost:11434/v1  FLOW_MODEL=qwen3:8b     # ollama, no key
FLOW_LLM_KEY=...                                                # omitted for local
```

One finding worth inheriting: **don't use a cheap non-reasoning model for extraction.** In
testing, one silently dropped two of three memories from a multi-part note. Being told
something and never storing it is the only failure this system can't recover from.

### 3. Embeddings — the one that leaves state behind

```bash
FLOW_EMBEDDINGS=ollama:qwen3-embedding:0.6b     # local, Apache 2.0, no key
FLOW_EMBEDDINGS=gemini:gemini-embedding-001     # hosted, generous free tier
FLOW_EMBEDDINGS=openai:text-embedding-3-small   # or any OpenAI-shaped endpoint

npm run embeddings          # provider, coverage, what's stale
npm run embeddings:sync     # embed what's new, edited, or from another provider
```

Dimensions are **probed from the provider**, never hardcoded, so a model released after this
was written still works.

**The index is derived state.** Vectors live in `flow.embeddings`, never on `flow.entries`, and
can be dropped and rebuilt from the entries at any time. That's what makes switching provider a
rebuild rather than a migration against the table holding your life:

```bash
npm run embeddings:sync -- --rebuild
```

Vectors from two models don't share a vector space, so mixing them silently corrupts every
ranking. flow records the provider on every row and **refuses** to sync across a change rather
than quietly degrading. A full rebuild of a personal store is minutes and cents.

Recall then fuses full-text and vector results by **Reciprocal Rank Fusion** — `ts_rank` and
cosine distance have no shared scale, so ranks are combined rather than scores, which needs no
tuning. Results carry `via: text | vector | both`.

#### Relevance cutoffs, and why they're per-model

Nearest-neighbour search has no concept of "no match": ask for 30 and you get 30, however
unrelated. Without a cutoff, every query returns your entire store. Two filters, doing
different jobs:

- `FLOW_EMBEDDINGS_MAX_DISTANCE` — a ceiling. *Is this plausibly related at all?*
- `FLOW_EMBEDDINGS_MARGIN` — relative, default 0.08. *Is this as good as the best hit?*

The ceiling **has to be per-model**. Measured on a real store, Gemini's space is far more
compressed than the textbook one:

| | cosine distance |
| --- | --- |
| on-topic | 0.32 – 0.34 |
| gibberish | 0.43 |
| unrelated real text | 0.48 – 0.57 |

So the usual 0.6 admits everything, and gibberish scores *better* than genuine off-topic text —
no single absolute cutoff separates them. Hence 0.42 for Gemini, 0.6 elsewhere, plus the
relative margin, which needs no calibration and so is the safer of the two for a model nobody
has profiled. **These were tuned on a small corpus. Re-measure as yours grows.**

Also: pgvector indexes up to 2000 dimensions. Gemini's native 3072 is truncated to 1536 via
Matryoshka by default. Above 2000, flow skips the ANN index and scans exactly — milliseconds at
personal scale.

Entries embed inline on capture and update, not fire-and-forget, because a serverless
invocation dies the moment it responds. Failures are swallowed: **a provider being down never
stops a thought being saved**, it just leaves the entry stale for the next sync.

`stub:64` is a test-only provider producing deterministic bag-of-words vectors, so the whole
pipeline — dimension probing, staleness, fusion, provider-change detection — runs in CI with no
key and no network.

---

## Catch up — what changed out there

Shelve a few links, come back in a month, and ask *what's up with these guys?* flow looks each
one up and appends what it finds as a **dated, sourced note**.

```bash
npm run flow -- catchup goodmoney      # sweep a shelf, oldest-checked first
```

In the web app a shelf shows how long since it was caught up, a staleness pill per link, and a
*catch me up* button. Over MCP it is `flow_catch_up`.

**It is append-only, and that is the whole design.** Nothing here rewrites a title, body, tag or
shelf. Where something sits is your judgement about what it is *to you*, and a web search does
not get to overrule that — a pivot or acquisition is reported in the note for you to act on.
Equally, "nothing happened" writes no note at all; a memory full of *nothing changed* is worse
than one that stays quiet.

Research notes carry `source='research'` and render distinctly, so in a year you can still tell
which thoughts were yours.

### Two research shapes

| | how | speed | date window |
| --- | --- | --- | --- |
| **retrieval** (`EXA_API_KEY`) | Exa returns documents, your own model summarises them | ~15s | **enforced by the index** |
| **agentic** (xAI / OpenAI) | hosted `web_search`, the model drives | ~35s | asked for in the prompt |
| none | re-reads the page and reports what moved | ~1s | n/a |

Retrieval wins for this job because catch-up is entirely *"since I last looked"*.
`startPublishedDate` makes that a hard constraint rather than an instruction a model may
quietly ignore. On the same entry it was both faster and better — it caught a company's pivot
that the agentic search missed.

Exa is selected automatically when `EXA_API_KEY` is present; `FLOW_RESEARCH=exa|agentic|off`
overrides. With neither key, catch-up still works by re-reading the page.

Repeat sweeps are told what has already been recorded, so they do not write the same note twice.

---

## Running it entirely locally

No cloud, no keys, nothing leaving your machine. Reasonable for a store that holds your life.

```bash
# 1. Postgres with pgvector
docker run -d --name flow-db -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=flow pgvector/pgvector:pg17

# 2. Models
ollama pull qwen3-embedding:0.6b     # embeddings
ollama pull qwen3:8b                 # /jot and /ask

# 3. .env
FLOW_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/flow
FLOW_EMBEDDINGS=ollama:qwen3-embedding:0.6b
FLOW_LLM_URL=http://localhost:11434/v1
FLOW_MODEL=qwen3:8b
FLOW_API_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# 4. Go
npm run migrate && npm run embeddings:sync
npm run api          # http://127.0.0.1:8787
```

Local embeddings also cut query latency from a ~200ms API round trip to tens of milliseconds,
which matters if you ever want flow suggesting things *during* a conversation.

The API binds to `127.0.0.1` by default and refuses to bind a public interface with a token
under 32 characters.

---

## Deploying

One Vercel function serves REST, MCP and the Telegram webhook.

```bash
npx vercel link
npx vercel env add FLOW_DATABASE_URL production    # TRANSACTION pooler, port 6543
npx vercel env add FLOW_API_TOKEN production
npx vercel deploy --prod
```

Two things that will bite:

- **Use the transaction pooler (6543), not the session pooler (5432).** Concurrent invocations
  exhaust session-mode connections. The pool also drops to `max: 1` when `VERCEL` is set.
- **`api/index.ts` exports `fetch`, not `default`.** Vercel's Node runtime calls a default
  export with Node's `(req, res)` and discards what it returns, leaving the app hanging until
  the request times out.

A deployment can't reach an Ollama on your laptop, so a deployed flow needs a hosted embeddings
provider even if local development uses Ollama. They're independent settings.

### Telegram

Dormant until configured. Text the bot to capture, prefix `?` to ask, `/brief` `/watchlist`
`/due` for the views.

1. Get a token from [@BotFather](https://t.me/botfather).
2. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` locally **and** in the deployment.
3. `npm run telegram:register -- https://<deployment>/telegram/webhook`
4. Message the bot; it refuses you and replies with your chat id.
5. Put that in `TELEGRAM_ALLOWED_CHAT_IDS` and redeploy.

Step 4 is deliberate. An open bot is an open write endpoint into your private memory, so with
no allowlist every chat is refused.

---

## Data model

```
entries          the universal unit — kind, title, body, data(jsonb), tags[], status,
                 rating, occurred_at, remind_at, search(tsvector)
notes            timestamped thoughts appended to an entry over time
links            from → rel → to  ("Daniel recommended Perfect Days")
embeddings       optional, derived, rebuildable
```

Known kinds — `thought`, `movie`, `person`, `reading`, `task`, `fact`, `place`, `idea` — with
suggested `data` fields each. Any other string works too; common synonyms fold in
(`film`→`movie`, `connection`→`person`, `essay`→`reading`).

Notes exist so a person or a film becomes a running thread rather than one overwritten blob,
and note text folds into the parent's search vector — a thought added months later is as
findable as the original capture.

Everything lives in a `flow` schema reached over a direct Postgres connection, deliberately
**not** in `public`, so Supabase's PostgREST layer never exposes it with an anon key.

---

## Design notes

Things that cost something to learn:

**Duplicates are surfaced, not merged.** A second "Perfect Days" comes back with the existing
one flagged as a `possible_duplicate` for the caller to resolve. Silently merging memories is
worse than having two.

**A shelf name is never a title.** Naming an entry after the shelf it went onto gives every
entry on that shelf the same name and none of them are recognisable later. Both model layers
are told this, and `isWeakTitle()` catches it mechanically when they forget.

**Link enrichment splits the page's words from yours.** Title and description come from the
page; the body stays whatever you said. Best-effort with a 6s timeout — a dead link still saves
in milliseconds.

**Nothing is destroyed by default.** Prefer archiving; `flow_delete` and `DELETE /entries/:id`
are permanent.

**Reminders are pull, not push.** `remind_at` surfaces an entry in `/due` and the briefing.
Nothing notifies you yet.

---

## Development

```bash
npm run migrate      # apply schema (idempotent)
npm run api          # local server
npm run mcp          # stdio MCP server
npm run smoke        # drives all 12 MCP tools over a real transport, cleans up after itself
npm run typecheck
```

`npm run smoke` runs against a real database and deletes only what it created.

## Status

Working and in daily use, but young — expect rough edges. Not yet built: push reminders, a
shared/multi-user mode, and anything resembling access control beyond a single bearer token.
