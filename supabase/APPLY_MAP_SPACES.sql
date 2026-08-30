-- =============================================================================
-- Map Spaces: persistent shared maps, replacing per-pin sharing
-- =============================================================================
-- A pin now belongs to a SPACE, and a space has members. Membership is the
-- whole visibility model: every member sees every pin in the space, and
-- everyone can keep adding to it over time. That replaces pin_shares, where a
-- pin was individually addressed to people and nothing accumulated.
--
-- ── SAFE TO DROP AND REBUILD ────────────────────────────────────────────────
-- Checked against the live project before writing this: pins, pin_media and
-- pin_shares all held 0 rows. The feature has never carried real data — its
-- insert path was broken until 0016 — so there is nothing to migrate and no
-- back-compat shim to keep.
--
-- ── INSERT ... RETURNING ────────────────────────────────────────────────────
-- Every SELECT policy below leads with a column of the row itself. Postgres
-- evaluates the SELECT policy against the new row whenever a statement uses
-- RETURNING, and PostgREST always uses RETURNING when the client calls
-- .select() after .insert(). A policy that re-queries its own table through a
-- STABLE function cannot see that row and denies it — which is what 0004 fixed
-- for conversations and 0016 for pins. Two rows here would hit it otherwise:
--
--   map_spaces        the creator has no membership row yet at RETURNING time
--   map_space_members the first member row cannot see itself
--
-- Both lead with created_by / user_id for exactly that reason.
--
-- Idempotent — safe to run repeatedly.
-- =============================================================================

begin;

-- --- retire the individual-sharing model -------------------------------------
-- pin_shares is gone; membership answers what it used to. can_view_pin() goes
-- with it — its whole body was a share lookup.
--
-- ORDER MATTERS HERE. A function cannot be dropped while a policy still
-- references it:
--
--   ERROR 2BP01: cannot drop function can_view_pin(uuid) because other objects
--   depend on it — policy pins_select_visible, policy pin_media_select_visible
--
-- Both are recreated further down against is_space_member(), so dropping them
-- up front costs nothing. DROP ... CASCADE would also clear the error, but it
-- would remove whatever else happened to depend on the function without
-- saying so; naming them keeps that explicit.
drop policy if exists pins_select_visible on public.pins;
drop policy if exists pin_media_select_visible on public.pin_media;

-- Dropping the table takes its own policies with it. Dropping them by name
-- first would break re-runs: `drop policy if exists … on public.pin_shares`
-- raises "relation does not exist" once the table is gone, and IF EXISTS on
-- the policy does not cover a missing table.
drop table if exists public.pin_shares;

drop function if exists public.can_view_pin(uuid);

-- --- roles -------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'map_space_role') then
    create type map_space_role as enum ('owner', 'member');
  end if;
end $$;

-- --- map_spaces --------------------------------------------------------------
create table if not exists public.map_spaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(trim(name)) between 1 and 80),
  created_by  uuid not null references public.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

create index if not exists map_spaces_creator_idx on public.map_spaces (created_by);

-- --- map_space_members -------------------------------------------------------
create table if not exists public.map_space_members (
  id         uuid primary key default gen_random_uuid(),
  space_id   uuid not null references public.map_spaces(id) on delete cascade,
  user_id    uuid not null references public.users(id) on delete cascade,
  role       map_space_role not null default 'member',
  joined_at  timestamptz not null default now(),
  unique (space_id, user_id)
);

create index if not exists map_space_members_user_idx on public.map_space_members (user_id);
create index if not exists map_space_members_space_idx on public.map_space_members (space_id);

-- --- pins now belong to a space ----------------------------------------------
-- The table is empty, so the column can be added NOT NULL outright rather than
-- backfilled behind a default that would then have to be dropped.
alter table public.pins add column if not exists space_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'pins_space_id_fkey'
  ) then
    alter table public.pins
      add constraint pins_space_id_fkey
      foreign key (space_id) references public.map_spaces(id) on delete cascade;
  end if;
end $$;

alter table public.pins alter column space_id set not null;

create index if not exists pins_space_idx on public.pins (space_id, created_at desc);

-- =============================================================================
-- Helpers
-- =============================================================================
-- SECURITY DEFINER so that reading map_space_members from inside a pins policy
-- does not itself need a map_space_members policy to pass; that recursion is
-- how "permission denied" appears on a table whose policy looks correct.
-- search_path is pinned — a SECURITY DEFINER function without it can be
-- hijacked through a caller-controlled search_path.

create or replace function public.is_space_member(space uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.map_space_members m
     where m.space_id = space
       and m.user_id = (select auth.uid())
  );
$$;

/**
 * Ownership is map_spaces.created_by, not the member row's role.
 *
 * Deliberate: deriving it from the members table creates a bootstrap problem —
 * the owner must insert their own first membership row before any policy that
 * consults that table can say they are the owner. created_by exists from the
 * moment the space does. The `role` column is still stored and shown, it just
 * is not what authority is decided by.
 */
create or replace function public.is_space_owner(space uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.map_spaces s
     where s.id = space
       and s.created_by = (select auth.uid())
  );
$$;

-- `from public, anon, authenticated`, not `from public` alone.
--
-- This project has already been caught by the narrow form once: Supabase's
-- default privileges layer per-role grants on top of PostgreSQL's PUBLIC
-- grant, so revoking only from PUBLIC leaves anon and authenticated holding
-- their own grants and the revoke silently does nothing. Every other hardened
-- function here (0006, 0008, 0009, 0010) names all three for that reason.
revoke execute on function public.is_space_member(uuid) from public, anon, authenticated;
revoke execute on function public.is_space_owner(uuid) from public, anon, authenticated;
grant execute on function public.is_space_member(uuid) to authenticated;
grant execute on function public.is_space_owner(uuid) to authenticated;

-- =============================================================================
-- RLS
-- =============================================================================
alter table public.map_spaces        enable row level security;
alter table public.map_space_members enable row level security;

-- --- map_spaces --------------------------------------------------------------
drop policy if exists map_spaces_select_member on public.map_spaces;
create policy map_spaces_select_member on public.map_spaces
  for select to authenticated
  using (
    -- Own column: available on the new row during INSERT ... RETURNING, when
    -- no membership row exists yet.
    created_by = (select auth.uid())
    -- Different table, already committed.
    or public.is_space_member(id)
  );

drop policy if exists map_spaces_insert_own on public.map_spaces;
create policy map_spaces_insert_own on public.map_spaces
  for insert to authenticated
  with check (created_by = (select auth.uid()));

drop policy if exists map_spaces_update_owner on public.map_spaces;
create policy map_spaces_update_owner on public.map_spaces
  for update to authenticated
  using (created_by = (select auth.uid()))
  with check (created_by = (select auth.uid()));

drop policy if exists map_spaces_delete_owner on public.map_spaces;
create policy map_spaces_delete_owner on public.map_spaces
  for delete to authenticated
  using (created_by = (select auth.uid()));

-- --- map_space_members -------------------------------------------------------
drop policy if exists map_space_members_select on public.map_space_members;
create policy map_space_members_select on public.map_space_members
  for select to authenticated
  using (
    -- Own column first: lets the first member row see itself on RETURNING.
    user_id = (select auth.uid())
    or public.is_space_member(space_id)
  );

-- Only the owner adds people. The owner's own first row is covered by the same
-- check, because ownership comes from map_spaces.created_by rather than from a
-- membership row that does not exist yet.
drop policy if exists map_space_members_insert_owner on public.map_space_members;
create policy map_space_members_insert_owner on public.map_space_members
  for insert to authenticated
  with check (public.is_space_owner(space_id));

-- The owner removes anyone; a member removes only themselves, which is how
-- leaving works.
drop policy if exists map_space_members_delete on public.map_space_members;
create policy map_space_members_delete on public.map_space_members
  for delete to authenticated
  using (
    public.is_space_owner(space_id)
    or user_id = (select auth.uid())
  );

-- --- pins --------------------------------------------------------------------
drop policy if exists pins_select_visible on public.pins;
create policy pins_select_visible on public.pins
  for select to authenticated
  using (
    creator_id = (select auth.uid())
    or public.is_space_member(space_id)
  );

drop policy if exists pins_insert_own on public.pins;
create policy pins_insert_own on public.pins
  for insert to authenticated
  with check (
    creator_id = (select auth.uid())
    -- A pin can only be dropped into a space the author belongs to. Without
    -- this, anyone could write into any space by id.
    and public.is_space_member(space_id)
  );

drop policy if exists pins_update_own on public.pins;
create policy pins_update_own on public.pins
  for update to authenticated
  using (creator_id = (select auth.uid()))
  with check (creator_id = (select auth.uid()) and public.is_space_member(space_id));

-- A member removes their own pin; the space owner can remove any pin in it.
drop policy if exists pins_delete_own on public.pins;
create policy pins_delete_own on public.pins
  for delete to authenticated
  using (
    creator_id = (select auth.uid())
    or public.is_space_owner(space_id)
  );

-- --- pin_media ---------------------------------------------------------------
-- Visibility follows the pin's space; only the pin's author attaches media.
drop policy if exists pin_media_select_visible on public.pin_media;
create policy pin_media_select_visible on public.pin_media
  for select to authenticated
  using (
    exists (
      select 1 from public.pins p
       where p.id = pin_id
         and (p.creator_id = (select auth.uid()) or public.is_space_member(p.space_id))
    )
  );

drop policy if exists pin_media_write_own on public.pin_media;
create policy pin_media_write_own on public.pin_media
  for all to authenticated
  using (exists (select 1 from public.pins p where p.id = pin_id and p.creator_id = (select auth.uid())))
  with check (exists (select 1 from public.pins p where p.id = pin_id and p.creator_id = (select auth.uid())));

commit;
