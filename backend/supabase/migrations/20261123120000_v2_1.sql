-- PromptFlow v2.1 (100-user beta): 👍/👎 feedback and two founder views.
-- Safe to run more than once. Run after 20261123000000_v2.sql.

-- ---------------------------------------------------------------------------
-- Feedback on a result. dictation_id is the `id` /dictate and /rewrite
-- return; it isn't a foreign key because the dictation row is written just
-- after the response and history can be switched off.
-- ---------------------------------------------------------------------------
create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  dictation_id uuid,
  rating text not null check (rating in ('up', 'down')),
  note text check (note is null or length(note) <= 1000),
  app jsonb,
  mode text,
  label text,
  created_at timestamptz not null default now()
);

create index if not exists feedback_user_created on public.feedback (user_id, created_at desc);
create index if not exists feedback_created on public.feedback (created_at desc);
create index if not exists feedback_dictation on public.feedback (dictation_id);

alter table public.feedback enable row level security;
grant select, insert, delete on public.feedback to authenticated;
grant all on public.feedback to service_role;
drop policy if exists "own rows" on public.feedback;
create policy "own rows" on public.feedback for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- The founder's views read every user's rows, so they run as their owner
-- (security_invoker off) and only the service role (the SQL editor, admin
-- jobs) may read them.
create index if not exists dictations_created on public.dictations (created_at desc);

-- One row per UTC day: active users, dictations by mode, how often Prompt
-- Engineer fell back to the user's own words, latency, and 👍/👎.
create or replace view public.beta_stats_daily with (security_invoker = false) as
with d as (
  select
    (created_at at time zone 'utc')::date as day,
    user_id,
    mode,
    latency_ms,
    coalesce(label, '') like 'Kept your words%'
      or coalesce(label, '') like 'Prompt Engineer blocked%' as fell_back
  from public.dictations
),
days as (
  select
    day,
    count(distinct user_id) as active_users,
    count(*) as dictations,
    count(*) filter (where mode = 'dictate' and not fell_back) as dictate,
    count(*) filter (where mode = 'engineer') as engineer,
    count(*) filter (where mode = 'command') as command,
    count(*) filter (where fell_back) as engineer_fallbacks,
    round(
      100.0 * count(*) filter (where fell_back)
        / nullif(count(*) filter (where mode = 'engineer' or fell_back), 0),
      1
    ) as engineer_fallback_pct,
    round(avg(latency_ms)) as avg_latency_ms,
    round((percentile_cont(0.9) within group (order by latency_ms))::numeric) as p90_latency_ms
  from d
  group by day
),
f as (
  select
    (created_at at time zone 'utc')::date as day,
    count(*) filter (where rating = 'up') as thumbs_up,
    count(*) filter (where rating = 'down') as thumbs_down
  from public.feedback
  group by 1
)
select
  coalesce(days.day, f.day) as day,
  coalesce(days.active_users, 0) as active_users,
  coalesce(days.dictations, 0) as dictations,
  coalesce(days.dictate, 0) as dictate,
  coalesce(days.engineer, 0) as engineer,
  coalesce(days.command, 0) as command,
  coalesce(days.engineer_fallbacks, 0) as engineer_fallbacks,
  days.engineer_fallback_pct,
  days.avg_latency_ms,
  days.p90_latency_ms,
  coalesce(f.thumbs_up, 0) as thumbs_up,
  coalesce(f.thumbs_down, 0) as thumbs_down
from days
full join f on f.day = days.day
order by 1 desc;

-- The latest 200 feedback rows with what was said and what was pasted.
create or replace view public.beta_feedback_recent with (security_invoker = false) as
select
  f.created_at,
  f.rating,
  f.note,
  u.email,
  f.mode,
  coalesce(f.label, d.label) as label,
  f.app ->> 'name' as app,
  d.raw_text,
  d.final_text,
  d.latency_ms,
  f.dictation_id,
  f.user_id
from public.feedback f
left join public.dictations d on d.id = f.dictation_id
left join auth.users u on u.id = f.user_id
order by f.created_at desc
limit 200;

revoke all on public.beta_stats_daily, public.beta_feedback_recent from public, anon, authenticated;
grant select on public.beta_stats_daily, public.beta_feedback_recent to service_role;

notify pgrst, 'reload schema';
