-- ============================================================================
-- Yappr — complete schema, generated for one-shot execution.
--
-- GENERATED FILE. Do not edit. Source of truth is supabase/migrations/*.sql;
-- regenerate with:  npm run db:bundle
--
-- HOW TO APPLY (no CLI login or database password needed):
--   1. Supabase Dashboard → your project → SQL Editor → New query
--   2. Paste this entire file
--   3. Run
--
-- Wrapped in a transaction: if any statement fails, nothing is applied and
-- the project is left exactly as it was.
--
-- Concatenated in order: 0001_schema.sql, 0002_triggers.sql, 0003_rls.sql, 0004_fix_insert_returning_visibility.sql, 0005_fix_membership_escalation.sql, 0006_require_aal2.sql, 0007_consent_timestamp_integrity.sql, 0008_harden_new_functions.sql, 0009_profile_on_signup.sql, 0010_username_availability.sql, 0011_enable_realtime.sql, 0012_storage_policies.sql, 0013_video.sql, 0014_video_storage_policies.sql, 0015_memory_pins.sql, 0016_fix_pin_insert_returning.sql, 0017_map_spaces.sql, 0018_location_search_history.sql, 0019_pins_membership_only.sql, 0020_pin_place_name.sql, 0021_pin_song_title.sql, 0022_pin_song_start_time.sql
-- Generated: 2026-09-16
-- ============================================================================

begin;

-- ==========================================================================
-- SOURCE: 0001_schema.sql
-- ==========================================================================

-- =============================================================================
-- Yappr — Firestore → PostgreSQL schema
-- =============================================================================
-- Normalises the Firestore document model into relational tables.
--
-- Three Firestore patterns are deliberately restructured rather than copied:
--
--   1. Arrays-as-membership (chats.participants[], chats.admins[]) become the
--      conversation_members join table. Firestore needed the array to support
--      `array-contains`; in Postgres a join table gives real foreign keys,
--      per-member metadata (role, joined_at), and cheap membership indexes.
--
--   2. Maps-as-sets (reactions{emoji: [uid]}, readBy[], deliveredTo[]) become
--      row-per-fact tables. The map form could not enforce that a uid existed,
--      could not be indexed, and required read-modify-write to update — which
--      silently drops concurrent reactions.
--
--   3. Composite string document ids (likes/`${postId}_${userId}`) become real
--      composite primary keys. See MIGRATION.md — the string form is currently
--      constructed in two different field orders by different components,
--      which is an active bug that this structure makes impossible.
-- =============================================================================

create extension if not exists "pg_trgm";      -- trigram index for username search
create extension if not exists "pgcrypto";     -- gen_random_uuid()

-- --- Enums -------------------------------------------------------------------

create type post_type          as enum ('text', 'image', 'voice');
create type post_visibility    as enum ('public', 'followers', 'private');
create type conversation_type  as enum ('direct', 'group');
create type message_type       as enum ('text', 'image', 'voice', 'post', 'system');
create type member_role        as enum ('member', 'admin');
create type notification_type  as enum ('like', 'comment', 'message', 'follow', 'reaction', 'mention');
create type music_usage        as enum ('used', 'listened');
create type presence_status    as enum ('active', 'idle', 'offline');
create type security_event_type as enum (
  'sign_in', 'sign_in_new_device', 'password_changed',
  'password_reset_requested', 'mfa_enrolled', 'mfa_removed'
);

-- --- Shared helpers ----------------------------------------------------------

create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =============================================================================
-- Songs — deduplicated music metadata
-- =============================================================================
-- Firestore embedded the full song object on every user and every post, so the
-- same track was stored dozens of times and a corrected title fixed only one
-- copy. Keyed on the YouTube id so each track exists once.

create table songs (
  id          uuid primary key default gen_random_uuid(),
  youtube_id  text not null unique,
  title       text not null,
  artist      text not null default '',
  cover_url   text,
  start_time  integer not null default 0 check (start_time >= 0),
  created_at  timestamptz not null default now()
);

-- =============================================================================
-- Users
-- =============================================================================
-- id mirrors auth.users(id). `firebase_uid` is retained permanently: it is the
-- key the migration maps old references through, and keeping it makes the
-- migration auditable and re-runnable rather than a one-way door.

create table users (
  id                uuid primary key references auth.users(id) on delete cascade,
  firebase_uid      text unique,
  username          text not null unique
                      check (username ~ '^[a-z0-9_]{3,30}$'),
  display_name      text not null default '',
  email             text not null,
  photo_url         text,
  bio               text default '',
  theme_song_id     uuid references songs(id) on delete set null,

  status            presence_status not null default 'offline',
  last_active       timestamptz,

  terms_version     text,
  terms_accepted_at timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create trigger users_updated_at before update on users
  for each row execute function set_updated_at();

-- Case-insensitive exact lookup (login, @mention resolution).
create unique index users_username_lower_idx on users (lower(username));
create unique index users_email_lower_idx    on users (lower(email));
-- Substring search — Explore does `username ILIKE %term%`, which cannot use a
-- b-tree. Trigram makes it an index scan instead of a full table scan.
create index users_username_trgm_idx     on users using gin (username gin_trgm_ops);
create index users_display_name_trgm_idx on users using gin (display_name gin_trgm_ops);
create index users_firebase_uid_idx      on users (firebase_uid);

-- =============================================================================
-- Follows
-- =============================================================================
-- Composite PK. Firestore used addDoc(), which permitted duplicate follow rows
-- for the same pair — the app deduplicated in the client and the follower
-- counts drifted. The PK makes duplicates impossible.

create table follows (
  follower_id  uuid not null references users(id) on delete cascade,
  following_id uuid not null references users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (follower_id, following_id),
  constraint no_self_follow check (follower_id <> following_id)
);

create index follows_following_idx on follows (following_id, created_at desc);
create index follows_follower_idx  on follows (follower_id, created_at desc);

-- =============================================================================
-- Posts
-- =============================================================================

create table posts (
  id             uuid primary key default gen_random_uuid(),
  firebase_id    text unique,
  user_id        uuid not null references users(id) on delete cascade,
  content        text not null default '',
  type           post_type not null default 'text',
  visibility     post_visibility not null default 'public',
  voice_url      text,
  song_id        uuid references songs(id) on delete set null,

  -- Denormalised counters, maintained by trigger rather than by the client.
  -- Firestore used increment() from the browser, so a failed second write left
  -- the count permanently wrong.
  likes_count    integer not null default 0 check (likes_count >= 0),
  comments_count integer not null default 0 check (comments_count >= 0),

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger posts_updated_at before update on posts
  for each row execute function set_updated_at();

-- Feed pagination: newest-first, keyset paginated on (created_at, id).
create index posts_created_at_idx      on posts (created_at desc, id desc);
create index posts_user_created_idx    on posts (user_id, created_at desc);
-- Partial index: the global/discovery feed only ever reads public posts.
create index posts_public_created_idx  on posts (created_at desc)
  where visibility = 'public';

-- Ordered image list, replacing the imageUrls[] array.
create table post_images (
  post_id  uuid not null references posts(id) on delete cascade,
  position smallint not null check (position >= 0),
  url      text not null,
  primary key (post_id, position)
);

-- Edit history, replacing the editHistory[] array of objects.
create table post_edits (
  id                uuid primary key default gen_random_uuid(),
  post_id           uuid not null references posts(id) on delete cascade,
  previous_content  text not null,
  edited_at         timestamptz not null default now()
);
create index post_edits_post_idx on post_edits (post_id, edited_at desc);

-- =============================================================================
-- Likes
-- =============================================================================
-- Composite PK replaces the `${postId}_${userId}` document id. See MIGRATION.md
-- for why that string key is actively broken today.

create table likes (
  post_id    uuid not null references posts(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create index likes_user_idx      on likes (user_id, created_at desc);
create index likes_post_recent_idx on likes (post_id, created_at desc);

-- =============================================================================
-- Comments
-- =============================================================================
-- Flattened from the posts/{postId}/comments subcollection into a table with a
-- real foreign key.

create table comments (
  id           uuid primary key default gen_random_uuid(),
  firebase_id  text unique,
  post_id      uuid not null references posts(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  content      text not null default '',
  type         post_type not null default 'text',
  image_url    text,
  voice_url    text,
  reply_to_id  uuid references comments(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index comments_post_idx on comments (post_id, created_at desc);
create index comments_user_idx on comments (user_id, created_at desc);

-- =============================================================================
-- Reactions — one row per (target, user), replacing the {emoji: [uid]} maps
-- =============================================================================
-- The map form required read-modify-write of the whole object, so two people
-- reacting at the same moment could overwrite each other. A unique row per
-- user makes concurrent reactions safe and enforces one reaction per person.

create table post_reactions (
  post_id    uuid not null references posts(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  emoji      text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create index post_reactions_post_idx on post_reactions (post_id);

create table comment_reactions (
  comment_id uuid not null references comments(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  emoji      text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);
create index comment_reactions_comment_idx on comment_reactions (comment_id);

-- =============================================================================
-- Conversations and membership
-- =============================================================================

create table conversations (
  id           uuid primary key default gen_random_uuid(),
  firebase_id  text unique,
  type         conversation_type not null,
  name         text,
  photo_url    text,
  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now(),
  -- Ordering key for the inbox; bumped by trigger on new messages.
  updated_at   timestamptz not null default now(),

  constraint group_needs_name
    check (type <> 'group' or (name is not null and length(trim(name)) > 0))
);

create index conversations_updated_idx on conversations (updated_at desc);

create table conversation_members (
  conversation_id uuid not null references conversations(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  role            member_role not null default 'member',
  joined_at       timestamptz not null default now(),
  -- Per-member inbox state, replacing the client-side unread scan.
  last_read_at    timestamptz,
  primary key (conversation_id, user_id)
);

-- Drives "my conversations", ordered by recency.
create index conversation_members_user_idx on conversation_members (user_id);
create index conversation_members_conv_idx on conversation_members (conversation_id);

-- =============================================================================
-- Messages
-- =============================================================================

create table messages (
  id              uuid primary key default gen_random_uuid(),
  firebase_id     text unique,
  conversation_id uuid not null references conversations(id) on delete cascade,
  sender_id       uuid references users(id) on delete set null, -- null = system
  content         text not null default '',
  type            message_type not null default 'text',
  image_url       text,
  voice_url       text,
  reply_to_id     uuid references messages(id) on delete set null,
  shared_post_id  uuid references posts(id) on delete set null,
  created_at      timestamptz not null default now(),
  edited_at       timestamptz
);

-- The dominant query: one conversation's history, newest first, paginated.
create index messages_conversation_idx on messages (conversation_id, created_at desc);
create index messages_sender_idx       on messages (sender_id, created_at desc);

-- Delivery/read receipts, replacing readBy[] and deliveredTo[].
-- A row exists once the message reaches a recipient; read_at fills in later.
create table message_receipts (
  message_id   uuid not null references messages(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  delivered_at timestamptz not null default now(),
  read_at      timestamptz,
  primary key (message_id, user_id)
);
create index message_receipts_user_unread_idx
  on message_receipts (user_id) where read_at is null;

create table message_reactions (
  message_id uuid not null references messages(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  emoji      text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

-- =============================================================================
-- Notifications
-- =============================================================================

create table notifications (
  id           uuid primary key default gen_random_uuid(),
  firebase_id  text unique,
  recipient_id uuid not null references users(id) on delete cascade,
  actor_id     uuid references users(id) on delete cascade,
  type         notification_type not null,
  subtype      text,
  content      text,
  post_id      uuid references posts(id) on delete cascade,
  comment_id   uuid references comments(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete cascade,
  is_read      boolean not null default false,
  created_at   timestamptz not null default now()
);

-- Badge count and list are both "my unread, newest first".
create index notifications_recipient_idx on notifications (recipient_id, created_at desc);
create index notifications_unread_idx    on notifications (recipient_id)
  where is_read = false;

-- =============================================================================
-- Music history
-- =============================================================================

create table music_history (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  song_id    uuid not null references songs(id) on delete cascade,
  kind       music_usage not null,
  created_at timestamptz not null default now()
);
create index music_history_user_idx on music_history (user_id, created_at desc);

-- =============================================================================
-- Push subscriptions
-- =============================================================================

create table push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
create index push_subscriptions_user_idx on push_subscriptions (user_id);

-- =============================================================================
-- Security events — append-only audit log
-- =============================================================================

create table security_events (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  type         security_event_type not null,
  device_id    text not null,
  device_label text,
  ip_address   inet,
  created_at   timestamptz not null default now()
);
create index security_events_user_idx on security_events (user_id, created_at desc);

-- =============================================================================
-- Migration audit
-- =============================================================================
-- Every row the migration could not place lands here instead of being dropped,
-- so a failed record is a visible artefact rather than a silent absence.

create table migration_issues (
  id            bigserial primary key,
  source_path   text not null,    -- e.g. chats/abc123/messages/def456
  target_table  text,
  severity      text not null check (severity in ('warning', 'error')),
  reason        text not null,
  payload       jsonb,
  created_at    timestamptz not null default now()
);
create index migration_issues_severity_idx on migration_issues (severity, created_at desc);


-- ==========================================================================
-- SOURCE: 0002_triggers.sql
-- ==========================================================================

-- =============================================================================
-- Derived state — maintained by the database, not the client
-- =============================================================================
-- Firestore incremented likes_count / commentsCount from the browser with a
-- second write after the like itself. Any failure between the two left the
-- counter permanently wrong, and there was no way to detect the drift. These
-- triggers make the counter a consequence of the row existing, inside the same
-- transaction, so it cannot disagree with reality.
-- =============================================================================

-- --- Post counters -----------------------------------------------------------

create or replace function bump_post_likes_count()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update posts set likes_count = likes_count + 1 where id = new.post_id;
  elsif tg_op = 'DELETE' then
    update posts set likes_count = greatest(likes_count - 1, 0) where id = old.post_id;
  end if;
  return null;
end;
$$;

create trigger likes_count_sync
  after insert or delete on likes
  for each row execute function bump_post_likes_count();

create or replace function bump_post_comments_count()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update posts set comments_count = comments_count + 1 where id = new.post_id;
  elsif tg_op = 'DELETE' then
    update posts set comments_count = greatest(comments_count - 1, 0) where id = old.post_id;
  end if;
  return null;
end;
$$;

create trigger comments_count_sync
  after insert or delete on comments
  for each row execute function bump_post_comments_count();

-- --- Conversation ordering ---------------------------------------------------
-- The inbox sorts by conversations.updated_at. Firestore required the sender to
-- write chats/{id}.lastMessage and updatedAt as a separate operation, which
-- could fail independently and leave a conversation stuck at the wrong
-- position with a stale preview.

create or replace function touch_conversation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update conversations set updated_at = new.created_at where id = new.conversation_id;
  return null;
end;
$$;

create trigger messages_touch_conversation
  after insert on messages
  for each row execute function touch_conversation();

-- --- Delivery receipts -------------------------------------------------------
-- Creates a pending receipt row for every member except the sender the moment a
-- message is inserted. `delivered_at` is set when the recipient's client
-- acknowledges; until then the row exists with read_at null, which is what the
-- unread count reads.

create or replace function fan_out_message_receipts()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into message_receipts (message_id, user_id, delivered_at, read_at)
  select new.id, cm.user_id, null, null
  from conversation_members cm
  where cm.conversation_id = new.conversation_id
    and (new.sender_id is null or cm.user_id <> new.sender_id)
  on conflict do nothing;
  return null;
end;
$$;

create trigger messages_fan_out_receipts
  after insert on messages
  for each row execute function fan_out_message_receipts();

-- delivered_at must be nullable for the pending state above.
alter table message_receipts alter column delivered_at drop not null;
alter table message_receipts alter column delivered_at drop default;

-- --- Direct-conversation uniqueness -----------------------------------------
-- Firestore had no way to prevent two people simultaneously creating a direct
-- chat with each other, producing duplicate threads. This enforces one direct
-- conversation per unordered pair.

create or replace function direct_conversation_key(conv_id uuid)
returns text language sql stable as $$
  select string_agg(user_id::text, ':' order by user_id)
  from conversation_members where conversation_id = conv_id;
$$;

create table direct_conversation_keys (
  conversation_id uuid primary key references conversations(id) on delete cascade,
  pair_key        text not null unique
);

create or replace function register_direct_conversation()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  conv_type conversation_type;
  member_count int;
begin
  select type into conv_type from conversations where id = new.conversation_id;
  if conv_type <> 'direct' then return null; end if;

  select count(*) into member_count
  from conversation_members where conversation_id = new.conversation_id;

  -- Only register once both participants are present.
  if member_count = 2 then
    insert into direct_conversation_keys (conversation_id, pair_key)
    values (new.conversation_id, direct_conversation_key(new.conversation_id))
    on conflict (conversation_id) do update set pair_key = excluded.pair_key;
  end if;
  return null;
end;
$$;

create trigger conversation_members_register_direct
  after insert on conversation_members
  for each row execute function register_direct_conversation();

-- --- Backfill helper ---------------------------------------------------------
-- Recomputes every denormalised counter from source rows. Run after the
-- migration import, and any time you suspect drift. Safe to run repeatedly.

create or replace function recompute_counters()
returns table (posts_fixed bigint) language plpgsql as $$
begin
  return query
  with updated as (
    update posts p set
      likes_count = coalesce(l.n, 0),
      comments_count = coalesce(c.n, 0)
    from (select id from posts) ids
    left join (select post_id, count(*) n from likes group by post_id) l
      on l.post_id = ids.id
    left join (select post_id, count(*) n from comments group by post_id) c
      on c.post_id = ids.id
    where p.id = ids.id
      and (p.likes_count <> coalesce(l.n, 0) or p.comments_count <> coalesce(c.n, 0))
    returning 1
  )
  select count(*) from updated;
end;
$$;


-- ==========================================================================
-- SOURCE: 0003_rls.sql
-- ==========================================================================

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


-- ==========================================================================
-- SOURCE: 0004_fix_insert_returning_visibility.sql
-- ==========================================================================

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


-- ==========================================================================
-- SOURCE: 0005_fix_membership_escalation.sql
-- ==========================================================================

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


-- ==========================================================================
-- SOURCE: 0006_require_aal2.sql
-- ==========================================================================

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


-- ==========================================================================
-- SOURCE: 0007_consent_timestamp_integrity.sql
-- ==========================================================================

-- =============================================================================
-- Consent timestamps must come from the server
-- =============================================================================
-- WHY
--   `recordConsent()` wrote `termsAcceptedAt: serverTimestamp()` under
--   Firestore. That was not decoration: the row is a compliance record, and its
--   value is that the *server* says when consent happened. A client-supplied
--   timestamp can be back-dated by anyone with a modified device or a REST
--   client, which is exactly the claim the record is supposed to withstand.
--
--   The ported code was about to send `new Date().toISOString()` from the
--   browser. Same column, quietly worthless.
--
-- WHAT THIS DOES
--   1. A trigger stamps `terms_accepted_at = now()` whenever `terms_version`
--      changes, and preserves the old value when it does not. The client cannot
--      influence it either way.
--   2. `terms_accepted_at` is removed from the column grant, so an UPDATE that
--      names it is rejected outright rather than silently overwritten. Belt and
--      braces — the trigger already wins, but a rejected write is a clearer
--      signal than an ignored one.
--
--   This is strictly stronger than the Firestore behaviour it replaces:
--   serverTimestamp() still required the client to *ask* for a server clock.
--
-- Idempotent — safe to run repeatedly.
-- =============================================================================


create or replace function stamp_consent_time()
returns trigger
language plpgsql
as $$
begin
  if new.terms_version is distinct from old.terms_version then
    new.terms_accepted_at := now();
  else
    -- Not a consent event: keep whatever was already recorded, regardless of
    -- what the update statement tried to put there.
    new.terms_accepted_at := old.terms_accepted_at;
  end if;
  return new;
end;
$$;

drop trigger if exists users_stamp_consent_time on users;
create trigger users_stamp_consent_time
  before update on users
  for each row
  execute function stamp_consent_time();

-- Signup writes both columns in the INSERT, which the trigger does not touch —
-- an insert is the account's first consent and its own timestamp is correct.

-- Re-issue the column grant without terms_accepted_at. Restating the whole list
-- rather than revoking one column: a column-level revoke is a no-op while a
-- table-level grant exists, which is the trap documented in 0003.
revoke update on users from authenticated;
grant update (display_name, photo_url, bio, theme_song_id, status, last_active,
              terms_version, updated_at)
  on users to authenticated;


-- ==========================================================================
-- SOURCE: 0008_harden_new_functions.sql
-- ==========================================================================

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


-- ==========================================================================
-- SOURCE: 0009_profile_on_signup.sql
-- ==========================================================================

-- =============================================================================
-- Create the profile row when the account is created, not afterwards
-- =============================================================================
-- THE BUG
--   AuthView signed the user up and then inserted their `public.users` row from
--   the browser as a second, separate call. That only works if signup returns a
--   session — and with email confirmation enabled (`mailer_autoconfirm = false`,
--   which is this project's setting) it does not. GoTrue returns a user with no
--   session, so the follow-up insert ran unauthenticated, `users_insert_own`
--   rejected it with 42501, and the account was left half-created: an
--   `auth.users` row with no profile.
--
--   That state is not self-healing. On the next sign-in App.tsx looks for the
--   profile, does not find one, and bounces the user back to the auth screen —
--   permanently. The account exists, cannot be used, and cannot be re-created
--   because the email is now taken.
--
--   Even with confirmation off it was only ever two writes with no transaction
--   around them: any failure between them produced the same orphan.
--
-- THE FIX
--   A trigger on `auth.users`. The profile is created in the same transaction
--   as the account, so the two cannot diverge. Signup passes username,
--   display name and consent version through `options.data`, which GoTrue
--   stores in `raw_user_meta_data`, and the trigger reads them from there.
--
-- WHY THE `? 'username'` GUARD
--   It fires only for accounts created through the app's signup form. Users
--   created by the admin API — the RLS suite, the migration importer — carry no
--   such metadata and are skipped, so those scripts keep inserting their own
--   profile rows exactly as before. Without this guard the trigger would insert
--   first and every one of those scripts would then fail on a duplicate id.
--
-- CONSENT TIMESTAMP
--   `terms_accepted_at` is set directly here. That is the INSERT path, which
--   0007's trigger deliberately does not touch — an insert is the account's
--   first consent and `now()` inside this trigger is still a server clock.
--
-- Idempotent — safe to run repeatedly.
-- =============================================================================


create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  meta_username     text := new.raw_user_meta_data ->> 'username';
  meta_display_name text := new.raw_user_meta_data ->> 'display_name';
  meta_terms        text := new.raw_user_meta_data ->> 'terms_version';
begin
  -- Only accounts created through the signup form carry this metadata.
  if meta_username is null then
    return new;
  end if;

  insert into public.users (id, username, display_name, email,
                            terms_version, terms_accepted_at)
  values (
    new.id,
    meta_username,
    coalesce(nullif(meta_display_name, ''), meta_username),
    new.email,
    nullif(meta_terms, ''),
    case when nullif(meta_terms, '') is not null then now() end
  );

  return new;
end;
$$;

comment on function handle_new_user() is
  'Creates the public.users profile in the same transaction as the auth account. '
  'Skips admin-created users (no username in raw_user_meta_data).';

-- Nothing calls this directly; the trigger does not need EXECUTE to fire.
-- Naming PUBLIC *and* the per-role grants, because Supabase's default
-- privileges add explicit ones on top of PostgreSQL's blanket grant and a
-- narrower revoke is silently satisfied by whichever one it missed. See 0008.
revoke execute on function handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function handle_new_user();


-- ==========================================================================
-- SOURCE: 0010_username_availability.sql
-- ==========================================================================

-- =============================================================================
-- Let the signup form check whether a username is free
-- =============================================================================
-- THE PROBLEM
--   Signup writes the `public.users` row from a trigger inside the same
--   transaction as the auth account, so a duplicate username rolls the entire
--   signup back. GoTrue reports that as HTTP 500 "Database error saving new
--   user" — no error code, no column, nothing pointing at the username. The UI
--   could only fall back to "Something went wrong. Please try again."
--
--   The obvious client-side fix — count matching rows before submitting —
--   does not work. At that moment the caller is still `anon`, and
--   `users_select` is `to authenticated`, so RLS hides every row and the count
--   is always zero. The check silently passes and the signup fails anyway.
--   (Verified: an existing username reported as available.)
--
-- THE FIX
--   A SECURITY DEFINER function that answers one boolean question and is
--   callable by `anon`. It runs as the owner, so RLS does not hide the row.
--
-- WHAT THIS DOES AND DOES NOT EXPOSE
--   It returns a boolean and nothing else — no id, no email, no profile data.
--   It does confirm whether a given handle is taken, which is inherently public
--   in this app: usernames appear on every profile, in search results and in
--   @mentions. There is nothing here that visiting /u/<name> would not reveal.
--
--   Contrast with email: `email_not_confirmed` vs `invalid_credentials` is
--   carefully managed precisely because email existence is NOT public. No
--   equivalent function exists for email, and none should.
--
-- Idempotent — safe to run repeatedly.
-- =============================================================================


create or replace function username_available(candidate text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    -- Same rule as users_username_check. Rejecting the format here too means
    -- the caller gets one answer for "unusable", whatever the reason.
    candidate ~ '^[a-z0-9_]{3,30}$'
    and not exists (select 1 from public.users u where u.username = candidate);
$$;

comment on function username_available(text) is
  'True when the handle is well-formed and unclaimed. Callable pre-signup, so anon needs EXECUTE.';

-- Name PUBLIC and both roles explicitly. Supabase layers per-role grants on top
-- of PostgreSQL's default PUBLIC grant, so a narrower statement is silently
-- satisfied by whichever grant it missed — the trap documented in 0008.
revoke execute on function username_available(text) from public, anon, authenticated;
grant  execute on function username_available(text) to anon, authenticated;


-- ==========================================================================
-- SOURCE: 0011_enable_realtime.sql
-- ==========================================================================

-- =============================================================================
-- Publish the tables the app subscribes to
-- =============================================================================
-- The `supabase_realtime` publication was EMPTY. Every `postgres_changes`
-- subscription in src/lib/db.ts therefore reached SUBSCRIBED and then received
-- nothing, forever — the worst possible failure shape, because the client
-- reports success and simply stays silent.
--
-- What was silently dead: new messages in an open chat, inbox reordering, the
-- notification bell, feed inserts, like and comment counters, live comment
-- threads, presence and profile edits.
--
-- (`supabase_realtime_messages_publication`, holding `messages_2026_08_*`, is
-- Realtime's own internal partitioned broadcast storage. It is unrelated to
-- `public.messages` and is easy to mistake for it.)
--
-- RLS STILL APPLIES. Realtime evaluates the same policies per subscriber before
-- delivering a row, so publishing a table does not widen who can see what.
--
-- Idempotent — safe to run repeatedly.
-- =============================================================================


do $$
declare
  t text;
begin
  foreach t in array array['users', 'posts', 'comments', 'messages', 'conversations', 'notifications']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;

-- --- REPLICA IDENTITY ---------------------------------------------------------
-- Postgres logs only the primary key of a deleted row by default, so a DELETE
-- arrives with everything except its id stripped out. Any subscription that
-- FILTERS on a non-key column therefore never matches a delete, and the row
-- stays on screen until a manual refresh.
--
-- That affects exactly these four:
--   messages       DELETE filtered on conversation_id
--   comments       event '*' filtered on post_id
--   posts          event '*' filtered on user_id
--   notifications  event '*' filtered on recipient_id
--
-- FULL logs the whole old row, which costs WAL volume. Accepted here because
-- these are small rows and a delete that never propagates is a visible bug.
--
-- `users` and `conversations` are left at DEFAULT: both are subscribed to for
-- UPDATE only, and an update always carries the complete new row.
alter table public.messages      replica identity full;
alter table public.comments      replica identity full;
alter table public.posts         replica identity full;
alter table public.notifications replica identity full;


-- ==========================================================================
-- SOURCE: 0012_storage_policies.sql
-- ==========================================================================

-- =============================================================================
-- Storage: access policies for the avatars / posts / chat buckets
-- =============================================================================
-- The buckets themselves are created by
-- scripts/migrate/create-storage-buckets.ts (they are not SQL objects). This
-- file grants access to them.
--
-- Until both existed, EVERY upload in the app failed at once — post images,
-- comment attachments, chat photos and voice notes, group photos, avatars —
-- because there was nowhere to write and, once there was, no policy allowing
-- the write. `storage.objects` has RLS on by default with no policies, which
-- denies everything.
--
-- ── WHY THE THREE BUCKETS DIFFER ─────────────────────────────────────────────
-- The object paths the app actually writes are not uniform, and the policies
-- have to match what the code does rather than an idealised layout:
--
--   avatars   <uid>/<timestamp>                     — always owner-foldered
--   posts     <uid>/<timestamp>-<n>-<filename>      — post images
--             <uid>/<timestamp>-voice.webm          — voice posts
--             groups/<conversationId>-<timestamp>   — group photos
--             comments/<postId>/<uid>-<timestamp>   — comment attachments
--   chat      <conversationId>/<uid>-<timestamp>    — always conversation-foldered
--
-- So `avatars` and `chat` can be constrained by their first path segment.
-- `posts` cannot: two of its four shapes do not begin with the uploader's id.
-- It is therefore gated on `owner` for mutation instead, which Supabase sets
-- from auth.uid() on insert. The trade is that any signed-in user may add an
-- object under any path in `posts`; bucket-level MIME and size limits bound the
-- damage, and nothing can be overwritten or deleted by a non-owner.
--
-- Idempotent — safe to run repeatedly.
-- =============================================================================


-- --- avatars: public read, owner-foldered writes ------------------------------

drop policy if exists avatars_read on storage.objects;
create policy avatars_read on storage.objects
  for select using (bucket_id = 'avatars');

drop policy if exists avatars_insert_own on storage.objects;
create policy avatars_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists avatars_update_own on storage.objects;
create policy avatars_update_own on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and owner = auth.uid())
  with check (bucket_id = 'avatars' and owner = auth.uid());

drop policy if exists avatars_delete_own on storage.objects;
create policy avatars_delete_own on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and owner = auth.uid());

-- --- posts: public read, any signed-in user may add, owner may change ---------
-- See the note above on why this is not owner-foldered.

drop policy if exists posts_read on storage.objects;
create policy posts_read on storage.objects
  for select using (bucket_id = 'posts');

drop policy if exists posts_insert_authenticated on storage.objects;
create policy posts_insert_authenticated on storage.objects
  for insert to authenticated
  with check (bucket_id = 'posts');

drop policy if exists posts_update_own on storage.objects;
create policy posts_update_own on storage.objects
  for update to authenticated
  using (bucket_id = 'posts' and owner = auth.uid())
  with check (bucket_id = 'posts' and owner = auth.uid());

drop policy if exists posts_delete_own on storage.objects;
create policy posts_delete_own on storage.objects
  for delete to authenticated
  using (bucket_id = 'posts' and owner = auth.uid());

-- --- chat: private, readable only by members of that conversation -------------
-- The first path segment is the conversation id, so membership is checkable
-- directly. The regex guard matters: a path whose first segment is not a UUID
-- would make the ::uuid cast raise, and an error inside a policy fails the
-- whole statement rather than just denying the row.

drop policy if exists chat_read_members on storage.objects;
create policy chat_read_members on storage.objects
  for select to authenticated
  using (
    bucket_id = 'chat'
    and (storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
    and is_conversation_member(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists chat_insert_members on storage.objects;
create policy chat_insert_members on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'chat'
    and (storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
    and is_conversation_member(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists chat_delete_own on storage.objects;
create policy chat_delete_own on storage.objects
  for delete to authenticated
  using (bucket_id = 'chat' and owner = auth.uid());


-- ==========================================================================
-- SOURCE: 0013_video.sql
-- ==========================================================================

-- =============================================================================
-- Video: enum values and columns for posts and messages
-- =============================================================================
-- Verified against the live project before writing this
-- (scripts/migrate/diagnose-video-readiness.ts):
--
--   posts.type      is enum post_type     — rejects 'video'
--   messages.type   is enum message_type  — rejects 'video'
--   posts.video_url                       — does not exist
--   messages.video_url                    — does not exist
--
-- So nothing about the existing image/voice support carries over; a video
-- cannot even be represented until this runs.
--
-- ── WHY A SEPARATE COLUMN RATHER THAN REUSING image_url ──────────────────────
-- A video needs two URLs, not one: the file, and a poster frame to show before
-- playback starts. Overloading image_url would leave no place for the poster,
-- and would make every existing `type = 'image'` query ambiguous.
--
-- ── WHY THE ENUM CHANGE IS OUTSIDE THE TRANSACTION ──────────────────────────
-- A value added by ALTER TYPE ... ADD VALUE cannot be used by other statements
-- until the adding transaction commits. Keeping the enum changes outside the
-- begin/commit below means this file can be run top to bottom in one go.
--
-- Idempotent — safe to run repeatedly.
-- =============================================================================

alter type post_type add value if not exists 'video';
alter type message_type add value if not exists 'video';


-- --- posts -------------------------------------------------------------------
alter table public.posts add column if not exists video_url text;
alter table public.posts add column if not exists video_poster_url text;

comment on column public.posts.video_url is
  'Public URL in the post-videos bucket. Null unless type = ''video''.';
comment on column public.posts.video_poster_url is
  'Public URL of the first-frame poster, generated client-side at upload. '
  'Shown before playback so the feed never renders a black rectangle.';

-- --- messages ----------------------------------------------------------------
alter table public.messages add column if not exists video_url text;
alter table public.messages add column if not exists video_poster_url text;

comment on column public.messages.video_url is
  'supabase://chat-videos/<conversationId>/... — the bucket is private, so this '
  'is the scheme form and readers mint a signed URL via resolveStorageUrl().';
comment on column public.messages.video_poster_url is
  'Poster frame for the message video, in the same private bucket.';

-- --- realtime ----------------------------------------------------------------
-- posts and messages are already in the supabase_realtime publication with
-- REPLICA IDENTITY FULL (0011); new columns are carried automatically, so
-- nothing to add here. Recorded so the next reader does not go looking.


-- ==========================================================================
-- SOURCE: 0014_video_storage_policies.sql
-- ==========================================================================

-- =============================================================================
-- Storage: access policies for the post-videos / chat-videos buckets
-- =============================================================================
-- The buckets are created by scripts/migrate/create-video-buckets.ts (buckets
-- are not SQL objects). This file grants access to them.
--
-- ── WHY TWO BUCKETS RATHER THAN ONE "videos" BUCKET ─────────────────────────
-- The two audiences are incompatible inside one bucket. Post videos must be
-- publicly readable — the feed renders them for anyone allowed to see the post,
-- and signing every URL would mean a round trip per video. Chat videos must be
-- readable only by members of that conversation.
--
-- A PUBLIC bucket bypasses RLS for reads entirely: Supabase serves
-- /object/public/<bucket>/<path> with no auth at all. So a single public bucket
-- would expose every chat video to anyone who guessed a path, no matter what
-- SELECT policy were written. Splitting is not tidiness — it is the only way to
-- have both semantics.
--
-- ── PATHS ────────────────────────────────────────────────────────────────────
--   post-videos   <uid>/<timestamp>.<ext>              — and .poster.jpg
--   chat-videos   <conversationId>/<uid>-<timestamp>   — and .poster.jpg
--
-- post-videos is owner-foldered, which the `posts` bucket could not be: every
-- path here is written by the uploader for their own post, so unlike `posts`
-- there is no groups/ or comments/ shape to accommodate. That makes it strictly
-- tighter than the bucket it sits beside.
--
-- Idempotent — safe to run repeatedly.
-- =============================================================================


-- --- post-videos: public read, owner-foldered writes -------------------------

drop policy if exists post_videos_read on storage.objects;
create policy post_videos_read on storage.objects
  for select using (bucket_id = 'post-videos');

drop policy if exists post_videos_insert_own on storage.objects;
create policy post_videos_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'post-videos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists post_videos_update_own on storage.objects;
create policy post_videos_update_own on storage.objects
  for update to authenticated
  using (bucket_id = 'post-videos' and owner = auth.uid())
  with check (bucket_id = 'post-videos' and owner = auth.uid());

drop policy if exists post_videos_delete_own on storage.objects;
create policy post_videos_delete_own on storage.objects
  for delete to authenticated
  using (bucket_id = 'post-videos' and owner = auth.uid());

-- --- chat-videos: private, members of that conversation only -----------------
-- Mirrors the `chat` bucket exactly, including the regex guard: a first path
-- segment that is not a UUID would make the ::uuid cast raise, and an error
-- raised inside a policy fails the whole statement rather than denying the row.

drop policy if exists chat_videos_read_members on storage.objects;
create policy chat_videos_read_members on storage.objects
  for select to authenticated
  using (
    bucket_id = 'chat-videos'
    and (storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
    and is_conversation_member(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists chat_videos_insert_members on storage.objects;
create policy chat_videos_insert_members on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'chat-videos'
    and (storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
    and is_conversation_member(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists chat_videos_delete_own on storage.objects;
create policy chat_videos_delete_own on storage.objects
  for delete to authenticated
  using (bucket_id = 'chat-videos' and owner = auth.uid());


-- ==========================================================================
-- SOURCE: 0015_memory_pins.sql
-- ==========================================================================

-- =============================================================================
-- Memory Pins: a map location carrying media, shared with people or groups
-- =============================================================================
-- Three tables:
--
--   pins         the location and its caption
--   pin_media    photos / videos / songs attached to a pin, ordered
--   pin_shares   who a pin is shared with — a person OR a conversation
--
-- ── PINS ARE PRIVATE BY DEFAULT ──────────────────────────────────────────────
-- Unlike posts, which have a public/followers/private visibility column, a pin
-- is visible to its creator and to nobody else until it is explicitly shared.
-- There is no "public" state at all. That is why the SELECT policy is a
-- whitelist (creator OR an explicit share) rather than a filter over a
-- visibility enum: a bug in a filter shows too much, a bug in a whitelist shows
-- too little.
--
-- ── WHY pin_shares HAS TWO NULLABLE TARGETS ─────────────────────────────────
-- A share points at exactly one of a user or a conversation, enforced by a
-- check constraint rather than by convention. Two columns with a constraint
-- beats a (target_type, target_id) pair because the foreign keys stay real:
-- deleting a user or a conversation takes its shares with it.
--
-- Idempotent — safe to run repeatedly.
-- =============================================================================


-- --- media kinds -------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'pin_media_type') then
    create type pin_media_type as enum ('photo', 'video', 'song');
  end if;
end $$;

-- --- pins --------------------------------------------------------------------
create table if not exists public.pins (
  id          uuid primary key default gen_random_uuid(),
  creator_id  uuid not null references public.users(id) on delete cascade,
  -- numeric, not float: a pin is a place, and binary floating point should not
  -- quietly move it. 9 significant digits is ~0.1mm at the equator.
  latitude    numeric(11, 8) not null check (latitude between -90 and 90),
  longitude   numeric(11, 8) not null check (longitude between -180 and 180),
  caption     text check (caption is null or char_length(caption) <= 500),
  created_at  timestamptz not null default now()
);

create index if not exists pins_creator_idx on public.pins (creator_id, created_at desc);

-- --- pin_media ---------------------------------------------------------------
create table if not exists public.pin_media (
  id                uuid primary key default gen_random_uuid(),
  pin_id            uuid not null references public.pins(id) on delete cascade,
  media_type        pin_media_type not null,
  -- Storage URL for a photo or video; null for a song.
  media_url         text,
  -- YouTube id for a song; null otherwise. Reuses the existing player.
  youtube_video_id  text,
  poster_url        text,
  order_index       int not null default 0,
  created_at        timestamptz not null default now(),

  -- A song needs a youtube id and a photo/video needs a url. Without this a row
  -- can exist that renders as nothing at all.
  constraint pin_media_has_a_source check (
    (media_type = 'song' and youtube_video_id is not null)
    or (media_type in ('photo', 'video') and media_url is not null)
  )
);

create index if not exists pin_media_pin_idx on public.pin_media (pin_id, order_index);

-- --- pin_shares --------------------------------------------------------------
create table if not exists public.pin_shares (
  id                  uuid primary key default gen_random_uuid(),
  pin_id              uuid not null references public.pins(id) on delete cascade,
  shared_with_user_id uuid references public.users(id) on delete cascade,
  conversation_id     uuid references public.conversations(id) on delete cascade,
  created_at          timestamptz not null default now(),

  -- Exactly one target. Neither would be a share with nobody; both would make
  -- "who is this shared with" ambiguous.
  constraint pin_shares_one_target check (
    (shared_with_user_id is not null and conversation_id is null)
    or (shared_with_user_id is null and conversation_id is not null)
  )
);

-- Sharing the same pin with the same target twice is a no-op, not a new row.
create unique index if not exists pin_shares_user_uniq
  on public.pin_shares (pin_id, shared_with_user_id)
  where shared_with_user_id is not null;
create unique index if not exists pin_shares_conversation_uniq
  on public.pin_shares (pin_id, conversation_id)
  where conversation_id is not null;

create index if not exists pin_shares_user_idx on public.pin_shares (shared_with_user_id);
create index if not exists pin_shares_conversation_idx on public.pin_shares (conversation_id);

-- =============================================================================
-- RLS
-- =============================================================================
alter table public.pins       enable row level security;
alter table public.pin_media  enable row level security;
alter table public.pin_shares enable row level security;

/**
 * Can the caller see this pin?
 *
 * SECURITY DEFINER so that reading pin_shares from inside a pins policy does
 * not itself require a pin_shares policy to pass — that recursion is how
 * "permission denied" appears on a table whose policy looks correct.
 *
 * search_path is pinned: a SECURITY DEFINER function without it can be
 * hijacked by a caller-controlled search_path.
 */
create or replace function public.can_view_pin(pin uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.pins p
     where p.id = pin
       and p.creator_id = (select auth.uid())
  )
  or exists (
    select 1 from public.pin_shares s
     where s.pin_id = pin
       and (
         s.shared_with_user_id = (select auth.uid())
         or (s.conversation_id is not null and public.is_conversation_member(s.conversation_id))
       )
  );
$$;

revoke all on function public.can_view_pin(uuid) from public;
grant execute on function public.can_view_pin(uuid) to authenticated;

-- --- pins --------------------------------------------------------------------
drop policy if exists pins_select_visible on public.pins;
create policy pins_select_visible on public.pins
  for select to authenticated
  using (public.can_view_pin(id));

drop policy if exists pins_insert_own on public.pins;
create policy pins_insert_own on public.pins
  for insert to authenticated
  with check (creator_id = (select auth.uid()));

drop policy if exists pins_update_own on public.pins;
create policy pins_update_own on public.pins
  for update to authenticated
  using (creator_id = (select auth.uid()))
  with check (creator_id = (select auth.uid()));

drop policy if exists pins_delete_own on public.pins;
create policy pins_delete_own on public.pins
  for delete to authenticated
  using (creator_id = (select auth.uid()));

-- --- pin_media ---------------------------------------------------------------
-- Readable by anyone who can read the pin; writable only by its creator. A
-- recipient with write access could add media to someone else's memory.
drop policy if exists pin_media_select_visible on public.pin_media;
create policy pin_media_select_visible on public.pin_media
  for select to authenticated
  using (public.can_view_pin(pin_id));

drop policy if exists pin_media_write_own on public.pin_media;
create policy pin_media_write_own on public.pin_media
  for all to authenticated
  using (exists (select 1 from public.pins p where p.id = pin_id and p.creator_id = (select auth.uid())))
  with check (exists (select 1 from public.pins p where p.id = pin_id and p.creator_id = (select auth.uid())));

-- --- pin_shares --------------------------------------------------------------
-- The creator manages shares. A recipient may read the share rows for a pin
-- they can already see, so the UI can say who else it went to.
drop policy if exists pin_shares_select_visible on public.pin_shares;
create policy pin_shares_select_visible on public.pin_shares
  for select to authenticated
  using (public.can_view_pin(pin_id));

drop policy if exists pin_shares_write_own on public.pin_shares;
create policy pin_shares_write_own on public.pin_shares
  for all to authenticated
  using (exists (select 1 from public.pins p where p.id = pin_id and p.creator_id = (select auth.uid())))
  with check (
    exists (select 1 from public.pins p where p.id = pin_id and p.creator_id = (select auth.uid()))
    -- A pin may only be shared into a conversation the sharer is actually in.
    -- Without this, anyone could push a pin into any group by id.
    and (conversation_id is null or public.is_conversation_member(conversation_id))
  );


-- ==========================================================================
-- SOURCE: 0016_fix_pin_insert_returning.sql
-- ==========================================================================

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


drop policy if exists pins_select_visible on public.pins;
create policy pins_select_visible on public.pins
  for select to authenticated
  using (
    -- Own column: available on the new row during INSERT ... RETURNING.
    creator_id = (select auth.uid())
    -- Different table, already committed: safe to look up.
    or public.can_view_pin(id)
  );


-- ==========================================================================
-- SOURCE: 0017_map_spaces.sql
-- ==========================================================================

-- =============================================================================
-- Map Spaces: persistent shared maps, replacing per-pin sharing
-- =============================================================================
-- A pin now belongs to a SPACE, and a space has members. Membership is the
-- whole visibility model: every member sees every pin in the space, and
-- everyone can keep adding to it over time. That replaces pin_shares, where a
-- pin was individually addressed to people and nothing accumulated.
--
-- ── SAFE TO DROP AND REBUILD ────────────────────────────────────────────────
-- Checked against the live project before writing this: pins, pin_media and
-- pin_shares all held 0 rows. The feature has never carried real data — its
-- insert path was broken until 0016 — so there is nothing to migrate and no
-- back-compat shim to keep.
--
-- ── INSERT ... RETURNING ────────────────────────────────────────────────────
-- Every SELECT policy below leads with a column of the row itself. Postgres
-- evaluates the SELECT policy against the new row whenever a statement uses
-- RETURNING, and PostgREST always uses RETURNING when the client calls
-- .select() after .insert(). A policy that re-queries its own table through a
-- STABLE function cannot see that row and denies it — which is what 0004 fixed
-- for conversations and 0016 for pins. Two rows here would hit it otherwise:
--
--   map_spaces        the creator has no membership row yet at RETURNING time
--   map_space_members the first member row cannot see itself
--
-- Both lead with created_by / user_id for exactly that reason.
--
-- Idempotent — safe to run repeatedly.
-- =============================================================================


-- --- retire the individual-sharing model -------------------------------------
-- pin_shares is gone; membership answers what it used to. can_view_pin() goes
-- with it — its whole body was a share lookup.
--
-- ORDER MATTERS HERE. A function cannot be dropped while a policy still
-- references it:
--
--   ERROR 2BP01: cannot drop function can_view_pin(uuid) because other objects
--   depend on it — policy pins_select_visible, policy pin_media_select_visible
--
-- Both are recreated further down against is_space_member(), so dropping them
-- up front costs nothing. DROP ... CASCADE would also clear the error, but it
-- would remove whatever else happened to depend on the function without
-- saying so; naming them keeps that explicit.
drop policy if exists pins_select_visible on public.pins;
drop policy if exists pin_media_select_visible on public.pin_media;

-- Dropping the table takes its own policies with it. Dropping them by name
-- first would break re-runs: `drop policy if exists … on public.pin_shares`
-- raises "relation does not exist" once the table is gone, and IF EXISTS on
-- the policy does not cover a missing table.
drop table if exists public.pin_shares;

drop function if exists public.can_view_pin(uuid);

-- --- roles -------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'map_space_role') then
    create type map_space_role as enum ('owner', 'member');
  end if;
end $$;

-- --- map_spaces --------------------------------------------------------------
create table if not exists public.map_spaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(trim(name)) between 1 and 80),
  created_by  uuid not null references public.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

create index if not exists map_spaces_creator_idx on public.map_spaces (created_by);

-- --- map_space_members -------------------------------------------------------
create table if not exists public.map_space_members (
  id         uuid primary key default gen_random_uuid(),
  space_id   uuid not null references public.map_spaces(id) on delete cascade,
  user_id    uuid not null references public.users(id) on delete cascade,
  role       map_space_role not null default 'member',
  joined_at  timestamptz not null default now(),
  unique (space_id, user_id)
);

create index if not exists map_space_members_user_idx on public.map_space_members (user_id);
create index if not exists map_space_members_space_idx on public.map_space_members (space_id);

-- --- pins now belong to a space ----------------------------------------------
-- The table is empty, so the column can be added NOT NULL outright rather than
-- backfilled behind a default that would then have to be dropped.
alter table public.pins add column if not exists space_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'pins_space_id_fkey'
  ) then
    alter table public.pins
      add constraint pins_space_id_fkey
      foreign key (space_id) references public.map_spaces(id) on delete cascade;
  end if;
end $$;

alter table public.pins alter column space_id set not null;

create index if not exists pins_space_idx on public.pins (space_id, created_at desc);

-- =============================================================================
-- Helpers
-- =============================================================================
-- SECURITY DEFINER so that reading map_space_members from inside a pins policy
-- does not itself need a map_space_members policy to pass; that recursion is
-- how "permission denied" appears on a table whose policy looks correct.
-- search_path is pinned — a SECURITY DEFINER function without it can be
-- hijacked through a caller-controlled search_path.

create or replace function public.is_space_member(space uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.map_space_members m
     where m.space_id = space
       and m.user_id = (select auth.uid())
  );
$$;

/**
 * Ownership is map_spaces.created_by, not the member row's role.
 *
 * Deliberate: deriving it from the members table creates a bootstrap problem —
 * the owner must insert their own first membership row before any policy that
 * consults that table can say they are the owner. created_by exists from the
 * moment the space does. The `role` column is still stored and shown, it just
 * is not what authority is decided by.
 */
create or replace function public.is_space_owner(space uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.map_spaces s
     where s.id = space
       and s.created_by = (select auth.uid())
  );
$$;

-- `from public, anon, authenticated`, not `from public` alone.
--
-- This project has already been caught by the narrow form once: Supabase's
-- default privileges layer per-role grants on top of PostgreSQL's PUBLIC
-- grant, so revoking only from PUBLIC leaves anon and authenticated holding
-- their own grants and the revoke silently does nothing. Every other hardened
-- function here (0006, 0008, 0009, 0010) names all three for that reason.
revoke execute on function public.is_space_member(uuid) from public, anon, authenticated;
revoke execute on function public.is_space_owner(uuid) from public, anon, authenticated;
grant execute on function public.is_space_member(uuid) to authenticated;
grant execute on function public.is_space_owner(uuid) to authenticated;

-- =============================================================================
-- RLS
-- =============================================================================
alter table public.map_spaces        enable row level security;
alter table public.map_space_members enable row level security;

-- --- map_spaces --------------------------------------------------------------
drop policy if exists map_spaces_select_member on public.map_spaces;
create policy map_spaces_select_member on public.map_spaces
  for select to authenticated
  using (
    -- Own column: available on the new row during INSERT ... RETURNING, when
    -- no membership row exists yet.
    created_by = (select auth.uid())
    -- Different table, already committed.
    or public.is_space_member(id)
  );

drop policy if exists map_spaces_insert_own on public.map_spaces;
create policy map_spaces_insert_own on public.map_spaces
  for insert to authenticated
  with check (created_by = (select auth.uid()));

drop policy if exists map_spaces_update_owner on public.map_spaces;
create policy map_spaces_update_owner on public.map_spaces
  for update to authenticated
  using (created_by = (select auth.uid()))
  with check (created_by = (select auth.uid()));

drop policy if exists map_spaces_delete_owner on public.map_spaces;
create policy map_spaces_delete_owner on public.map_spaces
  for delete to authenticated
  using (created_by = (select auth.uid()));

-- --- map_space_members -------------------------------------------------------
drop policy if exists map_space_members_select on public.map_space_members;
create policy map_space_members_select on public.map_space_members
  for select to authenticated
  using (
    -- Own column first: lets the first member row see itself on RETURNING.
    user_id = (select auth.uid())
    or public.is_space_member(space_id)
  );

-- Only the owner adds people. The owner's own first row is covered by the same
-- check, because ownership comes from map_spaces.created_by rather than from a
-- membership row that does not exist yet.
drop policy if exists map_space_members_insert_owner on public.map_space_members;
create policy map_space_members_insert_owner on public.map_space_members
  for insert to authenticated
  with check (public.is_space_owner(space_id));

-- The owner removes anyone; a member removes only themselves, which is how
-- leaving works.
drop policy if exists map_space_members_delete on public.map_space_members;
create policy map_space_members_delete on public.map_space_members
  for delete to authenticated
  using (
    public.is_space_owner(space_id)
    or user_id = (select auth.uid())
  );

-- --- pins --------------------------------------------------------------------
drop policy if exists pins_select_visible on public.pins;
create policy pins_select_visible on public.pins
  for select to authenticated
  using (
    creator_id = (select auth.uid())
    or public.is_space_member(space_id)
  );

drop policy if exists pins_insert_own on public.pins;
create policy pins_insert_own on public.pins
  for insert to authenticated
  with check (
    creator_id = (select auth.uid())
    -- A pin can only be dropped into a space the author belongs to. Without
    -- this, anyone could write into any space by id.
    and public.is_space_member(space_id)
  );

drop policy if exists pins_update_own on public.pins;
create policy pins_update_own on public.pins
  for update to authenticated
  using (creator_id = (select auth.uid()))
  with check (creator_id = (select auth.uid()) and public.is_space_member(space_id));

-- A member removes their own pin; the space owner can remove any pin in it.
drop policy if exists pins_delete_own on public.pins;
create policy pins_delete_own on public.pins
  for delete to authenticated
  using (
    creator_id = (select auth.uid())
    or public.is_space_owner(space_id)
  );

-- --- pin_media ---------------------------------------------------------------
-- Visibility follows the pin's space; only the pin's author attaches media.
drop policy if exists pin_media_select_visible on public.pin_media;
create policy pin_media_select_visible on public.pin_media
  for select to authenticated
  using (
    exists (
      select 1 from public.pins p
       where p.id = pin_id
         and (p.creator_id = (select auth.uid()) or public.is_space_member(p.space_id))
    )
  );

drop policy if exists pin_media_write_own on public.pin_media;
create policy pin_media_write_own on public.pin_media
  for all to authenticated
  using (exists (select 1 from public.pins p where p.id = pin_id and p.creator_id = (select auth.uid())))
  with check (exists (select 1 from public.pins p where p.id = pin_id and p.creator_id = (select auth.uid())));


-- ==========================================================================
-- SOURCE: 0018_location_search_history.sql
-- ==========================================================================

-- =============================================================================
-- Location search history
-- =============================================================================
-- What a user picked from the geocoder, so the search box can offer their
-- recent places before they type anything.
--
-- ── DEDUPE ──────────────────────────────────────────────────────────────────
-- Searching "london" five times is one history entry with a fresh timestamp,
-- not five rows. Enforced by a unique index on (user_id, query_text) so the
-- client can upsert; doing it with a read-then-write would race with itself
-- across two tabs.
--
-- query_text is stored already normalised — trimmed and lower-cased by the
-- client — because the uniqueness has to be on the same value the lookup uses.
-- The display name comes back from the geocoder anyway, so nothing is lost.
--
-- ── PRIVATE, FULL STOP ──────────────────────────────────────────────────────
-- Where someone has searched is among the more revealing things this app
-- stores. There is no shared or public state: every policy is `user_id =
-- auth.uid()`, with no exception for followers, space members or anyone else.
--
-- Idempotent — safe to run repeatedly.
-- =============================================================================


create table if not exists public.location_search_history (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  -- Normalised: trimmed, lower-cased. Matches what the unique index dedupes on.
  query_text  text not null check (char_length(query_text) between 1 and 200),
  -- The place that was chosen, so a history row can recentre the map without
  -- going back to the geocoder.
  latitude    numeric(11, 8) not null check (latitude between -90 and 90),
  longitude   numeric(11, 8) not null check (longitude between -180 and 180),
  -- What to show in the list. Nominatim's display_name, kept as returned.
  label       text,
  searched_at timestamptz not null default now()
);

create unique index if not exists location_search_history_uniq
  on public.location_search_history (user_id, query_text);

-- The list is always "this user's, most recent first".
create index if not exists location_search_history_recent_idx
  on public.location_search_history (user_id, searched_at desc);

-- =============================================================================
-- RLS
-- =============================================================================
alter table public.location_search_history enable row level security;

-- Own column on every policy, so INSERT ... RETURNING — which PostgREST uses
-- for the upsert below — can see the row it just wrote. A policy that had to
-- re-query this table would deny its own insert; that trap has already cost
-- this project three migrations (0004, 0016, and the design of 0017).
drop policy if exists location_search_history_select_own on public.location_search_history;
create policy location_search_history_select_own on public.location_search_history
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists location_search_history_insert_own on public.location_search_history;
create policy location_search_history_insert_own on public.location_search_history
  for insert to authenticated
  with check (user_id = (select auth.uid()));

-- Needed as well as INSERT: an upsert that collides runs an UPDATE, and
-- without this policy the second search for the same place fails where the
-- first succeeded.
drop policy if exists location_search_history_update_own on public.location_search_history;
create policy location_search_history_update_own on public.location_search_history
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists location_search_history_delete_own on public.location_search_history;
create policy location_search_history_delete_own on public.location_search_history
  for delete to authenticated
  using (user_id = (select auth.uid()));


-- ==========================================================================
-- SOURCE: 0019_pins_membership_only.sql
-- ==========================================================================

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


-- ==========================================================================
-- SOURCE: 0020_pin_place_name.sql
-- ==========================================================================

-- =============================================================================
-- A pin gets a name of its own
-- =============================================================================
-- The detail view led with latitude and longitude, which is what the pin is
-- but not what it means. "Where we watched the fireworks" is the title; the
-- coordinates are a footnote.
--
-- `caption` already existed and stays as the note — a few words about the
-- memory. This adds `name`, the headline. Two fields rather than one because
-- they are read differently: the name is scanned in a list, the note is read
-- once the pin is open.
--
-- Nullable: pins created before this have no name, and the UI falls back to
-- the caption and then to a plain "Pin". Making it NOT NULL would need a
-- backfill of invented titles, which is worse than an honest absence.
--
-- Idempotent — safe to run repeatedly.
-- =============================================================================


alter table public.pins add column if not exists name text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'pins_name_length'
  ) then
    alter table public.pins
      add constraint pins_name_length
      check (name is null or char_length(trim(name)) between 1 and 80);
  end if;
end $$;

comment on column public.pins.name is
  'Short place name — the pin''s title, e.g. "Where we watched the fireworks". '
  'Null on pins created before 0020; the UI falls back to caption, then "Pin".';

comment on column public.pins.caption is
  'A few words about the memory. Shown under the name, above the media.';


-- ==========================================================================
-- SOURCE: 0021_pin_song_title.sql
-- ==========================================================================

-- Songs attached to a pin remember what they are.
--
-- pin_media stored youtube_video_id and nothing else, so the detail card had
-- no name to print and said "Attached song" for every track. The title was
-- never missing — the song picker has it, and the composer threw it away on
-- the way to the database.
--
-- Denormalised on purpose. The alternative is asking YouTube for the title
-- every time a pin is opened, which is a network round-trip per song on a
-- read path, and a track that is later deleted or made private would lose its
-- name retroactively. What was attached is a fact about the memory; it should
-- not change because something moved on YouTube.

alter table public.pin_media
  add column if not exists song_title  text,
  add column if not exists song_artist text;

-- Nullable, and no backfill. Every row written before this migration has no
-- title and there is nothing local to derive one from; the card falls back to
-- "Attached song" for those, and the app fills them in from YouTube's oEmbed
-- endpoint as they are opened. Making these NOT NULL would have meant
-- inventing titles for existing rows.
alter table public.pin_media drop constraint if exists pin_media_song_title_length;
alter table public.pin_media
  add constraint pin_media_song_title_length
  check (song_title is null or char_length(song_title) between 1 and 200);

alter table public.pin_media drop constraint if exists pin_media_song_artist_length;
alter table public.pin_media
  add constraint pin_media_song_artist_length
  check (song_artist is null or char_length(song_artist) between 1 and 200);

-- No RLS change: these are columns on a table whose policies already gate
-- access by space membership, and column-level grants are not in play here.


-- ==========================================================================
-- SOURCE: 0022_pin_song_start_time.sql
-- ==========================================================================

-- A song attached to a pin remembers where it should start.
--
-- The picker has offered a "Start at" slider since it was written, and the
-- profile theme song has always honoured it. The pin composer read the same
-- value off the same component and then dropped it: pin_media had no column
-- for it, so every attached song played from 0:00 and the detail card
-- hardcoded a start of 0 to match. Choosing the drop of a track and getting
-- its intro instead is the whole of the bug.
--
-- Same denormalising rationale as 0021: this is a fact about the memory, not
-- about the video, and it should not require a round-trip to render.

alter table public.pin_media
  add column if not exists song_start_time integer;

-- Nullable, no backfill. Rows written before this migration made no choice —
-- that is different from having chosen 0:00, though both play from the start.
-- Leaving them null keeps the distinction available and avoids claiming an
-- intent nobody expressed.
alter table public.pin_media drop constraint if exists pin_media_song_start_time_range;
alter table public.pin_media
  add constraint pin_media_song_start_time_range
  -- Upper bound is a sanity guard, not a product rule: 24h is longer than any
  -- track and still rejects a millisecond value pasted into a seconds column,
  -- which is the mistake actually worth catching.
  check (song_start_time is null or song_start_time between 0 and 86400);

-- No RLS change: pin_media's policies already gate access by space
-- membership, and this adds no new way to reach a row.

commit;
