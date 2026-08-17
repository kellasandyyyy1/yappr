/**
 * Full comment round trip: add → count up → content matches → delete → count
 * down → content empty.
 *
 *   npx tsx scripts/migrate/test-comment-lifecycle.ts
 *
 * Runs the exact query src/lib/db.ts issues, as a real signed-in user, so an
 * embed error or an RLS gap fails here rather than showing up as a silently
 * empty modal.
 *
 * Also asserts the count arrives over Realtime rather than only on reload — the
 * post-card count must react to a comment added or removed by someone else.
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

const USER_FIELDS =
  'id, username, display_name, email, photo_url, bio, status, last_active, created_at, terms_version, terms_accepted_at';

let failures = 0;
const ok = (l: string, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l: string, d = '') => { console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures++; };

/** The exact select from comments.list(). */
const COMMENT_SELECT = `id, post_id, user_id, content, type, image_url, voice_url, reply_to_id, created_at,
               users!comments_user_id_fkey(${USER_FIELDS}), comment_reactions(user_id, emoji)`;

const storedCount = async (postId: string) => {
  const { data } = await admin.from('posts').select('comments_count').eq('id', postId).single();
  return data?.comments_count ?? -1;
};

(async () => {
  console.log(`Comment lifecycle on ${url}\n`);
  const created: string[] = [];
  let postId = '';

  try {
    const stamp = Date.now();
    const mk = async (name: string) => {
      const email = `cl-${name}-${stamp}@privy-test.invalid`;
      const password = 'Corr3ct-Horse-Battery-9!';
      const { data, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { username: `cl${name}${stamp}`.slice(0, 30).toLowerCase(), display_name: name },
      });
      if (error || !data.user) throw new Error(`${name}: ${error?.message}`);
      created.push(data.user.id);
      const client = createClient(url, anonKey, { auth: { persistSession: false } });
      await client.auth.signInWithPassword({ email, password });
      return { id: data.user.id, client };
    };

    const author = await mk('author');
    const reader = await mk('reader');
    ok('two signed-in users');

    const { data: post, error: postErr } = await author.client
      .from('posts').insert({ user_id: author.id, content: 'lifecycle post', type: 'text', visibility: 'public' })
      .select('id').single();
    if (postErr || !post) { bad('create post', postErr?.message); return; }
    postId = post.id;
    ok('post created', `comments_count=${await storedCount(postId)}`);

    // --- Realtime watcher, as the post card would have -------------------------
    const seen: number[] = [];
    const watcher = reader.client
      .channel(`lifecycle-counts:${postId}`)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'posts', filter: `id=eq.${postId}` },
        (payload) => {
          const n = (payload.new as any).comments_count;
          if (typeof n === 'number') seen.push(n);
        })
      .subscribe();
    await new Promise((r) => setTimeout(r, 1500));

    // --- Add -------------------------------------------------------------------
    console.log('\nAdd a comment:');
    const { data: added, error: addErr } = await reader.client
      .from('comments')
      .insert({ post_id: postId, user_id: reader.id, content: 'lifecycle comment', type: 'text' })
      .select('id').single();
    addErr ? bad('insert comment', addErr.message) : ok('insert comment', added!.id.slice(0, 8));

    await new Promise((r) => setTimeout(r, 1200));
    const afterAdd = await storedCount(postId);
    afterAdd === 1 ? ok('comments_count incremented', '0 → 1') : bad('comments_count incremented', `got ${afterAdd}`);

    // The query the modal runs.
    const { data: listed, error: listErr } = await author.client
      .from('comments').select(COMMENT_SELECT).eq('post_id', postId)
      .order('created_at', { ascending: false });
    if (listErr) {
      bad('modal query (post author)', `${listErr.code} ${listErr.message}`);
    } else {
      listed!.length === 1
        ? ok('modal query returns the comment', `${listed!.length} row`)
        : bad('modal query returns the comment', `${listed!.length} rows`);
      const c: any = listed?.[0];
      c?.content === 'lifecycle comment'
        ? ok('content matches', c.content)
        : bad('content matches', `got "${c?.content}"`);
      c?.users?.username
        ? ok('author join resolves', `@${c.users.username}`)
        : bad('author join resolves', 'null — the comment renders with no author');
    }

    seen.includes(1)
      ? ok('count reached the card over Realtime', `saw ${JSON.stringify(seen)}`)
      : bad('count reached the card over Realtime', `saw ${JSON.stringify(seen)} — only a reload would show it`);

    // --- Delete ----------------------------------------------------------------
    console.log('\nDelete the comment:');
    const { error: delErr } = await reader.client.from('comments').delete().eq('id', added!.id);
    delErr ? bad('delete comment', delErr.message) : ok('delete comment');

    await new Promise((r) => setTimeout(r, 1200));
    const afterDelete = await storedCount(postId);
    afterDelete === 0 ? ok('comments_count decremented', '1 → 0') : bad('comments_count decremented', `got ${afterDelete}`);

    const { data: afterList, error: afterErr } = await author.client
      .from('comments').select(COMMENT_SELECT).eq('post_id', postId);
    afterErr ? bad('modal query after delete', afterErr.message)
             : (afterList!.length === 0 ? ok('thread is empty') : bad('thread is empty', `${afterList!.length} left`));

    seen.includes(0)
      ? ok('decrement reached the card over Realtime', `saw ${JSON.stringify(seen)}`)
      : bad('decrement reached the card over Realtime', `saw ${JSON.stringify(seen)}`);

    await reader.client.removeChannel(watcher);
  } catch (err) {
    bad('harness', (err as Error).message);
  } finally {
    if (postId) await admin.from('posts').delete().eq('id', postId).then(() => {}, () => {});
    for (const id of created) await admin.auth.admin.deleteUser(id).catch(() => {});
    console.log(`\n  teardown: post and ${created.length} account(s) removed`);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(failures === 0 ? 'COMMENT LIFECYCLE OK' : `${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
})();
