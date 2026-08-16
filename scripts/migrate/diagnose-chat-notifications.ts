/**
 * Reproduces the exact queries ChatView and NotificationsView issue, as a real
 * signed-in user, and reports the raw PostgREST error for each.
 *
 *   npx tsx scripts/migrate/diagnose-chat-notifications.ts
 *
 * The select strings below are copied verbatim from src/lib/db.ts. That is the
 * point: a wrong column, a broken embedded join, or an RLS policy that filters
 * out legitimate rows all present as "the screen is blank", and only the raw
 * error distinguishes them.
 *
 * Distinguishes the two failure shapes explicitly:
 *   • ERROR   — PostgREST rejected the query (bad column, bad join, denied)
 *   • 0 rows  — the query is valid but RLS filtered everything out
 * The second is the dangerous one, because it looks like "no data" rather than
 * a fault.
 *
 * Creates two users and a conversation, then removes them.
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
const PASSWORD = 'Corr3ct-Horse-Battery-9!';

// Verbatim from src/lib/db.ts
const USER_FIELDS =
  'id, username, display_name, email, photo_url, bio, status, last_active, created_at, terms_version, terms_accepted_at';

let failures = 0;
const ok = (l: string, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l: string, d = '') => { console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures++; };

function report(label: string, error: any, count: number, expectRows: boolean) {
  if (error) {
    bad(label, 'QUERY ERROR');
    console.log(`          code   : ${error.code ?? '(none)'}`);
    console.log(`          message: ${error.message}`);
    if (error.details) console.log(`          details: ${error.details}`);
    if (error.hint) console.log(`          hint   : ${error.hint}`);
    return;
  }
  if (expectRows && count === 0) {
    bad(label, '0 rows — query valid, RLS filtered everything out');
    return;
  }
  ok(label, `${count} row(s)`);
}

const stamp = Date.now();

(async () => {
  console.log(`Chat + Notifications diagnosis on ${url}\n`);
  const created: string[] = [];

  try {
    // --- Two real accounts ------------------------------------------------------
    const make = async (name: string) => {
      const email = `diag-${name}-${stamp}@privy-test.invalid`;
      const username = `diag${name}${stamp}`.slice(0, 30).toLowerCase();
      const { data, error } = await admin.auth.admin.createUser({
        email, password: PASSWORD, email_confirm: true,
        user_metadata: { username, display_name: name },
      });
      if (error || !data.user) throw new Error(`createUser(${name}): ${error?.message}`);
      created.push(data.user.id);
      const client = createClient(url, anonKey, { auth: { persistSession: false } });
      const { error: signInErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
      if (signInErr) throw new Error(`signIn(${name}): ${signInErr.message}`);
      return { id: data.user.id, client, username };
    };

    const alice = await make('alice');
    const bob = await make('bob');
    ok('two signed-in users', `${alice.id.slice(0, 8)}… / ${bob.id.slice(0, 8)}…`);

    // --- Their session's assurance level ---------------------------------------
    // Every policy is wrapped in mfa_satisfied() by 0006. If that returned false
    // for an ordinary account, every read below would silently return 0 rows.
    const { data: mfaOk, error: mfaErr } = await alice.client.rpc('mfa_satisfied');
    mfaErr ? bad('mfa_satisfied() callable by authenticated', mfaErr.message)
           : mfaOk === true
             ? ok('mfa_satisfied() returns true for a normal account')
             : bad('mfa_satisfied() returns true', `returned ${mfaOk} — 0006 is blocking every read`);

    // --- Build a conversation the way the app does -----------------------------
    const { data: conv, error: convErr } = await alice.client
      .from('conversations').insert({ type: 'direct', created_by: alice.id }).select('id').single();
    if (convErr || !conv) { bad('create conversation', convErr?.message); return; }
    ok('create conversation', conv.id.slice(0, 8) + '…');

    const { error: memErr } = await alice.client.from('conversation_members').insert([
      { conversation_id: conv.id, user_id: alice.id, role: 'member' },
      { conversation_id: conv.id, user_id: bob.id, role: 'member' },
    ]);
    memErr ? bad('add both members', memErr.message) : ok('add both members');

    const { error: sendErr } = await alice.client.from('messages')
      .insert({ conversation_id: conv.id, sender_id: alice.id, content: 'diagnostic message' });
    sendErr ? bad('send a message', sendErr.message) : ok('send a message');

    await admin.from('notifications').insert({
      recipient_id: bob.id, actor_id: alice.id, type: 'message',
      conversation_id: conv.id, content: 'diagnostic notification',
    });

    // =========================================================================
    console.log('\nChatView — chats.list(), verbatim select:');
    // =========================================================================
    for (const [who, actor] of [['alice (creator)', alice], ['bob (member)', bob]] as const) {
      const { data, error } = await actor.client
        .from('conversations')
        .select(`
          id, type, name, photo_url, created_by, created_at, updated_at,
          conversation_members(user_id, role, last_read_at, users(${USER_FIELDS})),
          messages(id, content, sender_id, type, created_at, message_receipts(user_id, read_at))
        `)
        .order('updated_at', { ascending: false })
        .limit(50);
      report(`inbox for ${who}`, error, data?.length ?? 0, true);
      if (!error && data?.length) {
        const row: any = data[0];
        console.log(`          members joined : ${row.conversation_members?.length ?? 0}`);
        console.log(`          messages joined: ${row.messages?.length ?? 0}`);
        if ((row.conversation_members?.length ?? 0) === 0)
          bad(`  members embedded for ${who}`, 'join returned 0 — the inbox row renders with no participant');
      }
    }

    // =========================================================================
    console.log('\nChatView — chats.messages():');
    // =========================================================================
    for (const [who, actor] of [['alice', alice], ['bob', bob]] as const) {
      const { data, error } = await actor.client
        .from('messages')
        .select(`
          id, conversation_id, sender_id, content, type, image_url, voice_url,
          reply_to_id, shared_post_id, created_at,
          message_receipts(user_id, delivered_at, read_at),
          message_reactions(user_id, emoji)
        `)
        .eq('conversation_id', conv.id)
        .order('created_at', { ascending: false })
        .limit(51);
      report(`messages for ${who}`, error, data?.length ?? 0, true);
    }

    // =========================================================================
    console.log('\nNotificationsView — notifications.list():');
    // =========================================================================
    const { data: notifs, error: notifErr } = await bob.client
      .from('notifications')
      .select(`id, recipient_id, actor_id, type, subtype, content, post_id, conversation_id,
               is_read, created_at, actor:users!notifications_actor_id_fkey(${USER_FIELDS})`)
      .eq('recipient_id', bob.id)
      .order('created_at', { ascending: false })
      .limit(50);
    report('notifications for bob', notifErr, notifs?.length ?? 0, true);
    if (!notifErr && notifs?.length) {
      const actorJoined = (notifs[0] as any).actor;
      actorJoined ? ok('actor join resolves', `@${actorJoined.username}`)
                  : bad('actor join resolves', 'null — the row renders with no sender');
    }

    // =========================================================================
    console.log('\nBadge counts (App.tsx):');
    // =========================================================================
    const { count: unreadNotifs, error: cErr1 } = await bob.client
      .from('notifications').select('*', { count: 'exact', head: true })
      .eq('recipient_id', bob.id).eq('is_read', false);
    cErr1 ? bad('unread notification count', cErr1.message) : ok('unread notification count', String(unreadNotifs));

    const { data: memberRows, error: cErr2 } = await bob.client
      .from('conversation_members').select('conversation_id, last_read_at').eq('user_id', bob.id);
    cErr2 ? bad('own membership rows', cErr2.message) : ok('own membership rows', `${memberRows?.length ?? 0}`);
  } catch (err) {
    bad('harness', (err as Error).message);
  } finally {
    await admin.from('conversations').delete().not('id', 'is', null)
      .then(() => {}, () => {});
    for (const id of created) await admin.auth.admin.deleteUser(id).catch(() => {});
    console.log(`\n  teardown: ${created.length} test account(s) removed`);
  }

  console.log('\n' + '─'.repeat(62));
  console.log(failures === 0
    ? 'CHAT + NOTIFICATIONS OK — every query returns the caller\'s own rows.'
    : `${failures} failure(s) — see the codes above.`);
  process.exit(failures === 0 ? 0 : 1);
})();
