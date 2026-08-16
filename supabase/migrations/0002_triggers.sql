-- =============================================================================
-- Derived state — maintained by the database, not the client
-- =============================================================================
-- Firestore incremented likes_count / commentsCount from the browser with a
-- second write after the like itself. Any failure between the two left the
-- counter permanently wrong, and there was no way to detect the drift. These
-- triggers make the counter a consequence of the row existing, inside the same
-- transaction, so it cannot disagree with reality.
-- =============================================================================

-- --- Post counters -----------------------------------------------------------

create or replace function bump_post_likes_count()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update posts set likes_count = likes_count + 1 where id = new.post_id;
  elsif tg_op = 'DELETE' then
    update posts set likes_count = greatest(likes_count - 1, 0) where id = old.post_id;
  end if;
  return null;
end;
$$;

create trigger likes_count_sync
  after insert or delete on likes
  for each row execute function bump_post_likes_count();

create or replace function bump_post_comments_count()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update posts set comments_count = comments_count + 1 where id = new.post_id;
  elsif tg_op = 'DELETE' then
    update posts set comments_count = greatest(comments_count - 1, 0) where id = old.post_id;
  end if;
  return null;
end;
$$;

create trigger comments_count_sync
  after insert or delete on comments
  for each row execute function bump_post_comments_count();

-- --- Conversation ordering ---------------------------------------------------
-- The inbox sorts by conversations.updated_at. Firestore required the sender to
-- write chats/{id}.lastMessage and updatedAt as a separate operation, which
-- could fail independently and leave a conversation stuck at the wrong
-- position with a stale preview.

create or replace function touch_conversation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update conversations set updated_at = new.created_at where id = new.conversation_id;
  return null;
end;
$$;

create trigger messages_touch_conversation
  after insert on messages
  for each row execute function touch_conversation();

-- --- Delivery receipts -------------------------------------------------------
-- Creates a pending receipt row for every member except the sender the moment a
-- message is inserted. `delivered_at` is set when the recipient's client
-- acknowledges; until then the row exists with read_at null, which is what the
-- unread count reads.

create or replace function fan_out_message_receipts()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into message_receipts (message_id, user_id, delivered_at, read_at)
  select new.id, cm.user_id, null, null
  from conversation_members cm
  where cm.conversation_id = new.conversation_id
    and (new.sender_id is null or cm.user_id <> new.sender_id)
  on conflict do nothing;
  return null;
end;
$$;

create trigger messages_fan_out_receipts
  after insert on messages
  for each row execute function fan_out_message_receipts();

-- delivered_at must be nullable for the pending state above.
alter table message_receipts alter column delivered_at drop not null;
alter table message_receipts alter column delivered_at drop default;

-- --- Direct-conversation uniqueness -----------------------------------------
-- Firestore had no way to prevent two people simultaneously creating a direct
-- chat with each other, producing duplicate threads. This enforces one direct
-- conversation per unordered pair.

create or replace function direct_conversation_key(conv_id uuid)
returns text language sql stable as $$
  select string_agg(user_id::text, ':' order by user_id)
  from conversation_members where conversation_id = conv_id;
$$;

create table direct_conversation_keys (
  conversation_id uuid primary key references conversations(id) on delete cascade,
  pair_key        text not null unique
);

create or replace function register_direct_conversation()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  conv_type conversation_type;
  member_count int;
begin
  select type into conv_type from conversations where id = new.conversation_id;
  if conv_type <> 'direct' then return null; end if;

  select count(*) into member_count
  from conversation_members where conversation_id = new.conversation_id;

  -- Only register once both participants are present.
  if member_count = 2 then
    insert into direct_conversation_keys (conversation_id, pair_key)
    values (new.conversation_id, direct_conversation_key(new.conversation_id))
    on conflict (conversation_id) do update set pair_key = excluded.pair_key;
  end if;
  return null;
end;
$$;

create trigger conversation_members_register_direct
  after insert on conversation_members
  for each row execute function register_direct_conversation();

-- --- Backfill helper ---------------------------------------------------------
-- Recomputes every denormalised counter from source rows. Run after the
-- migration import, and any time you suspect drift. Safe to run repeatedly.

create or replace function recompute_counters()
returns table (posts_fixed bigint) language plpgsql as $$
begin
  return query
  with updated as (
    update posts p set
      likes_count = coalesce(l.n, 0),
      comments_count = coalesce(c.n, 0)
    from (select id from posts) ids
    left join (select post_id, count(*) n from likes group by post_id) l
      on l.post_id = ids.id
    left join (select post_id, count(*) n from comments group by post_id) c
      on c.post_id = ids.id
    where p.id = ids.id
      and (p.likes_count <> coalesce(l.n, 0) or p.comments_count <> coalesce(c.n, 0))
    returning 1
  )
  select count(*) from updated;
end;
$$;
