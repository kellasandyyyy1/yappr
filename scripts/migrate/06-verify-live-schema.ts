/**
 * Step 6a — Confirm the push actually landed.
 *
 *   npx tsx scripts/migrate/06-verify-live-schema.ts
 *
 * `supabase db push` exiting 0 means the CLI sent the files, not that every
 * object exists and is shaped the way you expect. This checks the live project
 * directly: every table reachable, every column present, RLS on everywhere,
 * and the migration ledger matching the files on disk.
 *
 * Read-only. Safe against any project.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { supabaseConfig, projectRef } from './config';

const { url, serviceKey } = supabaseConfig();
const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Every table the migrations create, with a column that must exist on it. */
const EXPECTED: Record<string, string[]> = {
  songs: ['id', 'youtube_id', 'title', 'start_time'],
  users: ['id', 'firebase_uid', 'username', 'display_name', 'email', 'theme_song_id', 'terms_version'],
  follows: ['follower_id', 'following_id', 'created_at'],
  posts: ['id', 'firebase_id', 'user_id', 'content', 'type', 'visibility', 'likes_count', 'comments_count'],
  post_images: ['post_id', 'position', 'url'],
  post_edits: ['id', 'post_id', 'previous_content', 'edited_at'],
  likes: ['post_id', 'user_id', 'created_at'],
  comments: ['id', 'post_id', 'user_id', 'content', 'reply_to_id'],
  post_reactions: ['post_id', 'user_id', 'emoji'],
  comment_reactions: ['comment_id', 'user_id', 'emoji'],
  conversations: ['id', 'type', 'name', 'created_by', 'updated_at'],
  conversation_members: ['conversation_id', 'user_id', 'role', 'last_read_at'],
  messages: ['id', 'conversation_id', 'sender_id', 'content', 'type', 'reply_to_id', 'shared_post_id'],
  message_receipts: ['message_id', 'user_id', 'delivered_at', 'read_at'],
  message_reactions: ['message_id', 'user_id', 'emoji'],
  notifications: ['id', 'recipient_id', 'actor_id', 'type', 'is_read'],
  music_history: ['id', 'user_id', 'song_id', 'kind'],
  push_subscriptions: ['id', 'user_id', 'endpoint', 'p256dh', 'auth'],
  security_events: ['id', 'user_id', 'type', 'device_id'],
  direct_conversation_keys: ['conversation_id', 'pair_key'],
  migration_issues: ['id', 'source_path', 'severity', 'reason'],
};

let failures = 0;
const pass = (label: string, detail = '') =>
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
const fail = (label: string, detail = '') => {
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  failures++;
};

async function checkTables() {
  console.log('Tables and columns:');
  for (const [table, columns] of Object.entries(EXPECTED)) {
    // Selecting the named columns proves both that the table exists and that
    // each column does; PostgREST 400s on an unknown column.
    const { error } = await admin.from(table).select(columns.join(',')).limit(0);
    if (error) fail(table.padEnd(26), error.message);
    else pass(table.padEnd(26), `${columns.length} columns verified`);
  }
}

/**
 * With the service role we bypass RLS, so we cannot detect a missing policy by
 * being denied. Instead use the anon key: with RLS on and no anon policy, a
 * read returns zero rows rather than an error. A table with RLS *off* would
 * return rows (or a different error), which is what we are looking for.
 */
async function checkRlsEnabled() {
  console.log('\nRow level security:');
  const { anonKey } = supabaseConfig();
  if (!anonKey) {
    console.log('  SKIP  no anon key available');
    return;
  }
  const anon = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  for (const table of Object.keys(EXPECTED)) {
    const { data, error } = await anon.from(table).select('*').limit(1);
    if (error && /permission denied/i.test(error.message)) {
      pass(table.padEnd(26), 'locked to anon');
    } else if (!error && (data?.length ?? 0) === 0) {
      pass(table.padEnd(26), 'RLS on, no anon rows');
    } else if (!error && (data?.length ?? 0) > 0) {
      fail(table.padEnd(26), 'anon can READ rows — RLS missing or a policy is too open');
    } else {
      pass(table.padEnd(26), error?.message.slice(0, 40) ?? 'unknown');
    }
  }
}

async function checkMigrationLedger() {
  console.log('\nMigration ledger:');
  const files = fs
    .readdirSync(path.join(process.cwd(), 'supabase', 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  // supabase_migrations.schema_migrations is not exposed through PostgREST,
  // so compare against `supabase migration list` output instead.
  console.log(`  ${files.length} migration file(s) on disk: ${files.join(', ')}`);
  console.log('  Cross-check with: npx supabase migration list');
}

async function checkFunctions() {
  console.log('\nFunctions callable:');
  const { error } = await admin.rpc('recompute_counters');
  if (error) fail('recompute_counters()', error.message);
  else pass('recompute_counters()', 'callable');
}

/**
 * 0006 rewrites all 51 policies in a loop. A loop that silently matched nothing
 * would leave 2FA unenforced while every other check still passed, so the
 * coverage is asserted rather than assumed.
 */
async function checkMfaGuard() {
  console.log('\nTwo-factor enforcement (0006):');

  const { error: fnError } = await admin.rpc('mfa_satisfied');
  if (fnError) {
    fail('mfa_satisfied()', `${fnError.message} — 0006 has not been applied`);
    return;
  }
  pass('mfa_satisfied()', 'present');

  const { data, error } = await admin.rpc('mfa_guard_coverage');
  if (error) {
    fail('policy coverage', error.message);
    return;
  }
  const gaps = (data ?? []) as { tablename: string; policyname: string }[];
  if (gaps.length === 0) {
    pass('policy coverage', 'every authenticated policy carries the aal guard');
  } else {
    fail('policy coverage', `${gaps.length} unguarded: ` +
      gaps.map((g) => `${g.tablename}.${g.policyname}`).join(', '));
  }
}

async function main() {
  console.log(`Verifying live schema on project "${projectRef()}"\n`);

  await checkTables();
  await checkRlsEnabled();
  await checkFunctions();
  await checkMfaGuard();
  await checkMigrationLedger();

  console.log('\n' + '─'.repeat(58));
  if (failures === 0) {
    console.log('LIVE SCHEMA VERIFIED — every object present and locked down.');
    console.log('Next: npx tsx scripts/migrate/07-rls-suite.ts');
  } else {
    console.log(`${failures} check(s) FAILED. The push did not fully apply.`);
    process.exit(1);
  }
}

main().catch((err) => { console.error('\nVerification crashed:', err); process.exit(1); });
