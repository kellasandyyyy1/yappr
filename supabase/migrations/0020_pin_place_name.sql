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

begin;

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

commit;
