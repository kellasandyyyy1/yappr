/**
 * Applies the Supabase migrations to an in-process Postgres (PGlite) and runs
 * smoke tests against them.
 *
 *   npx tsx scripts/migrate/validate-schema.ts
 *
 * Catches syntax errors, bad constraints, broken function bodies, invalid
 * policy expressions and non-firing triggers *before* any of it reaches a real
 * project. No Docker and no network required.
 *
 * WHAT THIS DOES NOT COVER: PGlite is plain Postgres, so the Supabase-specific
 * pieces are shimmed below (`auth.users`, `auth.uid()`, the `authenticated`
 * role). RLS policy *logic* therefore is not executed here — only parsed and
 * accepted. Behavioural RLS testing still has to happen on staging.
 */

import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase', 'migrations');

/** Minimal stand-in for the parts of Supabase the migrations reference. */
const SUPABASE_SHIM = `
  create schema if not exists auth;

  -- raw_user_meta_data is what GoTrue stores signUp's options.data into, and
  -- 0009's trigger reads the profile fields back out of it.
  create table if not exists auth.users (
    id uuid primary key,
    email text,
    raw_user_meta_data jsonb not null default '{}'::jsonb
  );

  -- GoTrue's MFA factor table, as far as 0006 needs it.
  create table if not exists auth.mfa_factors (
    id      uuid primary key,
    user_id uuid not null,
    status  text not null
  );

  -- Returns the id set by set_test_user(); null when unauthenticated.
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('test.user_id', true), '')::uuid;
  $$;

  -- Only the 'aal' claim matters here; set_test_aal() drives it.
  create or replace function auth.jwt() returns jsonb language sql stable as $$
    select jsonb_build_object('aal', coalesce(nullif(current_setting('test.aal', true), ''), 'aal1'));
  $$;

  create or replace function set_test_user(uid uuid) returns void
  language sql as $$ select set_config('test.user_id', uid::text, false); $$;

  create or replace function set_test_aal(level text) returns void
  language sql as $$ select set_config('test.aal', level, false); $$;

  do $$ begin
    create role authenticated;
  exception when duplicate_object then null;
  end $$;

  do $$ begin
    create role anon;
  exception when duplicate_object then null;
  end $$;

  do $$ begin
    create role service_role;
  exception when duplicate_object then null;
  end $$;
`;

/**
 * Splits SQL into statements.
 *
 * Character-accurate rather than line-based: a line-based splitter cannot tell
 * a `;` inside a dollar-quoted function body from a statement terminator, and
 * cuts every plpgsql function into fragments. It also has to know about single
 * quotes, or the `$` in a regex literal like '^[a-z0-9_]{3,30}$' looks like the
 * start of a dollar quote and swallows the rest of the file.
 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  let inLineComment = false;
  let inBlockComment = false;
  let inString = false;
  let dollarTag: string | null = null;

  while (i < sql.length) {
    const ch = sql[i];
    const rest = sql.slice(i);

    if (inLineComment) {
      buf += ch;
      if (ch === '\n') inLineComment = false;
      i++; continue;
    }
    if (inBlockComment) {
      if (rest.startsWith('*/')) { buf += '*/'; i += 2; inBlockComment = false; }
      else { buf += ch; i++; }
      continue;
    }
    if (dollarTag) {
      if (rest.startsWith(dollarTag)) { buf += dollarTag; i += dollarTag.length; dollarTag = null; }
      else { buf += ch; i++; }
      continue;
    }
    if (inString) {
      buf += ch;
      if (ch === "'") inString = false;
      i++; continue;
    }

    if (rest.startsWith('--')) { inLineComment = true; buf += ch; i++; continue; }
    if (rest.startsWith('/*')) { inBlockComment = true; buf += '/*'; i += 2; continue; }
    if (ch === "'") { inString = true; buf += ch; i++; continue; }

    const dollarOpen = rest.match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
    if (dollarOpen) { dollarTag = dollarOpen[0]; buf += dollarTag; i += dollarTag.length; continue; }

    if (ch === ';') { buf += ch; out.push(buf.trim()); buf = ''; i++; continue; }

    buf += ch; i++;
  }
  if (buf.trim()) out.push(buf.trim());

  // Drop chunks that are only comments/whitespace.
  return out.filter((s) => s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().length > 0);
}

async function main() {
  console.log('Validating schema against in-process Postgres (PGlite)\n');

  const db = new PGlite();
  await db.waitReady;

  const version = await db.query<{ version: string }>('select version()');
  console.log(`  ${version.rows[0].version.split(',')[0]}\n`);

  // --- Shim ------------------------------------------------------------------
  try {
    await db.exec(SUPABASE_SHIM);
    console.log('  Supabase shim installed (auth.users, auth.uid, roles)\n');
  } catch (err) {
    console.error('  Shim failed:', (err as Error).message);
    process.exit(1);
  }

  // --- Migrations ------------------------------------------------------------
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  let failures = 0;

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const statements = splitStatements(sql);
    let applied = 0;
    const errors: { statement: string; message: string }[] = [];

    for (const statement of statements) {
      try {
        await db.exec(statement);
        applied++;
      } catch (err) {
        const message = (err as Error).message;

        // pg_trgm / gin_trgm_ops are not bundled with PGlite. Not a schema
        // defect — flag and continue so the rest still validates.
        if (/pg_trgm|gin_trgm_ops|extension/i.test(message)) {
          // Label with the first real line, not a leading comment.
          const label = statement
            .split('\n')
            .map((l) => l.trim())
            .find((l) => l && !l.startsWith('--')) ?? statement.slice(0, 60);
          console.log(`    (skipped, unsupported in PGlite) ${label.slice(0, 62)}`);
          continue;
        }
        errors.push({ statement: statement.split('\n')[0].slice(0, 90), message });
      }
    }

    const status = errors.length === 0 ? 'OK  ' : 'FAIL';
    console.log(`  [${status}] ${file.padEnd(24)} ${applied}/${statements.length} statements`);
    for (const e of errors) {
      failures++;
      console.log(`         ✗ ${e.statement}`);
      console.log(`           ${e.message}`);
    }
  }

  if (failures > 0) {
    console.log(`\n${failures} statement(s) failed. Fix before pushing.`);
    process.exit(1);
  }

  // --- Smoke tests -----------------------------------------------------------
  // RLS is enabled but the superuser session bypasses it, so these exercise
  // the *structure*: constraints, cascades and triggers.
  console.log('\nSmoke tests:');
  let testFailures = 0;
  const t = async (label: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  PASS  ${label}`); }
    catch (err) { console.log(`  FAIL  ${label} — ${(err as Error).message}`); testFailures++; }
  };
  const expect = (cond: boolean, msg: string) => { if (!cond) throw new Error(msg); };

  const alice = '11111111-1111-4111-8111-111111111111';
  const bob   = '22222222-2222-4222-8222-222222222222';

  await t('seed users', async () => {
    await db.exec(`
      insert into auth.users (id, email) values
        ('${alice}', 'alice@example.com'), ('${bob}', 'bob@example.com');
      insert into users (id, username, display_name, email) values
        ('${alice}', 'alice', 'Alice', 'alice@example.com'),
        ('${bob}', 'bob', 'Bob', 'bob@example.com');
    `);
  });

  await t('username check constraint rejects invalid handles', async () => {
    let rejected = false;
    try {
      await db.exec(`insert into auth.users (id,email) values ('33333333-3333-4333-8333-333333333333','x@y.z');
                     insert into users (id, username, display_name, email)
                     values ('33333333-3333-4333-8333-333333333333', 'Has Spaces!', 'X', 'x@y.z');`);
    } catch { rejected = true; }
    expect(rejected, 'invalid username was accepted');
  });

  await t('no_self_follow constraint holds', async () => {
    let rejected = false;
    try { await db.exec(`insert into follows (follower_id, following_id) values ('${alice}','${alice}');`); }
    catch { rejected = true; }
    expect(rejected, 'self-follow was accepted');
  });

  await t('duplicate follow collapses via composite PK', async () => {
    await db.exec(`insert into follows (follower_id, following_id) values ('${alice}','${bob}');`);
    let rejected = false;
    try { await db.exec(`insert into follows (follower_id, following_id) values ('${alice}','${bob}');`); }
    catch { rejected = true; }
    expect(rejected, 'duplicate follow was accepted');
  });

  let postId = '';
  await t('create post with images', async () => {
    const res = await db.query<{ id: string }>(
      `insert into posts (user_id, content, type) values ('${alice}', 'hello', 'image') returning id;`
    );
    postId = res.rows[0].id;
    await db.exec(`insert into post_images (post_id, position, url) values
      ('${postId}', 0, 'https://x/1.jpg'), ('${postId}', 1, 'https://x/2.jpg');`);
  });

  await t('likes_count trigger increments on insert', async () => {
    await db.exec(`insert into likes (post_id, user_id) values ('${postId}', '${bob}');`);
    const r = await db.query<{ likes_count: number }>(`select likes_count from posts where id='${postId}'`);
    expect(r.rows[0].likes_count === 1, `expected 1, got ${r.rows[0].likes_count}`);
  });

  await t('likes_count trigger decrements on delete', async () => {
    await db.exec(`delete from likes where post_id='${postId}' and user_id='${bob}';`);
    const r = await db.query<{ likes_count: number }>(`select likes_count from posts where id='${postId}'`);
    expect(r.rows[0].likes_count === 0, `expected 0, got ${r.rows[0].likes_count}`);
  });

  await t('comments_count trigger tracks comments', async () => {
    await db.exec(`insert into comments (post_id, user_id, content) values ('${postId}','${bob}','nice');`);
    const r = await db.query<{ comments_count: number }>(`select comments_count from posts where id='${postId}'`);
    expect(r.rows[0].comments_count === 1, `expected 1, got ${r.rows[0].comments_count}`);
  });

  await t('one reaction per user per post', async () => {
    await db.exec(`insert into post_reactions (post_id,user_id,emoji) values ('${postId}','${bob}','🔥');`);
    let rejected = false;
    try { await db.exec(`insert into post_reactions (post_id,user_id,emoji) values ('${postId}','${bob}','❤️');`); }
    catch { rejected = true; }
    expect(rejected, 'second reaction from same user was accepted');
  });

  let convId = '';
  await t('conversation + members + receipt fan-out', async () => {
    const res = await db.query<{ id: string }>(
      `insert into conversations (type, created_by) values ('direct','${alice}') returning id;`
    );
    convId = res.rows[0].id;
    await db.exec(`insert into conversation_members (conversation_id,user_id,role) values
      ('${convId}','${alice}','member'), ('${convId}','${bob}','member');`);

    await db.exec(`insert into messages (conversation_id, sender_id, content)
                   values ('${convId}','${alice}','yo');`);

    const receipts = await db.query<{ n: number }>(
      `select count(*)::int as n from message_receipts`
    );
    // Exactly one: bob. The sender never gets a receipt for their own message.
    expect(receipts.rows[0].n === 1, `expected 1 receipt, got ${receipts.rows[0].n}`);
  });

  await t('touch_conversation bumps updated_at on new message', async () => {
    const before = await db.query<{ updated_at: string }>(
      `select updated_at from conversations where id='${convId}'`);
    await db.exec(`insert into messages (conversation_id, sender_id, content)
                   values ('${convId}','${bob}','later');`);
    const after = await db.query<{ updated_at: string }>(
      `select updated_at from conversations where id='${convId}'`);
    expect(
      new Date(after.rows[0].updated_at) >= new Date(before.rows[0].updated_at),
      'updated_at did not advance'
    );
  });

  await t('direct conversation pair key registered', async () => {
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from direct_conversation_keys where conversation_id='${convId}'`);
    expect(r.rows[0].n === 1, 'pair key not registered');
  });

  await t('group without a name is rejected', async () => {
    let rejected = false;
    try { await db.exec(`insert into conversations (type, created_by) values ('group','${alice}');`); }
    catch { rejected = true; }
    expect(rejected, 'unnamed group was accepted');
  });

  await t('deleting a post cascades to images, likes, comments', async () => {
    await db.exec(`delete from posts where id='${postId}';`);
    const r = await db.query<{ images: number; comments: number; reactions: number }>(`
      select (select count(*)::int from post_images where post_id='${postId}') as images,
             (select count(*)::int from comments where post_id='${postId}') as comments,
             (select count(*)::int from post_reactions where post_id='${postId}') as reactions;
    `);
    const { images, comments, reactions } = r.rows[0];
    expect(images === 0 && comments === 0 && reactions === 0,
      `orphans left: ${images} images, ${comments} comments, ${reactions} reactions`);
  });

  await t('recompute_counters() runs and returns a count', async () => {
    const r = await db.query(`select * from recompute_counters();`);
    expect(r.rows.length === 1, 'no row returned');
  });

  await t('deleting a user cascades to their content', async () => {
    await db.exec(`insert into posts (user_id, content) values ('${bob}','bye');`);
    await db.exec(`delete from users where id='${bob}';`);
    const r = await db.query<{ n: number }>(`select count(*)::int as n from posts where user_id='${bob}'`);
    expect(r.rows[0].n === 0, 'posts survived user deletion');
  });

  // --- 0009: the profile is created with the account ------------------------
  await t('signup metadata creates the profile row via trigger', async () => {
    const uid = '55555555-5555-4555-8555-555555555555';
    await db.exec(`
      insert into auth.users (id, email, raw_user_meta_data) values
        ('${uid}', 'signup@example.com',
         '{"username":"newsignup","display_name":"New Signup","terms_version":"v3"}'::jsonb);
    `);
    const r = await db.query<{ username: string; display_name: string; tv: string; at: string | null }>(
      `select username, display_name, terms_version as tv, terms_accepted_at as at
         from users where id = '${uid}'`);
    expect(r.rows.length === 1, 'no profile row was created');
    expect(r.rows[0].username === 'newsignup', `username was ${r.rows[0].username}`);
    expect(r.rows[0].display_name === 'New Signup', `display_name was ${r.rows[0].display_name}`);
    expect(r.rows[0].tv === 'v3', `terms_version was ${r.rows[0].tv}`);
    expect(r.rows[0].at !== null, 'consent timestamp not stamped on insert');
  });

  // The RLS suite and the migration importer create users through the admin
  // API with no metadata, then insert profiles themselves. If the trigger fired
  // for those too, every one of those inserts would hit a duplicate id.
  await t('admin-created user (no metadata) is skipped by the trigger', async () => {
    const uid = '66666666-6666-4666-8666-666666666666';
    await db.exec(`insert into auth.users (id, email) values ('${uid}', 'adminmade@example.com');`);
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from users where id = '${uid}'`);
    expect(r.rows[0].n === 0, 'trigger created a profile for an admin-made user');

    // …and the explicit insert those scripts do still works.
    await db.exec(`insert into users (id, username, display_name, email)
                   values ('${uid}', 'adminmade', 'Admin Made', 'adminmade@example.com');`);
    const after = await db.query<{ n: number }>(
      `select count(*)::int as n from users where id = '${uid}'`);
    expect(after.rows[0].n === 1, 'explicit profile insert failed');
    await db.exec(`delete from auth.users where id in ('${uid}','55555555-5555-4555-8555-555555555555');`);
  });

  // --- 0007: consent timestamps come from the server, not the caller ---------
  await t('consent timestamp is stamped on a version change', async () => {
    await db.exec(`update users set terms_version = 'v1' where id='${alice}';`);
    const r = await db.query<{ v: string; at: string | null }>(
      `select terms_version as v, terms_accepted_at as at from users where id='${alice}'`);
    expect(r.rows[0].v === 'v1', 'version did not persist');
    expect(r.rows[0].at !== null, 'terms_accepted_at was not stamped');
  });

  await t('a back-dated consent timestamp is ignored', async () => {
    const before = await db.query<{ at: string }>(
      `select terms_accepted_at as at from users where id='${alice}'`);
    // What a tampered client would send: a new version with a chosen date.
    await db.exec(`update users set terms_version='v2', terms_accepted_at='1999-01-01'
                   where id='${alice}';`);
    const after = await db.query<{ v: string; at: string }>(
      `select terms_version as v, terms_accepted_at as at from users where id='${alice}'`);
    expect(after.rows[0].v === 'v2', 'version did not persist');
    expect(new Date(after.rows[0].at).getFullYear() > 1999,
      `back-dated timestamp was accepted: ${after.rows[0].at}`);
    expect(new Date(after.rows[0].at) >= new Date(before.rows[0].at),
      'timestamp went backwards');
  });

  await t('an unrelated profile update does not move the consent timestamp', async () => {
    const before = await db.query<{ at: string }>(
      `select terms_accepted_at as at from users where id='${alice}'`);
    await db.exec(`update users set bio='hello', terms_accepted_at='1999-01-01'
                   where id='${alice}';`);
    const after = await db.query<{ at: string }>(
      `select terms_accepted_at as at from users where id='${alice}'`);
    // Compare instants, not object identity — the driver hands back Date objects.
    expect(new Date(after.rows[0].at).getTime() === new Date(before.rows[0].at).getTime(),
      `consent timestamp changed on a non-consent update: ${before.rows[0].at} -> ${after.rows[0].at}`);
  });

  // --- 0006: does the aal guard reach every policy, and does it decide right? --
  await t('every authenticated policy carries the mfa guard', async () => {
    const r = await db.query<{ policyname: string; tablename: string }>(`
      select tablename, policyname from pg_policies
      where schemaname='public' and 'authenticated' = any(roles)
        and coalesce(qual,'')       not like '%mfa_satisfied()%'
        and coalesce(with_check,'') not like '%mfa_satisfied()%';
    `);
    expect(r.rows.length === 0,
      `unguarded: ${r.rows.map((x) => `${x.tablename}.${x.policyname}`).join(', ')}`);
  });

  await t('mfa_satisfied() lets a user with no factor through at aal1', async () => {
    await db.exec(`select set_test_user('${alice}'); select set_test_aal('aal1');`);
    const r = await db.query<{ ok: boolean }>(`select mfa_satisfied() as ok`);
    expect(r.rows[0].ok === true, 'a user without 2FA was blocked at aal1');
  });

  await t('mfa_satisfied() blocks an enrolled user at aal1 and admits them at aal2', async () => {
    await db.exec(`insert into auth.mfa_factors (id, user_id, status)
                   values ('44444444-4444-4444-8444-444444444444','${alice}','verified');`);

    await db.exec(`select set_test_aal('aal1');`);
    const low = await db.query<{ ok: boolean }>(`select mfa_satisfied() as ok`);
    expect(low.rows[0].ok === false, 'an enrolled user passed at aal1 — 2FA would be skippable');

    await db.exec(`select set_test_aal('aal2');`);
    const high = await db.query<{ ok: boolean }>(`select mfa_satisfied() as ok`);
    expect(high.rows[0].ok === true, 'an enrolled user was blocked at aal2');
  });

  await t('an unverified enrolment does not lock the account out', async () => {
    await db.exec(`update auth.mfa_factors set status='unverified'
                   where id='44444444-4444-4444-8444-444444444444';
                   select set_test_aal('aal1');`);
    const r = await db.query<{ ok: boolean }>(`select mfa_satisfied() as ok`);
    expect(r.rows[0].ok === true, 'an abandoned enrolment locked the user out at aal1');
    await db.exec(`delete from auth.mfa_factors; select set_test_user(null); select set_test_aal('aal1');`);
  });

  // --- Coverage report -------------------------------------------------------
  console.log('\nObjects created:');
  for (const [label, sql] of [
    ['tables', `select count(*)::int as n from pg_tables where schemaname='public'`],
    ['indexes', `select count(*)::int as n from pg_indexes where schemaname='public'`],
    ['policies', `select count(*)::int as n from pg_policies where schemaname='public'`],
    ['triggers', `select count(distinct tgname)::int as n from pg_trigger where not tgisinternal`],
    ['functions', `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'`],
  ] as const) {
    const r = await db.query<{ n: number }>(sql);
    console.log(`  ${label.padEnd(10)} ${r.rows[0].n}`);
  }

  const rlsOff = await db.query<{ tablename: string }>(`
    select tablename from pg_tables t
    where schemaname='public'
      and not exists (
        select 1 from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
        where c.relname=t.tablename and ns.nspname='public' and c.relrowsecurity
      );
  `);
  if (rlsOff.rows.length > 0) {
    console.log(`\n  Tables WITHOUT row level security: ${rlsOff.rows.map((r) => r.tablename).join(', ')}`);
  } else {
    console.log('\n  Every public table has RLS enabled.');
  }

  // PGlite's close() trips a libuv assertion on Windows; the process exits
  // cleanly anyway since nothing is persisted.

  console.log('\n' + '─'.repeat(58));
  if (testFailures === 0) {
    console.log('SCHEMA VALID — all migrations applied, all smoke tests passed.');
    console.log('RLS policy *behaviour* still needs verifying on staging.');
  } else {
    console.log(`${testFailures} smoke test(s) failed.`);
    process.exit(1);
  }
}

main().catch((err) => { console.error('\nValidation crashed:', err); process.exit(1); });
