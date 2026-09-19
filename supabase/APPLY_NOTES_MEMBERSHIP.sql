-- =============================================================================
-- Fix: leaving a notes space does not take your own notes away with it
-- =============================================================================
-- SYMPTOM
--   Caught by scripts/migrate/08-notes-rls-suite.ts on its first run:
--
--     PASS  guest leaves the space
--     FAIL  guest CANNOT read notes after leaving — LEAKED 1 row(s)
--     PASS  guest CANNOT see the space after leaving
--
--   The space disappears, the roster disappears, every note written by anyone
--   else disappears — and the one note they wrote themselves stays readable
--   forever. Same for deleting it.
--
-- CAUSE
--   notes_select_member (0025) led with `author_id = (select auth.uid())`, and
--   notes_delete_own still does. That branch was put there for INSERT ...
--   RETURNING: Postgres evaluates the SELECT policy against the new row, and a
--   policy that cannot see the candidate row denies the author sight of their
--   own insert. 0004, 0016, 0017 and 0024 were all written about that trap.
--
--   But author_id never changes, so as a SELECT rule it is a grant that
--   outlives membership — exactly the shape of bug 0024 fixed for
--   conversations, where created_by kept a departed member's chat in their
--   inbox.
--
-- FIX
--   Drop the branch. It was never needed here, which is the part worth being
--   precise about:
--
--     notes_insert_member already requires is_note_space_member(space_id), so
--     at RETURNING time the author IS an accepted member. That helper reads
--     note_space_members — a DIFFERENT table, whose rows were committed by an
--     earlier statement — so it is not subject to the STABLE-snapshot problem
--     at all. Membership alone answers the RETURNING case correctly.
--
--   The own-column-first rule exists for policies that would otherwise have to
--   re-query THEIR OWN table. This one never did.
--
--   DELETE gets the same treatment, with the author branch kept but now
--   conditioned on still being in the space. A departed author deleting notes
--   out of a list they walked away from is the same leak wearing a different
--   verb.
--
-- WHAT THIS DELIBERATELY DOES NOT TOUCH
--   pins_select_visible (0017) carries the identical `creator_id = auth.uid()
--   or is_space_member(space_id)` shape, so a departed map-space member can
--   still see pins they dropped. Same bug, different feature, and not what
--   this migration was opened for — flagged rather than fixed silently.
--
-- Idempotent — safe to run repeatedly.
-- =============================================================================

begin;

-- Membership decides, and nothing else. An accepted member sees every note in
-- the space including their own; everyone else sees none, authorship included.
drop policy if exists notes_select_member on public.notes;
create policy notes_select_member on public.notes
  for select to authenticated
  using (public.is_note_space_member(space_id));

-- Your own note, while you are still in the space — or anything at all, if you
-- own the space.
drop policy if exists notes_delete_own on public.notes;
create policy notes_delete_own on public.notes
  for delete to authenticated
  using (
    (author_id = (select auth.uid()) and public.is_note_space_member(space_id))
    or public.is_note_space_owner(space_id)
  );

commit;
