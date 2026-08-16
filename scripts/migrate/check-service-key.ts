/** Confirms the service role key is valid and what it can reach. */
import { createClient } from '@supabase/supabase-js';
import { supabaseConfig, projectRef } from './config';

const { url, serviceKey } = supabaseConfig();
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

(async () => {
  console.log(`Project "${projectRef()}"\n`);

  const { data, error } = await admin.auth.admin.listUsers({ perPage: 1 });
  if (error) {
    console.log(`  GoTrue admin : FAILED — ${error.message}`);
    process.exit(1);
  }
  console.log(`  GoTrue admin : OK (service role key is valid)`);
  console.log(`  auth users   : ${data.users.length === 0 ? 'none yet' : data.users.length + '+'}`);

  const { error: tableError } = await admin.from('users').select('id').limit(0);
  console.log(`  public.users : ${tableError ? 'MISSING (' + tableError.code + ')' : 'present'}`);

  const { error: rpcError } = await admin.rpc('recompute_counters');
  console.log(`  functions    : ${rpcError ? 'MISSING' : 'present'}`);
})();
