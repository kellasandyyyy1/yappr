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

begin;

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

commit;
