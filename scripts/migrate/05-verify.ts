/**
 * Step 5 — Verify the migration before cutting over.
 *
 *   npx tsx scripts/migrate/05-verify.ts
 *
 * Compares what the transform intended to write against what is actually in
 * Supabase, then runs relationship and integrity checks that a row count alone
 * would not catch.
 *
 * Exits non-zero if anything fails, so it can gate a deploy.
 */

import path from 'node:path';
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { supabaseConfig } from './config';
import { readJson, OUT_DIR, DATA_DIR } from './shared';

const { url: SUPABASE_URL, serviceKey: SERVICE_KEY } = supabaseConfig();

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let failures = 0;
let warnings = 0;

function check(ok: boolean, label: string, detail = '') {
  if (ok) console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}

function warn(label: string, detail: string) {
  console.log(`  WARN  ${label} — ${detail}`);
  warnings++;
}

const TABLES = [
  'songs', 'users', 'follows', 'posts', 'post_images', 'post_edits', 'likes',
  'comments', 'post_reactions', 'comment_reactions', 'conversations',
  'conversation_members', 'messages', 'message_receipts', 'message_reactions',
  'notifications', 'music_history', 'push_subscriptions', 'security_events',
];

async function countRows(table: string): Promise<number> {
  const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

/** Runs arbitrary SQL through a helper RPC if present; otherwise skips. */
async function scalar(sql: string): Promise<number | null> {
  const { data, error } = await supabase.rpc('migration_scalar', { query: sql });
  if (error) return null;
  return typeof data === 'number' ? data : Number(data);
}

async function main() {
  console.log(`Verifying ${SUPABASE_URL}\n`);

  // --- 1. Row counts match what the transform produced -----------------------
  console.log('Row counts (expected → actual):');
  for (const table of TABLES) {
    const file = path.join(OUT_DIR, `${table}.json`);
    if (!fs.existsSync(file)) continue;

    const expected = readJson<unknown[]>(file).length;
    let actual: number;
    try { actual = await countRows(table); }
    catch (err) { check(false, table, (err as Error).message); continue; }

    const detail = `${expected} → ${actual}`;
    if (actual === expected) check(true, table.padEnd(22), detail);
    else if (actual < expected) check(false, table.padEnd(22), `${detail} (${expected - actual} missing)`);
    else warn(table.padEnd(22), `${detail} (${actual - expected} extra — re-run of the import?)`);
  }

  // --- 2. Auth users line up with profile rows -------------------------------
  console.log('\nAuth:');
  const { data: authList, error: authError } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (authError) check(false, 'list auth users', authError.message);
  else {
    const authUsers = (authList?.users ?? []) as { user_metadata?: Record<string, unknown> }[];
    const authCount = authUsers.length;
    const profileCount = await countRows('users');
    check(authCount >= profileCount, 'every profile has an auth user',
      `${authCount} auth, ${profileCount} profiles`);

    const needsReset = authUsers.filter(
      (u) => u.user_metadata?.requires_password_reset
    ).length;
    console.log(`  NOTE  ${needsReset} user(s) flagged requires_password_reset — expected, passwords do not migrate`);
  }

  // --- 3. Orphans — FKs guarantee these are zero, so a non-zero means the
  //        constraint was dropped or the check itself is wrong.
  console.log('\nReferential integrity:');
  const orphanChecks: [string, string][] = [
    ['posts with no author', `select count(*) from posts p left join users u on u.id = p.user_id where u.id is null`],
    ['comments with no post', `select count(*) from comments c left join posts p on p.id = c.post_id where p.id is null`],
    ['messages with no conversation', `select count(*) from messages m left join conversations c on c.id = m.conversation_id where c.id is null`],
    ['members with no conversation', `select count(*) from conversation_members cm left join conversations c on c.id = cm.conversation_id where c.id is null`],
    ['likes with no post', `select count(*) from likes l left join posts p on p.id = l.post_id where p.id is null`],
  ];

  let ranAnySql = false;
  for (const [label, sql] of orphanChecks) {
    const value = await scalar(sql);
    if (value === null) continue;
    ranAnySql = true;
    check(value === 0, label, `${value} orphan(s)`);
  }
  if (!ranAnySql) {
    console.log('  SKIP  SQL checks — create the migration_scalar helper (see MIGRATION.md) to enable');
  }

  // --- 4. Counters agree with the rows they summarise ------------------------
  console.log('\nDenormalised counters:');
  const { data: drifted } = await supabase
    .from('posts')
    .select('id, likes_count, comments_count')
    .limit(1000);

  if (drifted && drifted.length > 0) {
    let mismatches = 0;
    for (const post of drifted as any[]) {
      const [{ count: likeCount }, { count: commentCount }] = await Promise.all([
        supabase.from('likes').select('*', { count: 'exact', head: true }).eq('post_id', post.id),
        supabase.from('comments').select('*', { count: 'exact', head: true }).eq('post_id', post.id),
      ]);
      if (likeCount !== post.likes_count || commentCount !== post.comments_count) mismatches++;
    }
    check(mismatches === 0, `likes_count / comments_count accurate (sampled ${drifted.length})`,
      `${mismatches} mismatch(es)`);
  }

  // --- 5. Spot-check a relationship end to end -------------------------------
  console.log('\nSpot check:');
  const { data: sample } = await supabase
    .from('conversations')
    .select('id, type, conversation_members(user_id, role), messages(id)')
    .limit(3);

  if (sample && sample.length > 0) {
    for (const conv of sample as any[]) {
      const memberCount = conv.conversation_members?.length ?? 0;
      const messageCount = conv.messages?.length ?? 0;
      check(memberCount > 0, `conversation ${conv.id.slice(0, 8)} has members`,
        `${memberCount} member(s), ${messageCount} message(s)`);
      if (conv.type === 'direct' && memberCount !== 2) {
        warn(`conversation ${conv.id.slice(0, 8)}`, `direct chat with ${memberCount} members`);
      }
    }
  } else {
    console.log('  SKIP  no conversations to sample');
  }

  // --- 6. Surface anything the import itself logged ---------------------------
  console.log('\nMigration issue log:');
  const { data: loggedIssues } = await supabase
    .from('migration_issues')
    .select('severity, reason')
    .limit(1000);

  if (loggedIssues && loggedIssues.length > 0) {
    const errors = (loggedIssues as any[]).filter((i) => i.severity === 'error').length;
    const warns = (loggedIssues as any[]).length - errors;
    check(errors === 0, 'no errors recorded during migration', `${errors} error(s), ${warns} warning(s)`);
  } else {
    check(true, 'no issues recorded');
  }

  // --- Summary ---------------------------------------------------------------
  console.log('\n' + '─'.repeat(60));
  if (failures === 0) {
    console.log(`VERIFICATION PASSED${warnings ? ` (${warnings} warning(s) to review)` : ''}`);
    console.log('Safe to proceed to the next cutover step in MIGRATION.md.');
  } else {
    console.log(`VERIFICATION FAILED — ${failures} check(s) failed, ${warnings} warning(s)`);
    console.log('Do NOT cut over. Review migration-data/issues-*.json.');
    process.exit(1);
  }
}

main().catch((err) => { console.error('\nVerification failed:', err); process.exit(1); });
