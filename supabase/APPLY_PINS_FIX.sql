-- =============================================================================
-- Fix: INSERT ... RETURNING on `pins` blocked by its own SELECT policy
-- =============================================================================
-- The same trap 0004 fixed for `conversations`, walked into again on `pins`.
--
-- SYMPTOM
--   insert into pins (...) returning id
--     → ERROR 42501: new row violates row-level security policy for table "pins"
--
--   Narrowed down by scripts/migrate/diagnose-pins-rls.ts: SELECT on an
--   existing pin worked, pin_media and pin_shares inserts worked, and
--   can_view_pin() returned true when called directly. Only the pins INSERT
--   failed, which rules out grants, the WITH CHECK, and the helper itself.
--
-- CAUSE
--   Postgres evaluates the SELECT policy against the new row when a statement
--   uses RETURNING — and PostgREST always uses RETURNING when the client calls
--   .select() after .insert(), which src/lib/pins.ts does.
--
--   pins_select_visible called can_view_pin(id), which runs
--   `select ... from pins where id = $1`. That function is STABLE, so it sees
--   the snapshot as of statement start; the row being inserted is not in it.
--   The lookup returns false and the pin is judged invisible to the very
--   person who just created it.
--
-- FIX
--   Test the row's own column instead of re-querying the table. creator_id is
--   present on the candidate row, so no snapshot is involved. The share branch
--   still goes through can_view_pin(), which reads pin_shares — a different
--   table, already committed, and therefore safe to look up.
--
--   The OR does not depend on short-circuiting: if can_view_pin(id) is
--   evaluated anyway it simply returns false, and the OR is already true.
--
-- can_view_pin() is unchanged. It is still correct and still needed for the
-- pin_media and pin_shares policies, where the pins row was committed by an
-- earlier statement and is genuinely visible.
--
-- Idempotent — safe to run repeatedly.
-- =============================================================================

begin;

drop policy if exists pins_select_visible on public.pins;
create policy pins_select_visible on public.pins
  for select to authenticated
  using (
    -- Own column: available on the new row during INSERT ... RETURNING.
    creator_id = (select auth.uid())
    -- Different table, already committed: safe to look up.
    or public.can_view_pin(id)
  );

commit;
