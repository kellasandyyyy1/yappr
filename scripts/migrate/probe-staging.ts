/**
 * Read-only probe: is the schema actually on the staging project yet?
 * Uses the publishable anon key only — no service role, writes nothing.
 *
 *   npx tsx scripts/migrate/probe-staging.ts
 */
import { createClient } from '@supabase/supabase-js';
import { supabasePublicConfig, projectRef } from './config';

const { url, anonKey } = supabasePublicConfig();
const client = createClient(url, anonKey, { auth: { persistSession: false } });

const TABLES = ['users', 'posts', 'messages', 'conversations', 'likes',
                'security_events', 'direct_conversation_keys'];

(async () => {
  console.log(`Probing project "${projectRef()}" with the anon key (read-only)\n`);
  let found = 0, missing = 0;
  for (const t of TABLES) {
    const { error } = await client.from(t).select('*').limit(0);
    if (!error) { console.log(`  EXISTS   ${t}`); found++; }
    else if (/could not find the table|does not exist|PGRST205/i.test(error.message)) {
      console.log(`  MISSING  ${t}`); missing++;
    } else {
      console.log(`  EXISTS   ${t}  (${error.code})`); found++;
    }
  }
  console.log(`\n  ${found} present, ${missing} missing`);
  console.log(missing === TABLES.length
    ? '\n  → Schema has NOT been pushed yet.'
    : missing === 0
      ? '\n  → Schema appears to be present.'
      : '\n  → Partial: the push did not fully apply.');
})();
