/** Reports exactly which of our objects exist on the live project. */
import { createClient } from '@supabase/supabase-js';
import { supabaseConfig, projectRef } from './config';

const { url, serviceKey } = supabaseConfig();
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

const TABLES = ['songs','users','follows','posts','post_images','post_edits','likes','comments',
  'post_reactions','comment_reactions','conversations','conversation_members','messages',
  'message_receipts','message_reactions','notifications','music_history','push_subscriptions',
  'security_events','direct_conversation_keys','migration_issues'];

(async () => {
  console.log(`Project "${projectRef()}" — partial-state inspection\n`);

  const present: string[] = [], missing: string[] = [];
  for (const t of TABLES) {
    const { error } = await admin.from(t).select('*').limit(0);
    (error && /PGRST205|could not find/i.test(error.message) ? missing : present).push(t);
  }

  console.log(`TABLES  ${present.length}/${TABLES.length} present`);
  if (present.length) console.log(`  present: ${present.join(', ')}`);
  if (missing.length) console.log(`  MISSING: ${missing.join(', ')}`);

  const { error: rpcErr } = await admin.rpc('recompute_counters');
  console.log(`\nFUNCTIONS  recompute_counters: ${rpcErr ? 'missing' : 'present'}`);

  console.log('\nVERDICT');
  if (present.length === 0)      console.log('  Nothing applied — but enum types may still exist (invisible to PostgREST).');
  else if (missing.length === 0) console.log('  All tables present — the run may have got further than the error suggested.');
  else                           console.log(`  PARTIAL — ${present.length} tables committed, ${missing.length} never created.`);
  console.log('  Either way the project is NOT in a known-good state. Reset required.');
})();
