/**
 * Proves the realtime channels no longer collide.
 *
 *   npx tsx scripts/migrate/test-realtime-channels.ts
 *
 * Reproduces the exact pattern that was throwing:
 *
 *     cannot add 'postgres_changes' callbacks for realtime after 'subscribe()'
 *
 * Three simultaneous inbox subscribers (App had two, ChatView a third) plus a
 * mount/unmount/remount cycle, which is what React StrictMode does to every
 * effect in development.
 *
 * Asserts each channel reaches SUBSCRIBED. A collision surfaces either as a
 * thrown error or as a channel stuck in CHANNEL_ERROR — both fail here.
 */

import path from 'node:path';
import dotenv from 'dotenv';
import { createClient, type RealtimeChannel } from '@supabase/supabase-js';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config();

const strip = (v?: string) => (v ?? '').trim().replace(/^['"]|['"]$/g, '');
const url = strip(process.env.VITE_SUPABASE_URL);
const anonKey = strip(process.env.VITE_SUPABASE_ANON_KEY);
const serviceKey = strip(process.env.SUPABASE_SERVICE_ROLE_KEY);

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

let failures = 0;
const ok = (l: string, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l: string, d = '') => { console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures++; };

// Mirrors changesChannel() in src/lib/db.ts.
let seq = 0;
const changesChannel = (client: any, prefix: string): RealtimeChannel => {
  seq += 1;
  return client.channel(`${prefix}#${seq}`);
};

/** Resolves with the terminal subscribe status. */
function subscribeWithStatus(channel: RealtimeChannel, label: string): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('TIMEOUT'), 12000);
    channel.subscribe((status, err) => {
      if (['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
        clearTimeout(timer);
        if (err) console.log(`        ${label} error: ${err.message}`);
        resolve(status);
      }
    });
  });
}

(async () => {
  console.log(`Realtime channel collision test on ${url}\n`);

  const stamp = Date.now();
  const email = `rt-${stamp}@privy-test.invalid`;
  const password = 'Corr3ct-Horse-Battery-9!';
  let userId = '';

  try {
    const { data: made, error: makeErr } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
      user_metadata: { username: `rt${stamp}`.slice(0, 30), display_name: 'RT Test' },
    });
    if (makeErr || !made.user) { bad('create user', makeErr?.message); return; }
    userId = made.user.id;

    const client = createClient(url, anonKey, { auth: { persistSession: false } });
    const { error: signInErr } = await client.auth.signInWithPassword({ email, password });
    if (signInErr) { bad('sign in', signInErr.message); return; }
    ok('signed in');

    // --- Three simultaneous inbox subscribers ---------------------------------
    console.log('\nThree concurrent inbox subscribers (the exact failing case):');
    const inboxChannels: RealtimeChannel[] = [];
    const statuses: string[] = [];

    for (const label of ['App/badges', 'App/receipts', 'ChatView']) {
      try {
        const ch = changesChannel(client, 'inbox')
          .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversations' }, () => {})
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, () => {});
        inboxChannels.push(ch);
        statuses.push(await subscribeWithStatus(ch, label));
        statuses[statuses.length - 1] === 'SUBSCRIBED'
          ? ok(`${label} subscribed`, ch.topic)
          : bad(`${label} subscribed`, statuses[statuses.length - 1]);
      } catch (err) {
        bad(`${label} subscribed`, `THREW: ${(err as Error).message}`);
      }
    }

    // --- StrictMode: mount, unmount, remount -----------------------------------
    console.log('\nStrictMode double-invoke (mount → cleanup → mount):');
    try {
      const first = changesChannel(client, `user:${userId}`)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'users', filter: `id=eq.${userId}` }, () => {});
      const s1 = await subscribeWithStatus(first, 'first');
      // Cleanup is fire-and-forget in the app, so do not await it — that is
      // precisely the race that used to break the remount.
      void client.removeChannel(first);

      const second = changesChannel(client, `user:${userId}`)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'users', filter: `id=eq.${userId}` }, () => {});
      const s2 = await subscribeWithStatus(second, 'remount');

      s1 === 'SUBSCRIBED' ? ok('first mount subscribed') : bad('first mount', s1);
      s2 === 'SUBSCRIBED'
        ? ok('remount subscribed while the first was still closing')
        : bad('remount subscribed', s2);
      inboxChannels.push(second);
    } catch (err) {
      bad('StrictMode remount', `THREW: ${(err as Error).message}`);
    }

    // --- Notifications ---------------------------------------------------------
    console.log('\nNotifications channel:');
    try {
      const notif = changesChannel(client, `notifications:${userId}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${userId}` }, () => {});
      const s = await subscribeWithStatus(notif, 'notifications');
      s === 'SUBSCRIBED' ? ok('notifications subscribed', notif.topic) : bad('notifications subscribed', s);
      inboxChannels.push(notif);
    } catch (err) {
      bad('notifications', `THREW: ${(err as Error).message}`);
    }

    // --- Do events actually arrive? -------------------------------------------
    // This is separate from subscribing. A channel can reach SUBSCRIBED and
    // still deliver nothing if the table is absent from the supabase_realtime
    // publication.
    console.log('\nDelivery (requires the table to be in supabase_realtime):');
    const received = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 8000);
      const ch = changesChannel(client, `notif-probe:${userId}`)
        .on('postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${userId}` },
          () => { clearTimeout(timer); resolve(true); });
      ch.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await admin.from('notifications').insert({
            recipient_id: userId, actor_id: userId, type: 'message', content: 'probe',
          });
        }
      });
    });
    received
      ? ok('INSERT event delivered', 'publication includes notifications')
      : bad('INSERT event delivered', 'nothing arrived — notifications is NOT in supabase_realtime');

    for (const ch of inboxChannels) await client.removeChannel(ch).catch(() => {});
  } finally {
    if (userId) await admin.auth.admin.deleteUser(userId).catch(() => {});
    console.log('\n  teardown: test account removed');
  }

  console.log('\n' + '─'.repeat(62));
  console.log(failures === 0 ? 'REALTIME OK' : `${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
})();
