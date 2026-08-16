-- =============================================================================
-- SECURITY FIX: privilege escalation via self-added conversation membership
-- =============================================================================
-- Found by the live RLS suite once conversation creation started working. The
-- test had never been reachable before, so the hole was invisible.
--
-- THE HOLE
--   conversation_members_insert allowed `user_id = auth.uid()`, intended to
--   mean "join a conversation you were invited to". There is no invitation
--   concept in this app, so in practice it meant *anyone may add themselves to
--   any conversation*. Once inserted they are a member, is_conversation_member()
--   returns true, and they can read every message in that thread.
--
--   Reproduction: carol, a complete stranger to a DM between alice and bob,
--   inserted {conversation_id, user_id: carol} and the write succeeded.
--
-- THE FIX
--   Membership may only be granted by someone already inside the conversation,
--   or by its creator (which is what bootstraps a brand-new thread, since the
--   creator is not yet a member when they add the first rows).
--
--   `is_conversation_admin` is dropped from the list as redundant — an admin is
--   necessarily a member.
--
--   This preserves the Firestore behaviour that any participant could add
--   someone to a group. If you want add-to-group restricted to admins, replace
--   is_conversation_member with is_conversation_admin below; that is a product
--   decision, not a security one.
--
-- SECOND CLASS OF BUG (same shape, lower severity)
--   likes, comments and post_reactions all gated writes on `user_id =
--   auth.uid()` alone, with no check that the target post is visible to the
--   writer. A user could like, comment on, or react to a private or
--   followers-only post they cannot read, by supplying its id. No read access
--   is gained, but it lets a stranger attach content to a post they were never
--   allowed to see, and inflates its counters.
--
-- Idempotent — safe to run repeatedly.
-- =============================================================================

begin;

-- --- Critical: conversation membership ---------------------------------------

drop policy if exists conversation_members_insert on conversation_members;
create policy conversation_members_insert on conversation_members
  for insert to authenticated with check (
    is_conversation_member(conversation_id)
    or is_conversation_creator(conversation_id)
  );

-- --- Writes must target a post the author can actually see --------------------

drop policy if exists likes_insert_own on likes;
create policy likes_insert_own on likes
  for insert to authenticated with check (
    user_id = auth.uid()
    and exists (
      select 1 from posts p
      where p.id = post_id and can_view_post(p.user_id, p.visibility)
    )
  );

drop policy if exists comments_insert_own on comments;
create policy comments_insert_own on comments
  for insert to authenticated with check (
    user_id = auth.uid()
    and exists (
      select 1 from posts p
      where p.id = post_id and can_view_post(p.user_id, p.visibility)
    )
  );

drop policy if exists post_reactions_write_own on post_reactions;
create policy post_reactions_write_own on post_reactions
  for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from posts p
      where p.id = post_id and can_view_post(p.user_id, p.visibility)
    )
  );

commit;
