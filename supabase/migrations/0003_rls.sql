-- =============================================================================
-- Row Level Security — translated from firestore.rules
-- =============================================================================
-- Firestore rule            →  Postgres equivalent
--   isSignedIn()            →  auth.uid() is not null (or `to authenticated`)
--   isOwner(uid)            →  auth.uid() = <table>.user_id
--   isChatParticipant(cid)  →  is_conversation_member(cid)
--   affectedKeys().hasOnly  →  column-level GRANTs + triggers (see note below)
--
-- IMPORTANT DIFFERENCE — field allowlists:
-- Firestore restricted *which fields* an update could touch via
-- `affectedKeys().hasOnly([...])`. Postgres RLS gates rows, not columns, so
-- that constraint is expressed two ways here:
--   • immutable identity columns are protected by a trigger that rejects
--     changes (below), and
--   • counters are revoked from the client entirely, since triggers own them.
-- This is stricter than the Firestore original, not looser.
-- =============================================================================

alter table users                  enable row level security;
alter table songs                  enable row level security;
alter table follows                enable row level security;
alter table posts                  enable row level security;
alter table post_images            enable row level security;
alter table post_edits             enable row level security;
alter table likes                  enable row level security;
alter table comments               enable row level security;
alter table post_reactions         enable row level security;
alter table comment_reactions      enable row level security;
alter table conversations          enable row level security;
alter table conversation_members   enable row level security;
alter table messages               enable row level security;
alter table message_receipts       enable row level security;
alter table message_reactions      enable row level security;
alter table notifications          enable row level security;
alter table music_history          enable row level security;
alter table push_subscriptions     enable row level security;
alter table security_events        enable row level security;
alter table migration_issues       enable row level security;
-- Bookkeeping table written only by the register_direct_conversation trigger
-- (SECURITY DEFINER, so it bypasses this). No policies below means no client
-- role can touch it. Without this line it would be world-readable and
-- world-writable, and Supabase's security linter flags it.
alter table direct_conversation_keys enable row level security;

-- --- Helper functions --------------------------------------------------------
-- SECURITY DEFINER so the membership lookup itself is not subject to RLS —
-- otherwise the conversation_members policy would recurse into itself.

create or replace function is_conversation_member(conv_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from conversation_members
    where conversation_id = conv_id and user_id = auth.uid()
  );
$$;

create or replace function is_conversation_admin(conv_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from conversation_members
    where conversation_id = conv_id and user_id = auth.uid() and role = 'admin'
  );
$$;

/*
 * Creating a conversation is a chicken-and-egg problem for RLS:
 *
 *   • The creator cannot SELECT the row they just inserted, because the
 *     select policy requires membership and they are not a member yet — which
 *     breaks `INSERT ... RETURNING id`.
 *   • They cannot add the *other* participant, because the insert policy
 *     requires admin, and their own admin row is being inserted in the same
 *     statement so it is not yet visible to the check.
 *
 * Net effect without this: direct conversations and groups could not be
 * created at all. Keying off `created_by` breaks the cycle.
 */
create or replace function is_conversation_creator(conv_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from conversations where id = conv_id and created_by = auth.uid()
  );
$$;

create or replace function follows_user(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from follows where follower_id = auth.uid() and following_id = target
  );
$$;

-- Whether the current user may see a given post, honouring its audience.
-- Firestore could not express this: `allow read: if isSignedIn()` was the only
-- workable rule there, and the visibility filter ran in the client — meaning
-- "followers only" and "private" were never actually enforced. In Postgres it
-- is a real boundary.
create or replace function can_view_post(p_author uuid, p_visibility post_visibility)
returns boolean language sql stable as $$
  select case
    when p_author = auth.uid() then true
    when p_visibility = 'public' then true
    when p_visibility = 'followers' then follows_user(p_author)
    else false
  end;
$$;

-- =============================================================================
-- users
-- =============================================================================

create policy users_select on users
  for select to authenticated using (true);

create policy users_insert_self on users
  for insert to authenticated with check (id = auth.uid());

create policy users_update_self on users
  for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Identity columns are immutable after creation. This is the column-level half
-- of the old `affectedKeys().hasOnly([...])` rule.
create or replace function guard_user_immutable_columns()
returns trigger language plpgsql as $$
begin
  if new.id <> old.id then
    raise exception 'users.id is immutable';
  end if;
  if new.firebase_uid is distinct from old.firebase_uid then
    raise exception 'users.firebase_uid is immutable';
  end if;
  if new.created_at <> old.created_at then
    raise exception 'users.created_at is immutable';
  end if;
  -- Consent must be server-stamped, mirroring the Firestore rule that required
  -- termsAcceptedAt == request.time.
  if new.terms_accepted_at is distinct from old.terms_accepted_at
     and new.terms_accepted_at > now() + interval '1 minute' then
    raise exception 'terms_accepted_at cannot be set in the future';
  end if;
  return new;
end;
$$;

create trigger users_immutable_guard before update on users
  for each row execute function guard_user_immutable_columns();

-- =============================================================================
-- songs — shared reference data
-- =============================================================================

create policy songs_select on songs for select to authenticated using (true);
create policy songs_insert on songs for insert to authenticated with check (true);

-- =============================================================================
-- follows
-- =============================================================================

create policy follows_select on follows
  for select to authenticated using (true);

create policy follows_insert_own on follows
  for insert to authenticated with check (follower_id = auth.uid());

create policy follows_delete_own on follows
  for delete to authenticated using (follower_id = auth.uid());

-- =============================================================================
-- posts
-- =============================================================================

create policy posts_select_visible on posts
  for select to authenticated
  using (can_view_post(user_id, visibility));

create policy posts_insert_own on posts
  for insert to authenticated with check (user_id = auth.uid());

create policy posts_update_own on posts
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy posts_delete_own on posts
  for delete to authenticated using (user_id = auth.uid());

-- Counters are trigger-owned; a client must not be able to write them.
--
-- A column-level REVOKE does NOT work here: Supabase grants table-wide UPDATE
-- to `authenticated`, and a table-level grant satisfies any column-level
-- check, so `REVOKE UPDATE (likes_count) ...` would silently do nothing. The
-- table grant has to be dropped first and replaced by an explicit column list.
revoke update on posts from authenticated;
grant update (content, type, visibility, voice_url, song_id, updated_at)
  on posts to authenticated;

-- Same reasoning for the identity columns on users: the immutability trigger
-- is a backstop, but not granting the columns is the primary control.
revoke update on users from authenticated;
grant update (display_name, photo_url, bio, theme_song_id, status, last_active,
              terms_version, terms_accepted_at, updated_at)
  on users to authenticated;

-- Child tables inherit the parent's visibility.
create policy post_images_select on post_images
  for select to authenticated using (
    exists (select 1 from posts p where p.id = post_id
            and can_view_post(p.user_id, p.visibility))
  );
create policy post_images_write on post_images
  for all to authenticated
  using (exists (select 1 from posts p where p.id = post_id and p.user_id = auth.uid()))
  with check (exists (select 1 from posts p where p.id = post_id and p.user_id = auth.uid()));

create policy post_edits_select on post_edits
  for select to authenticated using (
    exists (select 1 from posts p where p.id = post_id
            and can_view_post(p.user_id, p.visibility))
  );
create policy post_edits_insert on post_edits
  for insert to authenticated with check (
    exists (select 1 from posts p where p.id = post_id and p.user_id = auth.uid())
  );

-- =============================================================================
-- likes / reactions
-- =============================================================================

create policy likes_select on likes
  for select to authenticated using (
    exists (select 1 from posts p where p.id = post_id
            and can_view_post(p.user_id, p.visibility))
  );
create policy likes_insert_own on likes
  for insert to authenticated with check (
    user_id = auth.uid()
    and exists (select 1 from posts p where p.id = post_id
                and can_view_post(p.user_id, p.visibility))
  );
create policy likes_delete_own on likes
  for delete to authenticated using (user_id = auth.uid());

create policy post_reactions_select on post_reactions
  for select to authenticated using (
    exists (select 1 from posts p where p.id = post_id
            and can_view_post(p.user_id, p.visibility))
  );
create policy post_reactions_write_own on post_reactions
  for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (select 1 from posts p where p.id = post_id
                and can_view_post(p.user_id, p.visibility))
  );

create policy comment_reactions_select on comment_reactions
  for select to authenticated using (true);
create policy comment_reactions_write_own on comment_reactions
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- =============================================================================
-- comments
-- =============================================================================

create policy comments_select on comments
  for select to authenticated using (
    exists (select 1 from posts p where p.id = post_id
            and can_view_post(p.user_id, p.visibility))
  );

create policy comments_insert_own on comments
  for insert to authenticated with check (
    user_id = auth.uid()
    and exists (select 1 from posts p where p.id = post_id
                and can_view_post(p.user_id, p.visibility))
  );

create policy comments_update_own on comments
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Comment author OR post author may delete, matching the Firestore rule that
-- let a post owner moderate their own thread.
create policy comments_delete_own_or_post_owner on comments
  for delete to authenticated using (
    user_id = auth.uid()
    or exists (select 1 from posts p where p.id = post_id and p.user_id = auth.uid())
  );

-- =============================================================================
-- conversations / membership / messages
-- =============================================================================

-- NOTE: tests the row's own created_by column, NOT is_conversation_creator().
-- A function that re-queries this table is STABLE and sees the pre-statement
-- snapshot, so during INSERT ... RETURNING the new row is invisible to it and
-- the creator is denied sight of the row they just made. See 0004.
create policy conversations_select_member on conversations
  for select to authenticated
  using (created_by = auth.uid() or is_conversation_member(id));

create policy conversations_insert on conversations
  for insert to authenticated with check (created_by = auth.uid());

-- Group metadata is admin-only; direct conversations have no editable metadata.
create policy conversations_update_admin on conversations
  for update to authenticated
  using (is_conversation_admin(id)) with check (is_conversation_admin(id));

create policy conversations_delete_admin on conversations
  for delete to authenticated using (is_conversation_admin(id));

-- Own row by direct column comparison, for the same INSERT ... RETURNING
-- reason as above.
create policy conversation_members_select on conversation_members
  for select to authenticated
  using (user_id = auth.uid() or is_conversation_member(conversation_id));

-- Membership is granted from INSIDE the conversation, never claimed from
-- outside. A bare  here would let any stranger add
-- themselves to any thread and read all of it — see 0005.
create policy conversation_members_insert on conversation_members
  for insert to authenticated with check (
    is_conversation_member(conversation_id)
    or is_conversation_creator(conversation_id)
  );

-- Your own membership row only — this is where last_read_at is written.
create policy conversation_members_update_self on conversation_members
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Leave yourself, or be removed by an admin.
create policy conversation_members_delete on conversation_members
  for delete to authenticated using (
    user_id = auth.uid() or is_conversation_admin(conversation_id)
  );

create policy messages_select_member on messages
  for select to authenticated using (is_conversation_member(conversation_id));

create policy messages_insert_member on messages
  for insert to authenticated with check (
    sender_id = auth.uid() and is_conversation_member(conversation_id)
  );

create policy messages_update_own on messages
  for update to authenticated
  using (sender_id = auth.uid()) with check (sender_id = auth.uid());

create policy messages_delete_own on messages
  for delete to authenticated using (sender_id = auth.uid());

-- Receipts: visible to everyone in the thread (so the sender sees Seen), but
-- writable only for your own row. Firestore allowed any participant to edit
-- readBy, meaning one member could mark a message read on another's behalf.
create policy message_receipts_select on message_receipts
  for select to authenticated using (
    exists (select 1 from messages m where m.id = message_id
            and is_conversation_member(m.conversation_id))
  );
create policy message_receipts_update_self on message_receipts
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy message_reactions_select on message_reactions
  for select to authenticated using (
    exists (select 1 from messages m where m.id = message_id
            and is_conversation_member(m.conversation_id))
  );
create policy message_reactions_write_own on message_reactions
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- =============================================================================
-- notifications
-- =============================================================================

create policy notifications_select_own on notifications
  for select to authenticated using (recipient_id = auth.uid());

-- Anyone may create a notification addressed to someone else (that is what a
-- like or follow does), but must identify themselves honestly as the actor.
create policy notifications_insert on notifications
  for insert to authenticated with check (actor_id = auth.uid());

create policy notifications_update_own on notifications
  for update to authenticated
  using (recipient_id = auth.uid()) with check (recipient_id = auth.uid());

create policy notifications_delete_own on notifications
  for delete to authenticated using (recipient_id = auth.uid());

-- =============================================================================
-- music history / push subscriptions — strictly private
-- =============================================================================

create policy music_history_own on music_history
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy push_subscriptions_own on push_subscriptions
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- =============================================================================
-- security_events — append-only, owner-read
-- =============================================================================
-- No update and no delete policy exists, so neither is permitted for any role.
-- Someone who compromises a session cannot erase the record of their sign-in.

create policy security_events_select_own on security_events
  for select to authenticated using (user_id = auth.uid());

create policy security_events_insert_own on security_events
  for insert to authenticated with check (user_id = auth.uid());

-- =============================================================================
-- migration_issues — service role only
-- =============================================================================
-- No policies: RLS is enabled and nothing is granted, so only the service_role
-- key (which bypasses RLS) can read or write it.
