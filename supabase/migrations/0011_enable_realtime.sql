-- =============================================================================
-- Publish the tables the app subscribes to
-- =============================================================================
-- The `supabase_realtime` publication was EMPTY. Every `postgres_changes`
-- subscription in src/lib/db.ts therefore reached SUBSCRIBED and then received
-- nothing, forever — the worst possible failure shape, because the client
-- reports success and simply stays silent.
--
-- What was silently dead: new messages in an open chat, inbox reordering, the
-- notification bell, feed inserts, like and comment counters, live comment
-- threads, presence and profile edits.
--
-- (`supabase_realtime_messages_publication`, holding `messages_2026_08_*`, is
-- Realtime's own internal partitioned broadcast storage. It is unrelated to
-- `public.messages` and is easy to mistake for it.)
--
-- RLS STILL APPLIES. Realtime evaluates the same policies per subscriber before
-- delivering a row, so publishing a table does not widen who can see what.
--
-- Idempotent — safe to run repeatedly.
-- =============================================================================

begin;

do $$
declare
  t text;
begin
  foreach t in array array['users', 'posts', 'comments', 'messages', 'conversations', 'notifications']
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

-- --- REPLICA IDENTITY ---------------------------------------------------------
-- Postgres logs only the primary key of a deleted row by default, so a DELETE
-- arrives with everything except its id stripped out. Any subscription that
-- FILTERS on a non-key column therefore never matches a delete, and the row
-- stays on screen until a manual refresh.
--
-- That affects exactly these four:
--   messages       DELETE filtered on conversation_id
--   comments       event '*' filtered on post_id
--   posts          event '*' filtered on user_id
--   notifications  event '*' filtered on recipient_id
--
-- FULL logs the whole old row, which costs WAL volume. Accepted here because
-- these are small rows and a delete that never propagates is a visible bug.
--
-- `users` and `conversations` are left at DEFAULT: both are subscribed to for
-- UPDATE only, and an update always carries the complete new row.
alter table public.messages      replica identity full;
alter table public.comments      replica identity full;
alter table public.posts         replica identity full;
alter table public.notifications replica identity full;

commit;
