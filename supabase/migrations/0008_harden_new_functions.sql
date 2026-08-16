-- =============================================================================
-- Harden the functions added in 0006 and 0007
-- =============================================================================
-- Found by Supabase's database linter immediately after applying those two.
-- Both items here are defects in code from this migration pair, not
-- pre-existing ones — those are listed at the bottom for a separate decision.
--
-- 1. `stamp_consent_time()` had no fixed search_path (lint 0011).
--    A function that resolves `now()` and its own operators through a mutable
--    search_path can be hijacked by anyone able to create objects in a schema
--    that sorts earlier for the calling role. This function guards a compliance
--    timestamp, so it is exactly the wrong place to leave that open. It is
--    SECURITY INVOKER, which limits the blast radius, but pinning the path
--    costs nothing.
--
-- 2. `mfa_satisfied()` was reachable by `anon` over `/rest/v1/rpc/` (lint 0028).
--    It is SECURITY DEFINER and reads auth.mfa_factors. It only ever answers
--    for `auth.uid()`, so an anonymous caller learns nothing — auth.uid() is
--    null for them and the answer is a constant `true`. Still: it exists to be
--    called by RLS policies that are all `to authenticated`, so `anon` has no
--    reason to reach it at all.
--
--    EXECUTE is deliberately KEPT for `authenticated`. RLS policy expressions
--    are evaluated with the privileges of the querying role, so revoking it
--    there would make every policy fail with "permission denied for function
--    mfa_satisfied" — which is to say, it would break the entire application.
--
-- 3. `stamp_consent_time()` was also reachable over RPC. It is a trigger
--    function; nothing should ever call it directly.
--
-- ── A FUNCTION HAS THREE EXECUTE GRANTS, NOT ONE ─────────────────────────────
-- This took two corrections on a live database to get right. Recording the
-- whole sequence, because the failure mode is that the revoke reports success
-- and changes nothing.
--
--   Attempt 1: `revoke execute ... from anon`
--     No effect. has_function_privilege('anon', …) still true. PostgreSQL
--     creates every function with a default EXECUTE grant to PUBLIC, and
--     PUBLIC covers all roles, so revoking one role leaves it standing.
--
--   Attempt 2: `revoke execute ... from public`
--     Fixed mfa_satisfied() but NOT stamp_consent_time(). Supabase ships
--     `alter default privileges in schema public grant execute on functions
--     to anon, authenticated, service_role`, so a new function also carries
--     explicit per-role grants. mfa_satisfied() only appeared fixed because
--     attempt 1 had already removed its explicit anon grant.
--
--   Attempt 3: `revoke execute ... from public, anon, authenticated`
--     Correct. Name the blanket grant and every explicit one, then grant back
--     precisely to the roles that need it.
--
-- This is the same shape as the trap 0003 documents for column-level grants on
-- `posts` and `users`: a narrow revoke is silently satisfied by a broader grant
-- sitting behind it. Different catalog, identical lesson — always verify a
-- revoke with has_*_privilege rather than trusting that it returned success.
--
-- Verified live: anon and authenticated both false on stamp_consent_time(),
-- anon false / authenticated true on mfa_satisfied(), and 07-rls-suite.ts
-- still passes 55/55. That last result also settles empirically that a trigger
-- fires without the invoking role holding EXECUTE on its function — the suite
-- updates a user profile, which fires this trigger.
--
-- Idempotent — safe to run repeatedly.
-- =============================================================================

begin;

create or replace function stamp_consent_time()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.terms_version is distinct from old.terms_version then
    new.terms_accepted_at := now();
  else
    new.terms_accepted_at := old.terms_accepted_at;
  end if;
  return new;
end;
$$;

-- Policies need this one; the client API surface does not. `authenticated` is
-- revoked and then re-granted rather than just left alone, so the end state is
-- explicit instead of inherited.
revoke execute on function mfa_satisfied() from public, anon, authenticated;
grant  execute on function mfa_satisfied() to authenticated;

-- Trigger function: nothing calls this directly, including the trigger itself,
-- so no role needs EXECUTE.
revoke execute on function stamp_consent_time() from public, anon, authenticated;

commit;

-- =============================================================================
-- NOT fixed here — pre-existing, needs a decision
-- =============================================================================
-- The linter also flags the following, all of which predate 0006/0007. They are
-- left alone rather than swept into this migration, because two of them carry
-- real risk of breaking writes if changed carelessly.
--
--   Mutable search_path (lint 0011):
--     set_updated_at, direct_conversation_key, recompute_counters,
--     can_view_post, guard_user_immutable_columns
--   Trigger functions exposed over RPC (lints 0028/0029):
--     bump_post_likes_count, bump_post_comments_count,
--     fan_out_message_receipts, register_direct_conversation,
--     touch_conversation
--   Predicate functions exposed over RPC (lints 0028/0029):
--     follows_user, is_conversation_member, is_conversation_creator,
--     is_conversation_admin
--   pg_trgm installed in `public` (lint 0014)
--
-- Notes for whoever picks this up:
--
--  • The five trigger functions should not be callable over RPC by anyone.
--    Revoking EXECUTE from anon and authenticated is believed safe, because
--    PostgreSQL checks EXECUTE on a trigger function at CREATE TRIGGER time,
--    not on each fire. "Believed safe" is not "verified safe": if that is
--    wrong, every insert into posts, likes, comments and messages starts
--    failing. Do it in its own migration and run 07-rls-suite.ts immediately
--    after, which exercises all four of those write paths.
--
--  • The four predicate functions are used inside RLS policies, so
--    `authenticated` must retain EXECUTE for the same reason as
--    mfa_satisfied() above. Only `anon` can be revoked.
--
--  • Moving pg_trgm out of `public` requires dropping and recreating the two
--    GIN indexes on users.username / users.display_name that depend on it.
--    Search degrades to a sequential scan in between.
-- =============================================================================
