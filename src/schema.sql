-- flow: personal memory store
-- Everything lives in the `flow` schema, reached over a direct Postgres
-- connection. It is deliberately NOT in `public`, so Supabase's PostgREST
-- (anon/service keys) does not expose any of it to the internet.

create extension if not exists pgcrypto;

create schema if not exists flow;

-- ---------------------------------------------------------------------------
-- entries: the universal unit of memory
-- ---------------------------------------------------------------------------
-- One table for every kind of thing worth remembering. `kind` says what it is,
-- `data` holds the fields only that kind cares about. Adding a new kind of
-- memory later needs no migration.
--
--   thought  a stray idea, no structure           data: {}
--   movie    watchlist item                       data: {year, director, service, recommended_by}
--   person   someone met / LinkedIn connection    data: {company, role, linkedin, met_at, met_on}
--   reading  article, book, essay + my take       data: {url, author, source}
--   task     something to do                      data: {}
--   fact     a durable fact about my life         data: {}
--   place    somewhere to go                      data: {city, address}
--   idea     something to build or try            data: {}
create table if not exists flow.entries (
  id          uuid primary key default gen_random_uuid(),
  kind        text        not null default 'thought',
  title       text,
  body        text,
  data        jsonb       not null default '{}'::jsonb,
  tags        text[]      not null default '{}',
  -- open vocabulary, meaningful per kind: movie -> want|watching|watched|dropped,
  -- task -> open|done, person -> lead|friend|colleague, reading -> queued|read
  status      text,
  rating      int         check (rating is null or rating between 1 and 10),
  occurred_at timestamptz,  -- when the thing itself happened (met them, saw it)
  remind_at   timestamptz,  -- when to resurface this
  source      text        not null default 'api',   -- mcp | api | cli
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  search      tsvector
);

-- notes: thoughts accreted onto an entry over time, each timestamped, so a
-- person or a movie becomes a running thread rather than one overwritten blob.
create table if not exists flow.notes (
  id         uuid primary key default gen_random_uuid(),
  entry_id   uuid not null references flow.entries(id) on delete cascade,
  body       text not null,
  created_at timestamptz not null default now()
);

-- Added later; kept as alters so the schema stays replayable on a live store.
-- last_checked_at: when this was last looked up against the outside world.
alter table flow.entries add column if not exists last_checked_at timestamptz;
-- source: who wrote a note. 'me' is the user's own thinking and is never
-- rewritten by anything automated; 'research' is dated, sourced, and additive.
alter table flow.notes   add column if not exists source text not null default 'me';

-- capture_id: a client-generated id for one capture attempt, so a phone that
-- buffered offline and retried on a flaky link cannot create the same memory
-- twice. Server-side captures leave it null, hence a partial unique index —
-- nulls are excluded, so unrelated captures never collide.
alter table flow.entries add column if not exists capture_id text;
create unique index if not exists entries_capture_id_idx
  on flow.entries (capture_id) where capture_id is not null;

-- links: "this thought is about that person", "she recommended this film"
create table if not exists flow.links (
  id         uuid primary key default gen_random_uuid(),
  from_id    uuid not null references flow.entries(id) on delete cascade,
  to_id      uuid not null references flow.entries(id) on delete cascade,
  rel        text not null default 'related',
  created_at timestamptz not null default now(),
  unique (from_id, to_id, rel),
  check (from_id <> to_id)
);

-- prompts: what was actually said to flow, before anything interpreted it.
-- Kept so the phrasing itself can be studied — which shelves get reached for,
-- whether a link arrives with a reason attached, how a thought is worded at
-- 2am versus at a desk. The entries are the memory; this is the behaviour.
create table if not exists flow.prompts (
  id        uuid primary key default gen_random_uuid(),
  at        timestamptz not null default now(),
  surface   text not null,                       -- web | api | cli | telegram | mcp
  action    text not null,                       -- jot | capture | ask | flow_capture | …
  input     text,                                -- verbatim, before any parsing
  entry_ids uuid[] not null default '{}',
  tags      text[] not null default '{}',
  kinds     text[] not null default '{}',
  ms        int,
  ok        boolean not null default true,
  error     text
);
create index if not exists prompts_at_idx      on flow.prompts (at desc);
create index if not exists prompts_surface_idx on flow.prompts (surface, at desc);

-- ---------------------------------------------------------------------------
-- full-text search
-- ---------------------------------------------------------------------------
-- Recomputed by trigger rather than a generated column: the vector folds in
-- child note bodies and jsonb values, which a generated column cannot reach.
create or replace function flow.refresh_search(p_id uuid) returns void
language sql as $$
  update flow.entries e set search =
      setweight(to_tsvector('english', coalesce(e.title, '')), 'A')
    || setweight(to_tsvector('english', coalesce(array_to_string(e.tags, ' '), '')), 'A')
    || setweight(to_tsvector('english', coalesce(e.body, '')), 'B')
    || setweight(to_tsvector('english', coalesce(
         (select string_agg(n.body, ' ') from flow.notes n where n.entry_id = e.id), '')), 'B')
    || setweight(to_tsvector('english', coalesce(
         (select string_agg(v, ' ') from jsonb_each_text(e.data) as kv(k, v)), '')), 'C')
  where e.id = p_id;
$$;

create or replace function flow.tg_entries_search() returns trigger
language plpgsql as $$
begin
  perform flow.refresh_search(new.id);
  return null;
end;
$$;

create or replace function flow.tg_notes_search() returns trigger
language plpgsql as $$
begin
  perform flow.refresh_search(coalesce(new.entry_id, old.entry_id));
  return null;
end;
$$;

create or replace function flow.tg_touch() returns trigger
language plpgsql as $$
begin
  -- Checking a link against the world is not an edit to it. If the only thing
  -- that moved is last_checked_at, leave updated_at alone — otherwise every
  -- catch-up would mark the entry's embedding stale for no reason.
  if new.last_checked_at is distinct from old.last_checked_at
     and (to_jsonb(new) - 'updated_at' - 'last_checked_at')
       = (to_jsonb(old) - 'updated_at' - 'last_checked_at') then
    new.updated_at := old.updated_at;
    return new;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists entries_search on flow.entries;
-- fires only on the source columns, so the vector write-back cannot recurse
create trigger entries_search
  after insert or update of title, body, tags, data on flow.entries
  for each row execute function flow.tg_entries_search();

drop trigger if exists notes_search on flow.notes;
create trigger notes_search
  after insert or update or delete on flow.notes
  for each row execute function flow.tg_notes_search();

drop trigger if exists entries_touch on flow.entries;
create trigger entries_touch
  before update on flow.entries
  for each row execute function flow.tg_touch();

-- ---------------------------------------------------------------------------
-- indexes
-- ---------------------------------------------------------------------------
create index if not exists entries_search_idx  on flow.entries using gin (search);
create index if not exists entries_tags_idx    on flow.entries using gin (tags);
create index if not exists entries_data_idx    on flow.entries using gin (data jsonb_path_ops);
create index if not exists entries_kind_idx    on flow.entries (kind, created_at desc);
create index if not exists entries_status_idx  on flow.entries (kind, status);
create index if not exists entries_created_idx on flow.entries (created_at desc);
create index if not exists entries_remind_idx  on flow.entries (remind_at)
  where remind_at is not null and archived_at is null;
create index if not exists notes_entry_idx     on flow.notes (entry_id, created_at desc);
create index if not exists links_from_idx      on flow.links (from_id);
create index if not exists links_to_idx        on flow.links (to_id);

-- trigram matching so "chris nolan" still finds "Christopher Nolan" and
-- typo'd names recall the right person. Optional: skipped if unavailable.
do $$
begin
  create extension if not exists pg_trgm;
  create index if not exists entries_title_trgm_idx
    on flow.entries using gin (title gin_trgm_ops);
exception when others then
  raise notice 'pg_trgm unavailable, fuzzy title match disabled: %', sqlerrm;
end;
$$;
