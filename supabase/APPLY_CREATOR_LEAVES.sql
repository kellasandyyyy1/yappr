-- =============================================================================
-- Fix: a group you created stays in your inbox after you leave it
-- =============================================================================
-- SYMPTOM
--   Leaving a group succeeds — no error, the membership row is really gone —
--   but the conversation is still listed in the inbox. Only for the person who
--   created it; everyone else's leave has always disappeared correctly.
--
--   The leftover row renders empty: no members, no last-message preview. That
--   is the tell. conversation_members_select and messages_select_member both
--   require real membership, so they correctly return nothing, while the
--   conversation row itself remains visible.
--
-- CAUSE
--   chats.list() carries no membership filter — it selects from conversations
--   and lets RLS decide what is visible. conversations_select_member (0004)
--   allowed `created_by = auth.uid() or is_conversation_member(id)`.
--
--   That first branch is there for a real reason: creating a conversation is a
--   chicken-and-egg problem. `INSERT ... RETURNING id` evaluates the SELECT
--   policy against the new row, and at that instant the creator has no
--   membership row yet, so is_conversation_member() is false. Without the
--   created_by branch, group creation fails outright.
--
--   But it was written as an unconditional, permanent grant. created_by never
--   changes, so it kept returning true long after the creator stopped being a
--   member. Leaving removed the membership and every consequence of it, and
--   the conversation stayed visible anyway on the strength of who once made it.
--
-- FIX
--   Keep the branch, but scope it to the only moment it is needed: a
--   conversation that has no members at all. During INSERT ... RETURNING no
--   membership rows are committed for the new id, so the branch holds and
--   creation works exactly as before. The moment the creator's own membership
--   row lands, the branch stops applying and ordinary membership governs — so
--   leaving hides the conversation like it does for anyone else.
--
--   The subquery reads conversation_members, a different table whose rows are
--   already committed, so this does not repeat the STABLE-snapshot mistake
--   0004 was written to fix. It deliberately does not reuse
--   is_conversation_creator(), which re-queries `conversations` and would hit
--   exactly that trap.
--
--   This narrows visibility and widens it for nobody: every reader must now be
--   a member, except on a members-less row that only its own creator can see.
--
-- KNOWN EDGE
--   If every member leaves, the conversation becomes members-less and its
--   creator can see it again. The app does not produce that state — the last
--   member out deletes the conversation instead of leaving (handleLeaveGroup,
--   remaining.length === 0) — and an orphaned row with no members is one we
--   would want its creator to be able to find and delete anyway.
--
-- Idempotent — safe to run repeatedly.
-- =============================================================================

begin;

drop policy if exists conversations_select_member on public.conversations;
create policy conversations_select_member on public.conversations
  for select to authenticated
  using (
    -- The brand-new row, mid INSERT ... RETURNING: nobody is a member yet.
    (
      created_by = (select auth.uid())
      and not exists (
        select 1 from public.conversation_members m
        where m.conversation_id = conversations.id
      )
    )
    -- Every conversation that has actually started: membership decides.
    or public.is_conversation_member(conversations.id)
  );

commit;
