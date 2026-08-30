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

begin;

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

commit;
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

begin;

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

commit;
