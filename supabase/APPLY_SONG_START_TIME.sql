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
