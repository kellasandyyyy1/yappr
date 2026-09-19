-- =============================================================================
-- Fix: members cannot post system messages ("X left the group")
-- =============================================================================
-- SYMPTOM
--   Leaving a group fails with "Could not leave the group", and the user stays
--   in it. The same failure is behind "Added X to the group", "X changed group
--   photo" and the notice posted when a group is created — all of them are
--   system messages, and none of them have ever been written successfully.
--
--   The console shows the insert into `messages`, not the membership delete:
--     ERROR 42501: new row violates row-level security policy for table "messages"
--
-- CAUSE
--   `messages.sender_id` is nullable precisely so a message can be unowned —
--   the column comment says "null = system", and the `type` enum carries a
--   'system' member. chatsApi.sendSystem() writes exactly that row.
--
--   But messages_insert_member (0003) required `sender_id = auth.uid()`
--   unconditionally. NULL = auth.uid() is NULL, not true, so the WITH CHECK
--   never passes and no client can insert a system message at all. The policy
--   and the schema disagreed about whether unowned messages exist.
--
--   In handleLeaveGroup the announce happens before the membership delete —
--   deliberately, because RLS stops a non-member inserting — so the rejected
--   insert throws and the delete is never reached. Leaving was blocked by the
--   notice about leaving.
--
-- FIX
--   Keep membership as the hard requirement, and allow the sender to be either
--   yourself or nobody-with-type-system. Expressed as two explicit branches so
--   the unowned case cannot be reached by an ordinary message that merely
--   omits its sender: a NULL sender_id is only accepted for type = 'system'.
--
--   This does not widen who may write. is_conversation_member() still gates
--   every insert, so a stranger cannot post a forged "X left the group" into a
--   thread they are not in. What a member gains is the ability to write an
--   unattributed notice into their own conversation, which is what the UI has
--   been trying to do since 0003.
--
-- Idempotent — safe to run repeatedly.
-- =============================================================================

begin;

drop policy if exists messages_insert_member on public.messages;
create policy messages_insert_member on public.messages
  for insert to authenticated with check (
    public.is_conversation_member(conversation_id)
    and (
      -- An ordinary message: owned by whoever is sending it.
      sender_id = (select auth.uid())
      -- A system notice: unowned, and only ever unowned as a system notice.
      or (sender_id is null and type = 'system')
    )
  );

comment on column public.messages.sender_id is
  'Author, or null for a system notice (type = ''system''). Members may insert '
  'either; see 0023.';

commit;
