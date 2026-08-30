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
