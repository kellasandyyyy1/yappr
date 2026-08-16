/**
 * Removes orphaned test data from staging.
 *
 *   npx tsx scripts/migrate/purge-test-residue.ts
 *
 * The RLS suite and the conversation diagnostic both create conversations.
 * `conversations.created_by` is ON DELETE SET NULL, not CASCADE, so deleting
 * the test users leaves the threads behind with a null owner. Those orphans
 * are what this clears.
 *
 * Guarded to the staging project. Refuses to run anywhere else.
 */

import { createClient } from '@supabase/supabase-js';
import { supabaseConfig, projectRef, assertStaging } from './config';

assertStaging();

const { url, serviceKey } = supabaseConfig();
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

const TABLES = ['users', 'posts', 'conversations', 'conversation_members', 'messages',
                'likes', 'comments', 'follows', 'security_events', 'push_subscriptions',
                'post_reactions', 'message_receipts', 'songs', 'notifications'];

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    const { count } = await admin.from(t).select('*', { count: 'exact', head: true });
    out[t] = count ?? 0;
  }
  return out;
}

(async () => {
  console.log(`Purging orphaned test data on "${projectRef()}"\n`);

  const before = await counts();
  const beforeTotal = Object.values(before).reduce((a, b) => a + b, 0);
  console.log(`  rows before: ${beforeTotal}`);

  const { data: authList } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const realUsers = (authList?.users ?? []).length;
  console.log(`  auth users : ${realUsers}`);

  if (realUsers > 0) {
    console.log('\n  Auth users exist — refusing to purge, this may not be pure test residue.');
    console.log('  Delete the users first if this really is a clean staging reset.');
    process.exit(1);
  }

  // With zero auth users, every remaining row is orphaned test data.
  // Conversations cascade to messages, members, receipts and reactions.
  const { error: convError } = await admin
    .from('conversations').delete().not('id', 'is', null);
  if (convError) console.log(`  conversations: ${convError.message}`);

  // Anything else that survived (songs have no owner FK, for instance).
  for (const t of ['messages', 'posts', 'songs', 'notifications']) {
    const { error } = await admin.from(t).delete().not('id', 'is', null);
    if (error) console.log(`  ${t}: ${error.message}`);
  }

  const after = await counts();
  const afterTotal = Object.values(after).reduce((a, b) => a + b, 0);

  console.log(`\n  rows after : ${afterTotal}`);
  const remaining = Object.entries(after).filter(([, n]) => n > 0);
  if (remaining.length === 0) {
    console.log('\n  CLEAN — staging is empty.');
  } else {
    for (const [t, n] of remaining) console.log(`      ${t.padEnd(22)} ${n}`);
  }
})();
