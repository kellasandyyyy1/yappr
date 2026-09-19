-- =============================================================================
-- Shared Notes & Reminders
-- =============================================================================
-- A note belongs to a NOTE SPACE, and a note space has members. Membership is
-- the whole visibility model, exactly as it is for map spaces (0017) — but the
-- two are independent: separate tables, separate helpers, separate invites. A
-- map space grants nothing here and this grants nothing there.
--
-- ── WHAT IS GENUINELY NEW HERE ──────────────────────────────────────────────
-- The invite-accept flow. Nothing in this app had one before: map spaces add
-- members outright (CreateSpaceModal documents that choice), and so do group
-- chats. So `status` is not a pattern being reused, it is the first of its
-- kind, and the policies below are written on the assumption that a 'pending'
-- row is worth exactly nothing until its owner accepts it.
--
-- ── WHAT A PENDING MEMBER CAN SEE ───────────────────────────────────────────
-- Their own membership row, and the SPACE ROW ITSELF — nothing more. No notes,
-- no roster, no other members. The space row is readable because an invitation
-- you cannot read is not an invitation: the hub lists pending invites by name,
-- and that name is the only content the row carries. Notes remain strictly
-- accepted-only, which is the part the invite is actually gating.
--
-- ── INSERT ... RETURNING ────────────────────────────────────────────────────
-- Every SELECT policy leads with a column of the row itself, for the reason
-- 0004 (conversations), 0016 (pins) and 0017 (map spaces) each had to be
-- written: Postgres evaluates the SELECT policy against the new row when a
-- statement uses RETURNING, PostgREST always uses RETURNING after .select(),
-- and a policy that re-queries its own table through a STABLE function cannot
-- see the row being inserted. Three rows here would hit it otherwise:
--
--   note_spaces         the creator has no membership row yet
--   note_space_members  the first member row cannot see itself
--   notes               author_id is on the candidate row; the space is not
--
-- ── ENUM VALUES AND THE SINGLE-TRANSACTION BUNDLE ───────────────────────────
-- `alter type ... add value` is allowed inside a transaction on PG12+, but the
-- new value CANNOT BE EVALUATED until that transaction commits. ALL_MIGRATIONS
-- .sql is one transaction, so nothing below may use 'note_invite' or
-- 'note_reminder' as a literal — no default, no check constraint, no policy
-- expression. They are written only by the client and the cron route, long
-- after commit. 0013 added 'video' the same way.
--
-- Idempotent — safe to run repeatedly.
-- =============================================================================

begin;

-- --- enums -------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'note_space_role') then
    create type note_space_role as enum ('owner', 'member');
  end if;
  if not exists (select 1 from pg_type where typname = 'note_member_status') then
    create type note_member_status as enum ('pending', 'accepted');
  end if;
end $$;

alter type notification_type add value if not exists 'note_invite';
alter type notification_type add value if not exists 'note_reminder';

-- --- note_spaces -------------------------------------------------------------
create table if not exists public.note_spaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(trim(name)) between 1 and 80),
  created_by  uuid not null references public.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

create index if not exists note_spaces_creator_idx on public.note_spaces (created_by);

-- --- note_space_members ------------------------------------------------------
create table if not exists public.note_space_members (
  id         uuid primary key default gen_random_uuid(),
  space_id   uuid not null references public.note_spaces(id) on delete cascade,
  user_id    uuid not null references public.users(id) on delete cascade,
  status     note_member_status not null default 'pending',
  role       note_space_role not null default 'member',
  joined_at  timestamptz not null default now(),
  unique (space_id, user_id)
);

create index if not exists note_space_members_user_idx on public.note_space_members (user_id, status);
create index if not exists note_space_members_space_idx on public.note_space_members (space_id, status);

-- --- notes -------------------------------------------------------------------
-- due_date is the whole distinction between the two things this table holds:
-- null is a plain note, set is a reminder. One table rather than two because
-- they are composed in the same box, listed together, and a note becomes a
-- reminder by gaining a date — which is an UPDATE, not a migration between
-- tables.
create table if not exists public.notes (
  id          uuid primary key default gen_random_uuid(),
  space_id    uuid not null references public.note_spaces(id) on delete cascade,
  author_id   uuid not null references public.users(id) on delete cascade,
  content     text not null check (char_length(trim(content)) between 1 and 2000),
  due_date    timestamptz,
  completed   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.users(id) on delete set null,
  -- Set when the due-reminder sweep has notified the space, so it fires once
  -- and not every minute afterwards. Cleared if the due date moves.
  notified_at timestamptz
);

create index if not exists notes_space_idx on public.notes (space_id, created_at desc);

-- The cron sweep's exact predicate. Partial, so the index holds only the few
-- rows that could ever be due rather than every note ever written.
create index if not exists notes_due_idx on public.notes (due_date)
  where due_date is not null and completed = false and notified_at is null;

-- --- notifications gain two references ---------------------------------------
alter table public.notifications
  add column if not exists note_space_id uuid references public.note_spaces(id) on delete cascade;
alter table public.notifications
  add column if not exists note_id uuid references public.notes(id) on delete cascade;

-- =============================================================================
-- Helpers
-- =============================================================================
-- Duplicated rather than generalised. is_space_member(uuid) could have taken a
-- table name, but that turns a STABLE lookup into dynamic SQL inside a
-- SECURITY DEFINER function — a string-built query running with the definer's
-- rights, driven by an argument that appears in policy expressions. The two
-- bodies differ by one table name and one status check; sharing them is not
-- worth introducing an injection surface into the authorisation layer.
--
-- SECURITY DEFINER so that reading note_space_members from inside the notes
-- policy does not itself need a note_space_members policy to pass; that
-- recursion is how "permission denied" appears on a table whose policy looks
-- correct. search_path is pinned — a SECURITY DEFINER function without it can
-- be hijacked through a caller-controlled search_path.

-- Accepted members only. This is the function the notes policies hang on, and
-- the single place the pending/accepted distinction is enforced.
create or replace function public.is_note_space_member(space uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.note_space_members m
     where m.space_id = space
       and m.user_id = (select auth.uid())
       and m.status = 'accepted'
  );
$$;

-- Someone who has been invited and has not answered yet. Used ONLY to let an
-- invitee read the name of the space they are being invited to.
create or replace function public.is_note_space_invited(space uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.note_space_members m
     where m.space_id = space
       and m.user_id = (select auth.uid())
       and m.status = 'pending'
  );
$$;

-- Ownership is note_spaces.created_by, not the member row's role — the same
-- call 0017 made, for the same bootstrap reason: the owner must insert their
-- own first membership row before any policy that consults that table could
-- say they are the owner, and created_by exists from the moment the space
-- does.
--
-- It also makes `role` cosmetic, which is what makes the members UPDATE policy
-- below safe: a member who forged role = 'owner' on their own row would gain
-- exactly nothing.
create or replace function public.is_note_space_owner(space uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.note_spaces s
     where s.id = space
       and s.created_by = (select auth.uid())
  );
$$;

-- `from public, anon, authenticated`, not `from public` alone: Supabase layers
-- per-role grants on top of PostgreSQL's PUBLIC grant, so revoking only from
-- PUBLIC leaves anon and authenticated holding theirs and the revoke silently
-- does nothing. Every hardened function in this project names all three.
revoke execute on function public.is_note_space_member(uuid)  from public, anon, authenticated;
revoke execute on function public.is_note_space_invited(uuid) from public, anon, authenticated;
revoke execute on function public.is_note_space_owner(uuid)   from public, anon, authenticated;
grant  execute on function public.is_note_space_member(uuid)  to authenticated;
grant  execute on function public.is_note_space_invited(uuid) to authenticated;
grant  execute on function public.is_note_space_owner(uuid)   to authenticated;

-- =============================================================================
-- Immutability + stamping trigger on notes
-- =============================================================================
-- Any accepted member may edit any note in the space — that is the point of a
-- shared list, and completing someone else's reminder has to work. But four
-- columns must not be client-writable on an UPDATE:
--
--   author_id   or an editor could reassign authorship to someone else
--   space_id    or a note could be moved into another space by id
--   created_at  or the "added Xs ago" line could be rewritten
--   updated_by  or an edit could be attributed to another member
--
-- RLS cannot express "unchanged" — a policy sees only the new row, never OLD —
-- so this is a trigger rather than a WITH CHECK. It also takes updated_at and
-- updated_by out of the client's hands entirely: notes.ts never sends them.
create or replace function public.stamp_note_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.author_id  := old.author_id;
  new.space_id   := old.space_id;
  new.created_at := old.created_at;
  new.updated_at := now();
  new.updated_by := (select auth.uid());

  -- Moving a reminder's due date re-arms the sweep: the old notification was
  -- about a time that is no longer the time. Completing it does not clear the
  -- stamp, so a reminder that already fired stays quiet.
  if new.due_date is distinct from old.due_date then
    new.notified_at := null;
  end if;

  return new;
end;
$$;

drop trigger if exists notes_stamp_update on public.notes;
create trigger notes_stamp_update
  before update on public.notes
  for each row execute function public.stamp_note_update();

-- =============================================================================
-- RLS
-- =============================================================================
alter table public.note_spaces        enable row level security;
alter table public.note_space_members enable row level security;
alter table public.notes              enable row level security;

-- --- note_spaces --------------------------------------------------------------
drop policy if exists note_spaces_select_member on public.note_spaces;
create policy note_spaces_select_member on public.note_spaces
  for select to authenticated
  using (
    -- Own column: available on the new row during INSERT ... RETURNING, when
    -- no membership row exists yet.
    created_by = (select auth.uid())
    or public.is_note_space_member(id)
    -- The name, so an invitation can be shown. Deliberate, and documented at
    -- the top of this file.
    or public.is_note_space_invited(id)
  );

drop policy if exists note_spaces_insert_own on public.note_spaces;
create policy note_spaces_insert_own on public.note_spaces
  for insert to authenticated
  with check (created_by = (select auth.uid()));

drop policy if exists note_spaces_update_owner on public.note_spaces;
create policy note_spaces_update_owner on public.note_spaces
  for update to authenticated
  using (created_by = (select auth.uid()))
  with check (created_by = (select auth.uid()));

drop policy if exists note_spaces_delete_owner on public.note_spaces;
create policy note_spaces_delete_owner on public.note_spaces
  for delete to authenticated
  using (created_by = (select auth.uid()));

-- --- note_space_members -------------------------------------------------------
drop policy if exists note_space_members_select on public.note_space_members;
create policy note_space_members_select on public.note_space_members
  for select to authenticated
  using (
    -- Own column first: lets the first member row see itself on RETURNING, and
    -- lets an invitee read the single row that is their invitation.
    user_id = (select auth.uid())
    -- The roster, for accepted members only. A pending invitee does not learn
    -- who else is in the space before joining it.
    or public.is_note_space_member(space_id)
  );

-- Only the owner invites. The owner's own first row is covered by the same
-- check, because ownership comes from note_spaces.created_by rather than from
-- a membership row that does not exist yet.
drop policy if exists note_space_members_insert_owner on public.note_space_members;
create policy note_space_members_insert_owner on public.note_space_members
  for insert to authenticated
  with check (public.is_note_space_owner(space_id));

-- Accepting an invitation: the invitee flips their OWN row to 'accepted'.
--
-- The role clause is what stops that being an escalation: a non-owner can only
-- ever write role = 'member'. It is belt and braces — authority comes from
-- created_by, so a forged 'owner' role grants nothing — but a members table
-- where anyone can label themselves owner is a trap for the next policy
-- someone writes against it.
drop policy if exists note_space_members_update_self on public.note_space_members;
create policy note_space_members_update_self on public.note_space_members
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and (role = 'member' or public.is_note_space_owner(space_id))
  );

-- The owner removes anyone; a member removes only themselves. That one policy
-- covers three UI actions: declining an invite, leaving a space, and the owner
-- uninviting someone.
drop policy if exists note_space_members_delete on public.note_space_members;
create policy note_space_members_delete on public.note_space_members
  for delete to authenticated
  using (
    public.is_note_space_owner(space_id)
    or user_id = (select auth.uid())
  );

-- --- notes --------------------------------------------------------------------
-- Every branch below goes through is_note_space_member(), which is accepted-
-- only. This is where "a pending row grants no access" is actually enforced.
drop policy if exists notes_select_member on public.notes;
create policy notes_select_member on public.notes
  for select to authenticated
  using (
    -- Own column: the author reading back their own INSERT ... RETURNING.
    author_id = (select auth.uid())
    or public.is_note_space_member(space_id)
  );

drop policy if exists notes_insert_member on public.notes;
create policy notes_insert_member on public.notes
  for insert to authenticated
  with check (
    author_id = (select auth.uid())
    -- A note can only be written into a space the author has accepted. Without
    -- this, anyone could write into any space by id.
    and public.is_note_space_member(space_id)
  );

-- Any accepted member may edit or complete any note in the space. The trigger
-- above freezes authorship and stamps the editor, so "who changed this" stays
-- truthful even though "who may change it" is broad.
drop policy if exists notes_update_member on public.notes;
create policy notes_update_member on public.notes
  for update to authenticated
  using (public.is_note_space_member(space_id))
  with check (public.is_note_space_member(space_id));

-- A member deletes their own note; the space owner can delete any.
drop policy if exists notes_delete_own on public.notes;
create policy notes_delete_own on public.notes
  for delete to authenticated
  using (
    author_id = (select auth.uid())
    or public.is_note_space_owner(space_id)
  );

-- =============================================================================
-- Realtime
-- =============================================================================
-- Without this the subscriptions in src/lib/notes.ts would reach SUBSCRIBED
-- and then receive nothing forever — the failure 0011 was written to fix for
-- every other table. RLS still applies: Realtime evaluates the same policies
-- per subscriber, so publishing these does not widen who sees what.
do $$
declare t text;
begin
  foreach t in array array['notes', 'note_space_members']
  loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;

-- Postgres logs only the primary key of a deleted row by default, so a DELETE
-- arrives with every other column stripped. Both subscriptions here filter on
-- space_id, which is not the key — so without FULL, a deleted note would stay
-- on every other member's screen until a manual refresh.
alter table public.notes              replica identity full;
alter table public.note_space_members replica identity full;

commit;
