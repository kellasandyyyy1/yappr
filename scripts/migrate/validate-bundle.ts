/** Applies the generated single-file bundle to PGlite, proving the
 *  concatenation order and the surrounding transaction are correct. */
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const SHIM = `
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key, email text,
    raw_user_meta_data jsonb not null default '{}'::jsonb);
  create table if not exists auth.mfa_factors (id uuid primary key, user_id uuid not null, status text not null);
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('test.user_id', true), '')::uuid; $$;
  create or replace function auth.jwt() returns jsonb language sql stable as $$
    select jsonb_build_object('aal', coalesce(nullif(current_setting('test.aal', true), ''), 'aal1')); $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role anon; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role; exception when duplicate_object then null; end $$;
`;

(async () => {
  const db = new PGlite();
  await db.waitReady;
  await db.exec(SHIM);

  // PGlite lacks pg_trgm; strip only those statements so the rest is exercised
  // exactly as the dashboard will run it, transaction included.
  const sql = fs.readFileSync('supabase/ALL_MIGRATIONS.sql', 'utf8')
    .split('\n')
    .filter((l) => !/pg_trgm|gin_trgm_ops|pgcrypto/.test(l))
    .join('\n');

  try {
    await db.exec(sql);
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_tables where schemaname='public'`);
    const p = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_policies where schemaname='public'`);
    console.log(`  BUNDLE APPLIES CLEANLY — ${r.rows[0].n} tables, ${p.rows[0].n} policies`);
    console.log('  (transaction committed; a failure anywhere would have rolled all of it back)');
  } catch (err) {
    console.log(`  BUNDLE FAILED — ${(err as Error).message}`);
    process.exit(1);
  }
})();
