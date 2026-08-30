-- =============================================================================
-- Fix: a pin stayed visible to its author after they left the space
-- =============================================================================
-- Caught by test-map-spaces.ts:
--
--   PASS  bob can leave voluntarily
--   FAIL  once out, bob sees nothing in it — 1 pin(s) still visible
--
-- The pin he could still see was his own. 0017's SELECT policies read
--
--   creator_id = auth.uid() or is_space_member(space_id)
--
-- so authorship granted permanent read access, surviving departure from the
-- space. The pin itself correctly stays behind — leaving is not a retraction —
-- which means a former member kept a window into a space's content.
--
-- That contradicts the model this feature is built on, and the requirement as
-- written: a user can read pins in a space only if they are listed in
-- map_space_members for that space_id. Membership is the whole visibility
-- model, or it is not the model.
--
-- ── WHY THE CREATOR CLAUSE WAS THERE, AND WHY IT IS NOT NEEDED ──────────────
-- It was defensive, carried over from the INSERT ... RETURNING trap that bit
-- pins twice (0016) and shaped 0017's other policies. It does not apply here.
--
-- That trap only bites when a policy re-queries THE TABLE BEING INSERTED INTO
-- through a STABLE function, which cannot see the new row. pins_select_visible
-- calls is_space_member(space_id), which reads map_space_members — a different
-- table, already committed. space_id is present on the candidate row. So the
-- author's own INSERT ... RETURNING still passes on membership alone, and the
-- clause bought nothing but the leak.
--
-- Same reasoning for pin_media: its policy reads `pins`, committed by an
-- earlier statement.
--
-- ── WHAT IS DELIBERATELY LEFT ALONE ─────────────────────────────────────────
-- pins_delete_own still allows `creator_id = auth.uid()`. Being able to remove
-- something you wrote is a different question from being able to read a space
-- you have left, and removing your own content is defensible. It also requires
-- knowing the pin's id, which a former member can no longer obtain by reading.
--
-- Idempotent — safe to run repeatedly.
-- =============================================================================

begin;

drop policy if exists pins_select_visible on public.pins;
create policy pins_select_visible on public.pins
  for select to authenticated
  using (public.is_space_member(space_id));

drop policy if exists pin_media_select_visible on public.pin_media;
create policy pin_media_select_visible on public.pin_media
  for select to authenticated
  using (
    exists (
      select 1 from public.pins p
       where p.id = pin_id
         and public.is_space_member(p.space_id)
    )
  );

commit;
