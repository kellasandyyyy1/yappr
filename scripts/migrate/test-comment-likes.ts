/**
 * The comment like button, end to end.
 *
 *   npx tsx scripts/migrate/test-comment-likes.ts
 *
 * The redesign turns "like" into a ❤️ row in comment_reactions, reusing the
 * reaction write path. That only holds if the table really is one row per
 * (comment, user) — otherwise liking would stack duplicates and the count in
 * the action row would climb on every click.
 *
 * Runs the same calls src/lib/db.ts makes, as real signed-in users.
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

const LIKE = '❤️';
let failures = 0;
const ok = (l: string, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l: string, d = '') => { console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures++; };

/** Mirrors reactions.setOnComment() in src/lib/db.ts. */
const setReaction = async (client: any, commentId: string, userId: string, emoji: string | null) => {
  await client.from('comment_reactions').delete().eq('comment_id', commentId).eq('user_id', userId);
  if (emoji) {
    return client.from('comment_reactions').insert({ comment_id: commentId, user_id: userId, emoji });
  }
  return { error: null };
};

const reactionsOf = async (commentId: string) => {
  const { data } = await admin
    .from('comment_reactions').select('user_id, emoji').eq('comment_id', commentId);
  const map: Record<string, string[]> = {};
  for (const r of data ?? []) (map[(r as any).emoji] ||= []).push((r as any).user_id);
  return map;
};

(async () => {
  console.log(`Comment likes on ${url}\n`);
  const created: string[] = [];
  let postId = '';

  try {
    const stamp = Date.now();
    const mk = async (name: string) => {
      const email = `cli-${name}-${stamp}@privy-test.invalid`;
      const password = 'Corr3ct-Horse-Battery-9!';
      const { data, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { username: `cli${name}${stamp}`.slice(0, 30).toLowerCase(), display_name: name },
      });
      if (error || !data.user) throw new Error(`${name}: ${error?.message}`);
      created.push(data.user.id);
      const client = createClient(url, anonKey, { auth: { persistSession: false } });
      await client.auth.signInWithPassword({ email, password });
      return { id: data.user.id, client };
    };

    const author = await mk('author');
    const fan = await mk('fan');

    const { data: post } = await author.client
      .from('posts').insert({ user_id: author.id, content: 'like test', type: 'text', visibility: 'public' })
      .select('id').single();
    postId = post!.id;

    const { data: comment, error: cErr } = await fan.client
      .from('comments').insert({ post_id: postId, user_id: fan.id, content: 'nice one', type: 'text' })
      .select('id').single();
    if (cErr) { bad('create comment', cErr.message); return; }
    const commentId = comment!.id;
    ok('post + comment created');

    // --- like --------------------------------------------------------------
    console.log('\nLike:');
    const { error: likeErr } = await setReaction(author.client, commentId, author.id, LIKE) as any;
    likeErr ? bad('author likes the comment', likeErr.message) : ok('author likes the comment');

    let map = await reactionsOf(commentId);
    map[LIKE]?.length === 1
      ? ok('one heart recorded', `${LIKE} × ${map[LIKE].length}`)
      : bad('one heart recorded', JSON.stringify(map));

    // --- idempotence -------------------------------------------------------
    console.log('\nLike again (double click / double tap):');
    await setReaction(author.client, commentId, author.id, LIKE);
    map = await reactionsOf(commentId);
    map[LIKE]?.length === 1
      ? ok('count does not stack', `still ${map[LIKE].length}`)
      : bad('count does not stack', `now ${map[LIKE]?.length} — one row per (comment, user) is not holding`);

    // --- a second user -----------------------------------------------------
    console.log('\nSecond user likes:');
    await setReaction(fan.client, commentId, fan.id, LIKE);
    map = await reactionsOf(commentId);
    map[LIKE]?.length === 2
      ? ok('count reaches 2', `${LIKE} × 2`)
      : bad('count reaches 2', JSON.stringify(map));

    // --- like and emoji are mutually exclusive -----------------------------
    console.log('\nAuthor switches to 🔥:');
    await setReaction(author.client, commentId, author.id, '🔥');
    map = await reactionsOf(commentId);
    const heartsNow = map[LIKE]?.length ?? 0;
    const firesNow = map['🔥']?.length ?? 0;
    heartsNow === 1 && firesNow === 1
      ? ok('heart released, fire taken', `${LIKE} × ${heartsNow}, 🔥 × ${firesNow}`)
      : bad('heart released, fire taken', JSON.stringify(map));

    // --- unlike ------------------------------------------------------------
    console.log('\nUnlike:');
    await setReaction(fan.client, commentId, fan.id, null);
    map = await reactionsOf(commentId);
    (map[LIKE]?.length ?? 0) === 0
      ? ok('heart removed', JSON.stringify(map))
      : bad('heart removed', JSON.stringify(map));

    // --- the modal's own query still carries reactions ----------------------
    console.log('\nThe query CommentsModal runs:');
    const { data: listed, error: lErr } = await author.client
      .from('comments')
      .select('id, content, comment_reactions(user_id, emoji)')
      .eq('post_id', postId);
    if (lErr) bad('list with reactions', `${lErr.code} ${lErr.message}`);
    else {
      const row: any = listed?.[0];
      Array.isArray(row?.comment_reactions)
        ? ok('reactions arrive with the comment', JSON.stringify(row.comment_reactions))
        : bad('reactions arrive with the comment', JSON.stringify(row));
    }

    // --- a stranger cannot like on someone else's behalf --------------------
    console.log('\nRLS:');
    const { error: spoofErr } = await fan.client
      .from('comment_reactions').insert({ comment_id: commentId, user_id: author.id, emoji: LIKE });
    spoofErr
      ? ok('cannot react as another user', spoofErr.code)
      : bad('cannot react as another user', 'the insert succeeded');
  } catch (err) {
    bad('harness', (err as Error).message);
  } finally {
    if (postId) await admin.from('posts').delete().eq('id', postId).then(() => {}, () => {});
    for (const id of created) await admin.auth.admin.deleteUser(id).catch(() => {});
    console.log(`\n  teardown: post and ${created.length} account(s) removed`);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(failures === 0 ? 'COMMENT LIKES OK' : `${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
})();
