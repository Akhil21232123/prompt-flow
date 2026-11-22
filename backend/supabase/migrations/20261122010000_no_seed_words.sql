-- New accounts no longer get starter dictionary words: Whisper uses the
-- dictionary as a spelling hint, and on silence it would echo them back
-- ("Wispr Flow"). Remove the ones already seeded.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.user_settings (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;

delete from public.dictionary_words
where source = 'imported' and word in ('PromptFlow', 'Wispr Flow');
