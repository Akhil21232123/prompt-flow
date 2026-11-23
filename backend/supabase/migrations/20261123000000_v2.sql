-- PromptFlow v2: memory, ask-back questions, fair-use limits and
-- server-side settings merges. Safe to run more than once.

-- ---------------------------------------------------------------------------
-- Clients may insert without sending user_id; row-level security still
-- checks it is their own.
-- ---------------------------------------------------------------------------
alter table public.user_settings alter column user_id set default auth.uid();
alter table public.dictionary_words alter column user_id set default auth.uid();
alter table public.snippets alter column user_id set default auth.uid();
alter table public.dictations alter column user_id set default auth.uid();

-- ---------------------------------------------------------------------------
-- Memory: durable facts about the user, learned or typed in.
-- ---------------------------------------------------------------------------
create table if not exists public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  content text not null check (length(btrim(content)) between 1 and 280),
  kind text not null default 'fact' check (kind in ('fact', 'preference', 'project', 'person')),
  source text not null default 'manual' check (source in ('auto', 'manual')),
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz,
  -- one row per fact per user, whatever the case or spacing
  content_key text generated always as (lower(btrim(content))) stored,
  search tsvector generated always as (to_tsvector('english', content)) stored
);

create unique index if not exists memories_user_content on public.memories (user_id, content_key);
create index if not exists memories_user_updated on public.memories (user_id, pinned desc, updated_at desc);
create index if not exists memories_search on public.memories using gin (search);

alter table public.memories enable row level security;
grant select, insert, update, delete on public.memories to authenticated;
drop policy if exists "own rows" on public.memories;
create policy "own rows" on public.memories for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- updated_at moves when the fact changes, not when it is used.
create or replace function public.memories_touch() returns trigger
language plpgsql as $$
begin
  if new.content is distinct from old.content
     or new.kind is distinct from old.kind
     or new.pinned is distinct from old.pinned then
    new.updated_at = now();
  end if;
  return new;
end $$;

drop trigger if exists memories_touch on public.memories;
create trigger memories_touch before update on public.memories
  for each row execute function public.memories_touch();

-- Pinned memories plus the best full-text matches for a dictation. Any word
-- of the query may match (an OR query), ranked by relevance. Runs as the
-- caller, so row-level security applies.
create or replace function public.match_memories(query text, match_count integer default 6)
returns setof public.memories
language sql stable security invoker set search_path = public as $$
  with q as (
    select (string_agg(quote_literal(lexeme), ' | '))::tsquery as tsq
    from unnest(tsvector_to_array(to_tsvector('english', coalesce(query, '')))) as lexeme
    where lexeme !~ '[\\'']'
  )
  (select m.* from public.memories m
   where m.user_id = auth.uid() and m.pinned
   order by m.updated_at desc
   limit 20)
  union all
  (select m.* from public.memories m, q
   where m.user_id = auth.uid() and not m.pinned
     and q.tsq is not null and m.search @@ q.tsq
   order by ts_rank(m.search, q.tsq) desc, m.updated_at desc
   limit greatest(0, least(coalesce(match_count, 6), 20)))
$$;

revoke all on function public.match_memories(text, integer) from public, anon;
grant execute on function public.match_memories(text, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Ask-back: a pending question, answerable for 10 minutes, used once.
-- ---------------------------------------------------------------------------
create table if not exists public.clarifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  transcript text not null,
  question text not null,
  options jsonb not null default '[]'::jsonb,
  -- the request's mode, app, screen text etc. when the question was asked
  meta jsonb not null default '{}'::jsonb,
  language text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes'
);

create index if not exists clarifications_user on public.clarifications (user_id, expires_at);

alter table public.clarifications enable row level security;
grant select, insert, delete on public.clarifications to authenticated;
drop policy if exists "own rows" on public.clarifications;
create policy "own rows" on public.clarifications for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Fair use: requests per user per UTC day, with a one-minute bucket.
-- Users can read their own counter; only consume_usage writes it.
-- ---------------------------------------------------------------------------
create table if not exists public.usage_daily (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  count integer not null default 0,
  minute_start timestamptz,
  minute_count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

alter table public.usage_daily enable row level security;
revoke all on public.usage_daily from anon, authenticated;
grant select on public.usage_daily to authenticated;
drop policy if exists "own rows" on public.usage_daily;
create policy "own rows" on public.usage_daily for select to authenticated
  using (user_id = auth.uid());

-- Counts one request for the caller if it is within both limits. Atomic:
-- the row is locked while it is checked and bumped. A refused request is
-- not counted. Returns {allowed, code?, today, daily_limit, retry_after_sec?}.
create or replace function public.consume_usage(daily_limit integer default 300, minute_limit integer default 20)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  today date := (now() at time zone 'utc')::date;
  this_minute timestamptz := date_trunc('minute', now());
  r public.usage_daily;
  per_minute integer;
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '28000';
  end if;
  insert into public.usage_daily (user_id, day) values (uid, today)
    on conflict (user_id, day) do nothing;
  select * into r from public.usage_daily
    where user_id = uid and day = today for update;
  per_minute := case when r.minute_start = this_minute then r.minute_count else 0 end;
  if r.count >= daily_limit then
    return jsonb_build_object(
      'allowed', false, 'code', 'quota', 'today', r.count, 'daily_limit', daily_limit,
      'retry_after_sec', greatest(1, ceil(extract(epoch from
        (((today + 1)::timestamp at time zone 'utc') - now())))::integer));
  end if;
  if per_minute >= minute_limit then
    return jsonb_build_object(
      'allowed', false, 'code', 'rate_limited', 'today', r.count, 'daily_limit', daily_limit,
      'retry_after_sec', greatest(1, ceil(extract(epoch from
        ((this_minute + interval '1 minute') - now())))::integer));
  end if;
  update public.usage_daily
    set count = r.count + 1,
        minute_start = this_minute,
        minute_count = per_minute + 1,
        updated_at = now()
    where user_id = uid and day = today;
  return jsonb_build_object('allowed', true, 'today', r.count + 1, 'daily_limit', daily_limit);
end $$;

revoke all on function public.consume_usage(integer, integer) from public, anon;
grant execute on function public.consume_usage(integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Settings: merge a partial patch on the server, so two screens saving
-- different settings don't overwrite each other. Nested objects merge; a
-- null value removes the key. Returns the merged settings.
--   POST /rest/v1/rpc/merge_settings  {"patch": {"memory_enabled": false}}
-- ---------------------------------------------------------------------------
create or replace function public.jsonb_merge_deep(base jsonb, patch jsonb)
returns jsonb
language plpgsql immutable as $$
declare
  k text;
  v jsonb;
  result jsonb;
begin
  if patch is null then
    return base;
  end if;
  if base is null or jsonb_typeof(base) <> 'object' or jsonb_typeof(patch) <> 'object' then
    return patch;
  end if;
  result := base;
  for k, v in select key, value from jsonb_each(patch) loop
    if jsonb_typeof(v) = 'null' then
      result := result - k;
    elsif jsonb_typeof(v) = 'object' and jsonb_typeof(result -> k) = 'object' then
      result := jsonb_set(result, array[k], public.jsonb_merge_deep(result -> k, v));
    else
      result := jsonb_set(result, array[k], v);
    end if;
  end loop;
  return result;
end $$;

create or replace function public.merge_settings(patch jsonb)
returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  merged jsonb;
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '28000';
  end if;
  if patch is null or jsonb_typeof(patch) <> 'object' then
    raise exception 'patch must be a JSON object' using errcode = '22023';
  end if;
  insert into public.user_settings as s (user_id, settings)
    values (auth.uid(), public.jsonb_merge_deep('{}'::jsonb, patch))
    on conflict (user_id) do update
      set settings = public.jsonb_merge_deep(s.settings, merge_settings.patch)
    returning s.settings into merged;
  return merged;
end $$;

revoke all on function public.merge_settings(jsonb) from public, anon;
grant execute on function public.merge_settings(jsonb) to authenticated;
