-- =============================================================================
-- Memory Pins: a map location carrying media, shared with people or groups
-- =============================================================================
-- Three tables:
--
--   pins         the location and its caption
--   pin_media    photos / videos / songs attached to a pin, ordered
--   pin_shares   who a pin is shared with — a person OR a conversation
--
-- ── PINS ARE PRIVATE BY DEFAULT ──────────────────────────────────────────────
-- Unlike posts, which have a public/followers/private visibility column, a pin
-- is visible to its creator and to nobody else until it is explicitly shared.
-- There is no "public" state at all. That is why the SELECT policy is a
-- whitelist (creator OR an explicit share) rather than a filter over a
-- visibility enum: a bug in a filter shows too much, a bug in a whitelist shows
-- too little.
--
-- ── WHY pin_shares HAS TWO NULLABLE TARGETS ─────────────────────────────────
-- A share points at exactly one of a user or a conversation, enforced by a
-- check constraint rather than by convention. Two columns with a constraint
-- beats a (target_type, target_id) pair because the foreign keys stay real:
-- deleting a user or a conversation takes its shares with it.
--
-- Idempotent — safe to run repeatedly.
-- =============================================================================

begin;

-- --- media kinds -------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'pin_media_type') then
    create type pin_media_type as enum ('photo', 'video', 'song');
  end if;
end $$;

-- --- pins --------------------------------------------------------------------
create table if not exists public.pins (
  id          uuid primary key default gen_random_uuid(),
  creator_id  uuid not null references public.users(id) on delete cascade,
  -- numeric, not float: a pin is a place, and binary floating point should not
  -- quietly move it. 9 significant digits is ~0.1mm at the equator.
  latitude    numeric(11, 8) not null check (latitude between -90 and 90),
  longitude   numeric(11, 8) not null check (longitude between -180 and 180),
  caption     text check (caption is null or char_length(caption) <= 500),
  created_at  timestamptz not null default now()
);

create index if not exists pins_creator_idx on public.pins (creator_id, created_at desc);

-- --- pin_media ---------------------------------------------------------------
create table if not exists public.pin_media (
  id                uuid primary key default gen_random_uuid(),
  pin_id            uuid not null references public.pins(id) on delete cascade,
  media_type        pin_media_type not null,
  -- Storage URL for a photo or video; null for a song.
  media_url         text,
  -- YouTube id for a song; null otherwise. Reuses the existing player.
  youtube_video_id  text,
  poster_url        text,
  order_index       int not null default 0,
  created_at        timestamptz not null default now(),

  -- A song needs a youtube id and a photo/video needs a url. Without this a row
  -- can exist that renders as nothing at all.
  constraint pin_media_has_a_source check (
    (media_type = 'song' and youtube_video_id is not null)
    or (media_type in ('photo', 'video') and media_url is not null)
  )
);

create index if not exists pin_media_pin_idx on public.pin_media (pin_id, order_index);

-- --- pin_shares --------------------------------------------------------------
create table if not exists public.pin_shares (
  id                  uuid primary key default gen_random_uuid(),
  pin_id              uuid not null references public.pins(id) on delete cascade,
  shared_with_user_id uuid references public.users(id) on delete cascade,
  conversation_id     uuid references public.conversations(id) on delete cascade,
  created_at          timestamptz not null default now(),

  -- Exactly one target. Neither would be a share with nobody; both would make
  -- "who is this shared with" ambiguous.
  constraint pin_shares_one_target check (
    (shared_with_user_id is not null and conversation_id is null)
    or (shared_with_user_id is null and conversation_id is not null)
  )
);

-- Sharing the same pin with the same target twice is a no-op, not a new row.
create unique index if not exists pin_shares_user_uniq
  on public.pin_shares (pin_id, shared_with_user_id)
  where shared_with_user_id is not null;
create unique index if not exists pin_shares_conversation_uniq
  on public.pin_shares (pin_id, conversation_id)
  where conversation_id is not null;

create index if not exists pin_shares_user_idx on public.pin_shares (shared_with_user_id);
create index if not exists pin_shares_conversation_idx on public.pin_shares (conversation_id);

-- =============================================================================
-- RLS
-- =============================================================================
alter table public.pins       enable row level security;
alter table public.pin_media  enable row level security;
alter table public.pin_shares enable row level security;

/**
 * Can the caller see this pin?
 *
 * SECURITY DEFINER so that reading pin_shares from inside a pins policy does
 * not itself require a pin_shares policy to pass — that recursion is how
 * "permission denied" appears on a table whose policy looks correct.
 *
 * search_path is pinned: a SECURITY DEFINER function without it can be
 * hijacked by a caller-controlled search_path.
 */
create or replace function public.can_view_pin(pin uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.pins p
     where p.id = pin
       and p.creator_id = (select auth.uid())
  )
  or exists (
    select 1 from public.pin_shares s
     where s.pin_id = pin
       and (
         s.shared_with_user_id = (select auth.uid())
         or (s.conversation_id is not null and public.is_conversation_member(s.conversation_id))
       )
  );
$$;

revoke all on function public.can_view_pin(uuid) from public;
grant execute on function public.can_view_pin(uuid) to authenticated;

-- --- pins --------------------------------------------------------------------
drop policy if exists pins_select_visible on public.pins;
create policy pins_select_visible on public.pins
  for select to authenticated
  using (public.can_view_pin(id));

drop policy if exists pins_insert_own on public.pins;
create policy pins_insert_own on public.pins
  for insert to authenticated
  with check (creator_id = (select auth.uid()));

drop policy if exists pins_update_own on public.pins;
create policy pins_update_own on public.pins
  for update to authenticated
  using (creator_id = (select auth.uid()))
  with check (creator_id = (select auth.uid()));

drop policy if exists pins_delete_own on public.pins;
create policy pins_delete_own on public.pins
  for delete to authenticated
  using (creator_id = (select auth.uid()));

-- --- pin_media ---------------------------------------------------------------
-- Readable by anyone who can read the pin; writable only by its creator. A
-- recipient with write access could add media to someone else's memory.
drop policy if exists pin_media_select_visible on public.pin_media;
create policy pin_media_select_visible on public.pin_media
  for select to authenticated
  using (public.can_view_pin(pin_id));

drop policy if exists pin_media_write_own on public.pin_media;
create policy pin_media_write_own on public.pin_media
  for all to authenticated
  using (exists (select 1 from public.pins p where p.id = pin_id and p.creator_id = (select auth.uid())))
  with check (exists (select 1 from public.pins p where p.id = pin_id and p.creator_id = (select auth.uid())));

-- --- pin_shares --------------------------------------------------------------
-- The creator manages shares. A recipient may read the share rows for a pin
-- they can already see, so the UI can say who else it went to.
drop policy if exists pin_shares_select_visible on public.pin_shares;
create policy pin_shares_select_visible on public.pin_shares
  for select to authenticated
  using (public.can_view_pin(pin_id));

drop policy if exists pin_shares_write_own on public.pin_shares;
create policy pin_shares_write_own on public.pin_shares
  for all to authenticated
  using (exists (select 1 from public.pins p where p.id = pin_id and p.creator_id = (select auth.uid())))
  with check (
    exists (select 1 from public.pins p where p.id = pin_id and p.creator_id = (select auth.uid()))
    -- A pin may only be shared into a conversation the sharer is actually in.
    -- Without this, anyone could push a pin into any group by id.
    and (conversation_id is null or public.is_conversation_member(conversation_id))
  );

commit;
