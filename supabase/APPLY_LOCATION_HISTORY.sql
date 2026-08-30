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

begin;

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

commit;
