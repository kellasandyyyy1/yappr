/**
 * Compares posts.comments_count against the actual rows in `comments`.
 *
 *   npx tsx scripts/migrate/diagnose-comment-count.ts [postIdOrSearchText]
 *
 * A count that disagrees with its rows has three possible causes, and they need
 * different fixes:
 *
 *   1. the rows exist and the count is right, but RLS hides them from the
 *      reader — a visibility bug
 *   2. the rows are gone and the count was never decremented — a trigger bug
 *   3. the rows exist and the count is too low — a missed increment
 *
 * Reads with the SERVICE ROLE first (ground truth, no RLS) and then as a real
 * signed-in user (what the modal actually sees). The difference between those
 * two numbers is what separates cause 1 from causes 2 and 3.
 */

import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config();

const strip = (v?: string) => (v ?? '').trim().replace(/^['"]|['"]$/g, '');
const url = strip(process.env.VITE_SUPABASE_URL);
const anonKey = strip(process.env.VITE_SUPABASE_ANON_KEY);
const serviceKey = strip(process.env.SUPABASE_SERVICE_ROLE_KEY);

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const needle = process.argv[2];

(async () => {
  console.log(`Comment count audit on ${url}\n`);

  // --- Every post, with both numbers side by side -----------------------------
  const { data: posts, error } = await admin
    .from('posts')
    .select('id, user_id, content, comments_count, likes_count, created_at, users!posts_user_id_fkey(username)')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) { console.log('  posts query failed:', error.message); process.exit(1); }

  console.log('Ground truth (service role, RLS bypassed):\n');
  console.log('  ' + 'post'.padEnd(10) + 'author'.padEnd(14) + 'count'.padStart(6) + 'actual'.padStart(8) + '   content');

  const mismatches: any[] = [];
  for (const p of posts ?? []) {
    const { count: actual } = await admin
      .from('comments').select('*', { count: 'exact', head: true }).eq('post_id', p.id);

    const stored = p.comments_count ?? 0;
    const real = actual ?? 0;
    const flag = stored !== real ? '  <-- MISMATCH' : '';
    if (stored !== real) mismatches.push({ ...p, stored, real });

    const author = (p as any).users?.username ?? '(unknown)';
    console.log(
      '  ' + p.id.slice(0, 8).padEnd(10) + String(author).slice(0, 12).padEnd(14) +
      String(stored).padStart(6) + String(real).padStart(8) +
      '   ' + String(p.content ?? '').replace(/\s+/g, ' ').slice(0, 40) + flag
    );
  }

  console.log(`\n  posts checked: ${posts?.length ?? 0}   mismatched: ${mismatches.length}`);

  // --- The specific post ------------------------------------------------------
  const target = needle
    ? (posts ?? []).find((p) => p.id === needle || String(p.content ?? '').toLowerCase().includes(needle.toLowerCase()))
    : mismatches[0] ?? (posts ?? []).find((p) => (p.comments_count ?? 0) > 0);

  if (!target) { console.log('\n  No post to inspect.'); process.exit(0); }

  console.log(`\n${'─'.repeat(64)}\nInspecting post ${target.id}`);
  console.log(`  author        : @${(target as any).users?.username}`);
  console.log(`  content       : ${String(target.content ?? '').replace(/\s+/g, ' ').slice(0, 80)}`);
  console.log(`  comments_count: ${target.comments_count}`);

  const { data: rows } = await admin
    .from('comments')
    .select('id, user_id, content, type, created_at')
    .eq('post_id', target.id)
    .order('created_at');

  console.log(`\n  Rows actually in \`comments\` for this post: ${rows?.length ?? 0}`);
  for (const r of rows ?? []) {
    console.log(`    ${r.id.slice(0, 8)}  ${String(r.type).padEnd(6)}  ${r.created_at}  ${String(r.content ?? '').slice(0, 40)}`);
  }
  if ((rows?.length ?? 0) === 0) console.log('    (none — the table is empty for this post)');

  // --- Is a column being soft-deleted? ---------------------------------------
  const { data: cols } = await admin.rpc('username_available', { candidate: 'x' }).then(
    () => ({ data: null }), () => ({ data: null })
  );
  void cols;

  // --- What does a real signed-in user see? ----------------------------------
  console.log('\n  Same query as a signed-in user (RLS applied):');
  const stamp = Date.now();
  const email = `cc-${stamp}@privy-test.invalid`;
  const password = 'Corr3ct-Horse-Battery-9!';
  const { data: made } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { username: `cc${stamp}`.slice(0, 30), display_name: 'Count Check' },
  });

  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  await client.auth.signInWithPassword({ email, password });

  const { data: asUser, error: asUserErr } = await client
    .from('comments').select('id, content').eq('post_id', target.id);
  console.log(`    stranger sees: ${asUserErr ? 'ERROR ' + asUserErr.message : `${asUser?.length ?? 0} row(s)`}`);

  // And as the post's own author, who must always be able to read them.
  const { data: authorUser } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const author = (authorUser?.users ?? []).find((u) => u.id === target.user_id);
  if (author?.email) {
    console.log(`    (post author is ${author.email} — cannot sign in without their password)`);
  }

  await admin.auth.admin.deleteUser(made!.user!.id).catch(() => {});

  console.log(`\n${'─'.repeat(64)}`);
  if ((rows?.length ?? 0) === 0 && (target.comments_count ?? 0) > 0) {
    console.log('VERDICT: the count is wrong. No comment rows exist, so nothing was');
    console.log('         hidden by RLS — a decrement was missed when one was deleted.');
  } else if ((rows?.length ?? 0) > 0 && (asUser?.length ?? 0) === 0) {
    console.log('VERDICT: the rows exist but RLS hides them from a reader.');
  } else if ((rows?.length ?? 0) === (target.comments_count ?? 0)) {
    console.log('VERDICT: count and rows agree for this post.');
  } else {
    console.log('VERDICT: count and rows disagree in some other way — see above.');
  }
})();
