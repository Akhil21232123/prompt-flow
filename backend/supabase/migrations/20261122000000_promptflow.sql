-- PromptFlow schema: per-user settings, dictionary, snippets and history.
-- Every table is protected by row-level security: a signed-in user can only
-- see and change their own rows.

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.dictionary_words (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  word text not null check (length(word) between 1 and 80),
  -- lower-cased copy so "Supabase" and "supabase" are one entry
  word_key text generated always as (lower(word)) stored,
  source text not null default 'manual' check (source in ('manual', 'learned', 'imported')),
  created_at timestamptz not null default now(),
  unique (user_id, word_key)
);

create table if not exists public.snippets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  trigger text not null check (length(trigger) between 1 and 120),
  expansion text not null check (length(expansion) <= 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.dictations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  device text,
  mode text not null check (mode in ('dictate', 'engineer', 'command')),
  app jsonb,
  category text,
  raw_text text not null,
  final_text text not null,
  edited_text text,
  label text,
  duration_ms integer,
  stt_provider text,
  latency_ms integer,
  guarded jsonb
);

create index if not exists dictations_user_created on public.dictations (user_id, created_at desc);
create index if not exists dictionary_user on public.dictionary_words (user_id, created_at desc);
create index if not exists snippets_user on public.snippets (user_id);

alter table public.user_settings enable row level security;
alter table public.dictionary_words enable row level security;
alter table public.snippets enable row level security;
alter table public.dictations enable row level security;

-- Newer projects don't expose new tables to the API by default; signed-in
-- users get access here, and the policies below limit them to their rows.
grant usage on schema public to authenticated;
grant select, insert, update, delete on
  public.user_settings, public.dictionary_words, public.snippets, public.dictations
  to authenticated;

do $$
declare t text;
begin
  foreach t in array array['user_settings', 'dictionary_words', 'snippets', 'dictations'] loop
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format(
      'create policy "own rows" on public.%I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())',
      t
    );
  end loop;
end $$;

-- New accounts start with default settings and a few words every user needs.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.user_settings (user_id) values (new.id) on conflict do nothing;
  insert into public.dictionary_words (user_id, word, source)
  values (new.id, 'PromptFlow', 'imported'), (new.id, 'Wispr Flow', 'imported')
  on conflict do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep updated_at honest.
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists user_settings_touch on public.user_settings;
create trigger user_settings_touch before update on public.user_settings
  for each row execute function public.touch_updated_at();
drop trigger if exists snippets_touch on public.snippets;
create trigger snippets_touch before update on public.snippets
  for each row execute function public.touch_updated_at();
