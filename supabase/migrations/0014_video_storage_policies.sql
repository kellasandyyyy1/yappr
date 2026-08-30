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
