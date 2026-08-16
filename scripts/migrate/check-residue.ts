/** Confirms no test data survived the suite/diagnostic runs. */
import { createClient } from '@supabase/supabase-js';
import { supabaseConfig, projectRef } from './config';

const { url, serviceKey } = supabaseConfig();
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

(async () => {
  console.log(`Residue check on "${projectRef()}"\n`);

  const { data: authList } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const users = authList?.users ?? [];
  const testUsers = users.filter((u) =>
    (u.email ?? '').includes('privy-test.invalid') ||
    (u.email ?? '').startsWith('rls-') ||
    (u.email ?? '').startsWith('diag-')
  );

  console.log(`  auth users total        : ${users.length}`);
  console.log(`  test users remaining    : ${testUsers.length}`);
  if (testUsers.length) {
    for (const u of testUsers) console.log(`      LEFTOVER ${u.email}`);
  }

  const counts: Record<string, number> = {};
  for (const t of ['users','posts','conversations','conversation_members','messages',
                   'likes','comments','follows','security_events','push_subscriptions',
                   'post_reactions','message_receipts','songs','notifications']) {
    const { count } = await admin.from(t).select('*', { count: 'exact', head: true });
    counts[t] = count ?? 0;
  }

  console.log('\n  table row counts:');
  const nonEmpty = Object.entries(counts).filter(([, n]) => n > 0);
  if (nonEmpty.length === 0) console.log('      all empty');
  else for (const [t, n] of nonEmpty) console.log(`      ${t.padEnd(22)} ${n}`);

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(
    total === 0 && testUsers.length === 0
      ? '\n  CLEAN — staging holds no test data.'
      : `\n  ${total} row(s) and ${testUsers.length} test user(s) remain.`
  );
})();
