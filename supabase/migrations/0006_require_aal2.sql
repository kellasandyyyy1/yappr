-- =============================================================================
-- Make two-factor authentication actually enforced
-- =============================================================================
-- WHY THIS EXISTS
--   Firebase and Supabase disagree about what a second factor *is*, and the
--   difference is a security regression if it is not closed deliberately.
--
--   Firebase: signInWithEmailAndPassword() REJECTED with
--   `auth/multi-factor-auth-required` when a factor was enrolled. No session
--   existed until the TOTP code was accepted. Skipping the prompt got you
--   nothing.
--
--   Supabase: the password step SUCCEEDS and issues a real session at
--   assurance level `aal1`. Entering the code upgrades it to `aal2`. Nothing in
--   the default policy set distinguishes the two, so an attacker holding only
--   the password could close the 2FA prompt and keep using the aal1 session.
--   Two-factor would be decoration.
--
--   This migration makes every policy on every public table reject an aal1
--   token *when the account has a verified factor*. Accounts without 2FA are
--   completely unaffected — for them aal1 is the highest level there is, and
--   demanding aal2 would lock out the entire user base.
--
-- WHAT AN aal1 SESSION CAN STILL DO AFTER THIS
--   Nothing in `public`. It can call the GoTrue MFA endpoints to answer the
--   challenge, and that is the point: the session is a challenge ticket, not an
--   authenticated session.
--
-- HOW THE REWRITE WORKS
--   Rather than restating 51 policies by hand — where one typo silently widens
--   access — the DO block reads each policy's current expression back out of
--   pg_policies and re-issues it wrapped in `mfa_satisfied() and (...)`. The
--   original condition is preserved verbatim, so this cannot loosen anything;
--   the only possible effect is to make a policy stricter.
--
-- Idempotent: policies already carrying the guard are skipped, so re-running
-- cannot double-wrap.
-- =============================================================================

begin;

-- --- The predicate ------------------------------------------------------------
-- SECURITY DEFINER because `authenticated` has no read access to
-- auth.mfa_factors, and should not be granted any — the function answers one
-- yes/no question about the caller's own account and exposes nothing else.
--
-- STABLE, so it is evaluated once per statement rather than once per row.

create or replace function mfa_satisfied()
returns boolean
language sql
stable
security definer
set search_path = public, auth, pg_temp
as $$
  select
    -- Already stepped up.
    coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
    -- …or this account has nothing to step up to. An enrolment that was
    -- started and never confirmed (status <> 'verified') protects nothing and
    -- must not lock anyone out.
    or not exists (
      select 1 from auth.mfa_factors f
      where f.user_id = auth.uid()
        and f.status = 'verified'
    );
$$;

comment on function mfa_satisfied() is
  'True unless the caller has a verified MFA factor and is still on an aal1 session.';

-- --- Apply it to every policy --------------------------------------------------

do $$
declare
  policy_row record;
  clauses    text;
begin
  for policy_row in
    select tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and 'authenticated' = any(roles)
      -- Skip anything already wrapped, so re-running is a no-op.
      and coalesce(qual, '')       not like '%mfa_satisfied()%'
      and coalesce(with_check, '') not like '%mfa_satisfied()%'
    order by tablename, policyname
  loop
    clauses := '';

    -- Only restate the clauses the policy actually has. A FOR INSERT policy
    -- has no USING; adding one is an error. A FOR UPDATE policy with no
    -- WITH CHECK reuses its USING expression for the new row — adding a
    -- WITH CHECK there would change its meaning, so it is left alone and the
    -- guard reaches the new row through USING anyway.
    if policy_row.qual is not null then
      clauses := clauses || format(' using (mfa_satisfied() and (%s))', policy_row.qual);
    end if;

    if policy_row.with_check is not null then
      clauses := clauses || format(' with check (mfa_satisfied() and (%s))', policy_row.with_check);
    end if;

    if clauses <> '' then
      execute format('alter policy %I on public.%I', policy_row.policyname, policy_row.tablename)
              || clauses;
    end if;
  end loop;
end
$$;

-- --- Verification handle -------------------------------------------------------
-- So "did 0006 actually apply to everything?" is answerable from outside the
-- SQL Editor. Reachable only by service_role; there is no reason for a signed-in
-- user to enumerate policy coverage.

create or replace function mfa_guard_coverage()
returns table (tablename text, policyname text)
language sql
stable
security definer
set search_path = public, pg_catalog, pg_temp
as $$
  select p.tablename::text, p.policyname::text
  from pg_policies p
  where p.schemaname = 'public'
    and 'authenticated' = any(p.roles)
    and coalesce(p.qual, '')       not like '%mfa_satisfied()%'
    and coalesce(p.with_check, '') not like '%mfa_satisfied()%';
$$;

comment on function mfa_guard_coverage() is
  'Lists authenticated policies still missing the aal guard. Empty means full coverage.';

revoke execute on function mfa_guard_coverage() from public, anon, authenticated;

commit;
