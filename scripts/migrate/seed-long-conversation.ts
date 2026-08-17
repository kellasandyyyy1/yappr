/**
 * Seeds a conversation long enough to actually overflow the viewport.
 *
 *   npx tsx scripts/migrate/seed-long-conversation.ts <yourEmail> [count]
 *
 * The scroll bug only appears once the message list is taller than the pane —
 * two or three test messages still fit and hide it completely. This creates a
 * real conversation between an existing account and a throwaway partner, with
 * enough varied-length messages that the list must scroll.
 *
 * Also verifies pagination: chats.messages() pages at 50, so a count above that
 * exercises the cursor and the "Load older messages" control.
 *
 * Prints a teardown command; nothing is removed automatically, because the
 * point is to leave it in place for you to look at.
 */

import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config();

const strip = (v?: string) => (v ?? '').trim().replace(/^['"]|['"]$/g, '');
const url = strip(process.env.VITE_SUPABASE_URL);
const serviceKey = strip(process.env.SUPABASE_SERVICE_ROLE_KEY);
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

const targetEmail = process.argv[2];
const COUNT = Number(process.argv[3] ?? 60);

if (!targetEmail) {
  console.log('usage: seed-long-conversation.ts <yourEmail> [count]');
  process.exit(2);
}

// Deliberately mixed lengths — a wall of identical short messages would not
// exercise wrapping, and wrapping is what makes the list tall.
const LINES = [
  'hey',
  'are you around?',
  'I was reading through the migration notes earlier and there is a lot more detail in there than I expected, especially around the row level security work.',
  'yeah',
  'that all makes sense to me now',
  'One thing I keep coming back to is whether the realtime subscriptions will hold up once there are a few hundred people in here at once.',
  'good question',
  'we should test that properly',
  'Agreed. I would rather find out now than after launch, because retrofitting it later usually means touching every screen again.',
  'ok',
  'sounds good to me',
  'Let me know when you have pushed and I will pull it down and take a look this evening.',
];

(async () => {
  console.log(`Seeding a long conversation on ${url}\n`);

  const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const me = (list?.users ?? []).find((u) => u.email?.toLowerCase() === targetEmail.toLowerCase());
  if (!me) {
    console.log(`  No account for ${targetEmail}. Existing accounts:`);
    for (const u of list?.users ?? []) console.log(`    ${u.email}`);
    process.exit(1);
  }
  console.log(`  you    : ${me.email} (${me.id.slice(0, 8)}…)`);

  const stamp = Date.now();
  const partnerEmail = `chatpartner-${stamp}@privy-test.invalid`;
  const { data: partner, error: partnerErr } = await admin.auth.admin.createUser({
    email: partnerEmail, password: 'Corr3ct-Horse-Battery-9!', email_confirm: true,
    user_metadata: { username: `chatpartner${stamp}`.slice(0, 30), display_name: 'Scroll Test' },
  });
  if (partnerErr || !partner.user) { console.log(`  createUser: ${partnerErr?.message}`); process.exit(1); }
  console.log(`  partner: ${partnerEmail} (${partner.user.id.slice(0, 8)}…)`);

  const { data: conv, error: convErr } = await admin
    .from('conversations').insert({ type: 'direct', created_by: me.id }).select('id').single();
  if (convErr || !conv) { console.log(`  conversation: ${convErr?.message}`); process.exit(1); }

  const { error: memErr } = await admin.from('conversation_members').insert([
    { conversation_id: conv.id, user_id: me.id, role: 'member' },
    { conversation_id: conv.id, user_id: partner.user.id, role: 'member' },
  ]);
  if (memErr) { console.log(`  members: ${memErr.message}`); process.exit(1); }

  // Spaced timestamps so the date dividers and ordering are exercised too.
  const base = Date.now() - COUNT * 60_000;
  const rows = Array.from({ length: COUNT }, (_, i) => ({
    conversation_id: conv.id,
    sender_id: i % 3 === 0 ? partner.user!.id : me.id,
    content: `${i + 1}. ${LINES[i % LINES.length]}`,
    type: 'text' as const,
    created_at: new Date(base + i * 60_000).toISOString(),
  }));

  // Chunked: one 60-row insert is fine, but this keeps the pattern honest for
  // larger counts.
  for (let i = 0; i < rows.length; i += 25) {
    const { error } = await admin.from('messages').insert(rows.slice(i, i + 25));
    if (error) { console.log(`  insert: ${error.message}`); process.exit(1); }
  }

  const { count } = await admin
    .from('messages').select('*', { count: 'exact', head: true }).eq('conversation_id', conv.id);

  console.log(`\n  created ${count} messages in conversation ${conv.id}`);
  console.log(`  pagination: chats.messages() pages at 50, so ${
    (count ?? 0) > 50 ? 'the cursor and "Load older messages" are exercised' : 'raise the count above 50 to exercise the cursor'
  }`);
  console.log(`\n  Open the app, sign in as ${me.email}, and open the "Scroll Test" conversation.`);
  console.log('\n  Teardown when finished:');
  console.log(`    npx tsx scripts/migrate/purge-test-residue.ts`);
  console.log(`  or delete just this partner: ${partner.user.id}`);
})();
