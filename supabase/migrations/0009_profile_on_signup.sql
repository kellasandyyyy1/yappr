-- =============================================================================
-- Create the profile row when the account is created, not afterwards
-- =============================================================================
-- THE BUG
--   AuthView signed the user up and then inserted their `public.users` row from
--   the browser as a second, separate call. That only works if signup returns a
--   session — and with email confirmation enabled (`mailer_autoconfirm = false`,
--   which is this project's setting) it does not. GoTrue returns a user with no
--   session, so the follow-up insert ran unauthenticated, `users_insert_own`
--   rejected it with 42501, and the account was left half-created: an
--   `auth.users` row with no profile.
--
--   That state is not self-healing. On the next sign-in App.tsx looks for the
--   profile, does not find one, and bounces the user back to the auth screen —
--   permanently. The account exists, cannot be used, and cannot be re-created
--   because the email is now taken.
--
--   Even with confirmation off it was only ever two writes with no transaction
--   around them: any failure between them produced the same orphan.
--
-- THE FIX
--   A trigger on `auth.users`. The profile is created in the same transaction
--   as the account, so the two cannot diverge. Signup passes username,
--   display name and consent version through `options.data`, which GoTrue
--   stores in `raw_user_meta_data`, and the trigger reads them from there.
--
-- WHY THE `? 'username'` GUARD
--   It fires only for accounts created through the app's signup form. Users
--   created by the admin API — the RLS suite, the migration importer — carry no
--   such metadata and are skipped, so those scripts keep inserting their own
--   profile rows exactly as before. Without this guard the trigger would insert
--   first and every one of those scripts would then fail on a duplicate id.
--
-- CONSENT TIMESTAMP
--   `terms_accepted_at` is set directly here. That is the INSERT path, which
--   0007's trigger deliberately does not touch — an insert is the account's
--   first consent and `now()` inside this trigger is still a server clock.
--
-- Idempotent — safe to run repeatedly.
-- =============================================================================

begin;

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  meta_username     text := new.raw_user_meta_data ->> 'username';
  meta_display_name text := new.raw_user_meta_data ->> 'display_name';
  meta_terms        text := new.raw_user_meta_data ->> 'terms_version';
begin
  -- Only accounts created through the signup form carry this metadata.
  if meta_username is null then
    return new;
  end if;

  insert into public.users (id, username, display_name, email,
                            terms_version, terms_accepted_at)
  values (
    new.id,
    meta_username,
    coalesce(nullif(meta_display_name, ''), meta_username),
    new.email,
    nullif(meta_terms, ''),
    case when nullif(meta_terms, '') is not null then now() end
  );

  return new;
end;
$$;

comment on function handle_new_user() is
  'Creates the public.users profile in the same transaction as the auth account. '
  'Skips admin-created users (no username in raw_user_meta_data).';

-- Nothing calls this directly; the trigger does not need EXECUTE to fire.
-- Naming PUBLIC *and* the per-role grants, because Supabase's default
-- privileges add explicit ones on top of PostgreSQL's blanket grant and a
-- narrower revoke is silently satisfied by whichever one it missed. See 0008.
revoke execute on function handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function handle_new_user();

commit;
