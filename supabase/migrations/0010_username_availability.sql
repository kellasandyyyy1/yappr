-- =============================================================================
-- Let the signup form check whether a username is free
-- =============================================================================
-- THE PROBLEM
--   Signup writes the `public.users` row from a trigger inside the same
--   transaction as the auth account, so a duplicate username rolls the entire
--   signup back. GoTrue reports that as HTTP 500 "Database error saving new
--   user" — no error code, no column, nothing pointing at the username. The UI
--   could only fall back to "Something went wrong. Please try again."
--
--   The obvious client-side fix — count matching rows before submitting —
--   does not work. At that moment the caller is still `anon`, and
--   `users_select` is `to authenticated`, so RLS hides every row and the count
--   is always zero. The check silently passes and the signup fails anyway.
--   (Verified: an existing username reported as available.)
--
-- THE FIX
--   A SECURITY DEFINER function that answers one boolean question and is
--   callable by `anon`. It runs as the owner, so RLS does not hide the row.
--
-- WHAT THIS DOES AND DOES NOT EXPOSE
--   It returns a boolean and nothing else — no id, no email, no profile data.
--   It does confirm whether a given handle is taken, which is inherently public
--   in this app: usernames appear on every profile, in search results and in
--   @mentions. There is nothing here that visiting /u/<name> would not reveal.
--
--   Contrast with email: `email_not_confirmed` vs `invalid_credentials` is
--   carefully managed precisely because email existence is NOT public. No
--   equivalent function exists for email, and none should.
--
-- Idempotent — safe to run repeatedly.
-- =============================================================================

begin;

create or replace function username_available(candidate text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    -- Same rule as users_username_check. Rejecting the format here too means
    -- the caller gets one answer for "unusable", whatever the reason.
    candidate ~ '^[a-z0-9_]{3,30}$'
    and not exists (select 1 from public.users u where u.username = candidate);
$$;

comment on function username_available(text) is
  'True when the handle is well-formed and unclaimed. Callable pre-signup, so anon needs EXECUTE.';

-- Name PUBLIC and both roles explicitly. Supabase layers per-role grants on top
-- of PostgreSQL's default PUBLIC grant, so a narrower statement is silently
-- satisfied by whichever grant it missed — the trap documented in 0008.
revoke execute on function username_available(text) from public, anon, authenticated;
grant  execute on function username_available(text) to anon, authenticated;

commit;
