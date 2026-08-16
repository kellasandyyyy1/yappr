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
