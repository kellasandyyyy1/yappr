-- =============================================================================
-- Note spaces get a category
-- =============================================================================
-- A shared list is not a generic thing. "Recipes to try", "Naples in June" and
-- "Gift ideas" want different words, a different icon, and — for some of them —
-- a different interaction. The category is what carries that.
--
-- ── WHY THE LIST STYLE IS NOT A COLUMN ──────────────────────────────────────
-- Checklist-vs-plain is a pure function of the category:
--
--   checklist   cooking, trip, movies
--   plain       date_ideas, gifts, bucket_list, general
--
-- Storing it as well would create two sources of truth that can disagree, and
-- the first bug would be a space whose category says Cooking and whose style
-- says plain. It is derived in the client (listStyleFor in src/lib/notes.ts),
-- which is the only place that needs it. Nothing in the database branches on
-- it: `completed` already exists on every note, and RLS does not care why a
-- row is tickable.
--
-- ── WHY THIS NEEDS NO BACKFILL ──────────────────────────────────────────────
-- The column is NOT NULL with a default, so every existing row is 'general' as
-- the ALTER runs — which is the honest answer for a space created before
-- categories existed. No data migration, and no nullable-forever column that
-- every read has to coalesce.
--
-- ── ENUM LITERALS IN THIS TRANSACTION ───────────────────────────────────────
-- Unlike 0025, this one CAN use its own values immediately. The restriction is
-- on ALTER TYPE ... ADD VALUE against a pre-existing type; a type CREATEd in
-- the same transaction may be used in that transaction, which is what lets the
-- column default be written here rather than in a follow-up.
--
-- Idempotent — safe to run repeatedly.
-- =============================================================================

begin;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'note_space_category') then
    create type note_space_category as enum (
      'cooking', 'trip', 'date_ideas', 'movies', 'gifts', 'bucket_list', 'general'
    );
  end if;
end $$;

alter table public.note_spaces
  add column if not exists category note_space_category not null default 'general';

comment on column public.note_spaces.category is
  'What the space is for. Drives its icon, its tint and its wording, and — via '
  'listStyleFor() in src/lib/notes.ts — whether entries are tickable. '
  'Spaces created before 0027 are ''general'', which is accurate rather than a '
  'placeholder.';

commit;
