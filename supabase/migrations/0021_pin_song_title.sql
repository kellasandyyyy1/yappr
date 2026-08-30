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
