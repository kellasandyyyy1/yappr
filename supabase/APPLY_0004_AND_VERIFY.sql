-- ============================================================================
-- Applies migration 0004 and then reports the full RLS policy inventory.
--
--   Supabase Dashboard → SQL Editor → New query → paste → Run
--
-- Idempotent: safe to run more than once. The fix is wrapped in a transaction;
-- the verification queries run afterwards and only read.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PART 1 — the fix
-- ---------------------------------------------------------------------------
-- INSERT ... RETURNING evaluates the SELECT policy against the new row. The
-- previous policy called is_conversation_creator(id), which re-queries
-- `conversations`; that function is STABLE and sees the pre-statement
-- snapshot, so the row being inserted is invisible to it and the creator is
-- denied sight of the row they just made.
--
-- Testing the row's own column removes the lookup entirely.

begin;

drop policy if exists conversations_select_member on conversations;
create policy conversations_select_member on conversations
  for select to authenticated
  using (
    created_by = auth.uid()                 -- own column: visible on the new row
    or is_conversation_member(id)           -- other table: already committed
  );

-- Same latent trap: this policy queried its own table. Dormant today only
-- because no insert here uses RETURNING.
drop policy if exists conversation_members_select on conversation_members;
create policy conversation_members_select on conversation_members
  for select to authenticated
  using (
    user_id = auth.uid()
    or is_conversation_member(conversation_id)
  );

commit;

-- ---------------------------------------------------------------------------
-- PART 2 — per-table policy inventory
-- ---------------------------------------------------------------------------
select
  tablename                                        as table_name,
  count(*)::int                                    as policies,
  string_agg(policyname, ', ' order by policyname) as policy_names
from pg_policies
where schemaname = 'public'
group by tablename
order by tablename;

-- ---------------------------------------------------------------------------
-- PART 3 — summary. Every column below should read as noted.
-- ---------------------------------------------------------------------------
select
  (select count(*)::int from pg_policies where schemaname = 'public')
    as total_policies,                              -- expect 51

  (select count(distinct tablename)::int from pg_policies where schemaname = 'public')
    as tables_with_policies,                        -- expect 19 (2 tables are
                                                    -- intentionally policy-free:
                                                    -- migration_issues and
                                                    -- direct_conversation_keys)

  (select count(*)::int from pg_tables t
     where t.schemaname = 'public'
       and not exists (select 1 from pg_class c
                       join pg_namespace n on n.oid = c.relnamespace
                       where c.relname = t.tablename and n.nspname = 'public'
                         and c.relrowsecurity))
    as tables_without_rls,                          -- expect 0

  (select count(*)::int from pg_policies
     where schemaname = 'public'
       and policyname = 'conversations_select_member'
       and qual like '%created_by%')
    as conversations_fix_applied,                   -- expect 1

  (select count(*)::int from pg_policies
     where schemaname = 'public'
       and policyname = 'conversation_members_select'
       and qual like '%user_id = auth.uid()%')
    as members_fix_applied,                         -- expect 1

  (select count(*)::int from pg_policies
     where schemaname = 'public' and qual like '%is_conversation_creator%')
    as stale_creator_lookups;                       -- expect 0
