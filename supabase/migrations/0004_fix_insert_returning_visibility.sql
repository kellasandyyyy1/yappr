-- =============================================================================
-- Fix: INSERT ... RETURNING blocked by self-referential SELECT policies
-- =============================================================================
-- Found by the live RLS suite (scripts/migrate/07-rls-suite.ts). The local
-- PGlite check could not catch it: there is no auth.uid() there, so policies
-- were parsed but never executed.
--
-- SYMPTOM
--   insert into conversations (...) returning id
--     → ERROR 42501: new row violates row-level security policy
--   The same insert WITHOUT `returning` succeeded, which is what pinned it
--   down: the WITH CHECK was always fine, the SELECT policy was not.
--
-- CAUSE
--   Postgres evaluates the SELECT policy against the new row when a statement
--   uses RETURNING. Our policy called is_conversation_creator(id), which runs
--   `select ... from conversations where id = $1`. That function is STABLE, so
--   it sees the snapshot as of statement start — the row being inserted is not
--   in it. The lookup returns false and the row is judged invisible to the
--   very user who just created it.
--
--   The same latent trap existed on conversation_members: its SELECT policy
--   queried conversation_members. Nothing in the app hits it today (no insert
--   there uses RETURNING) but it would fail identically the moment one did.
--
-- FIX
--   Test the row's own columns instead of re-querying the table. `created_by`
--   and `user_id` are present on the candidate row, so no snapshot is involved.
--
-- is_conversation_creator() is kept: it is still correct and still needed for
-- conversation_members_insert, where the conversations row was committed by an
-- earlier statement and is genuinely visible.
--
-- Idempotent — safe to run against a fresh database or an already-migrated one.
-- =============================================================================

begin;

drop policy if exists conversations_select_member on conversations;
create policy conversations_select_member on conversations
  for select to authenticated
  using (
    -- Own column: available on the new row during INSERT ... RETURNING.
    created_by = auth.uid()
    -- Different table, already committed: safe to look up.
    or is_conversation_member(id)
  );

drop policy if exists conversation_members_select on conversation_members;
create policy conversation_members_select on conversation_members
  for select to authenticated
  using (
    user_id = auth.uid()
    or is_conversation_member(conversation_id)
  );

commit;
