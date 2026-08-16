/** Isolates why INSERT into conversations is rejected for an authenticated user. */
import { createClient } from '@supabase/supabase-js';
import { supabaseConfig, assertStaging } from './config';
assertStaging();

const { url, serviceKey, anonKey } = supabaseConfig();
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

const STAMP = Date.now();
const PASSWORD = `Diag-${STAMP}-xQ7`;
const cleanup: string[] = [];

(async () => {
  // One test user, signed in for real.
  const email = `diag-${STAMP}@privy-test.invalid`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  const uid = data.user!.id;
  cleanup.push(uid);
  await admin.from('users').insert({ id: uid, username: `diag_${STAMP}`.slice(0,30), display_name: 'Diag', email });

  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  await client.auth.signInWithPassword({ email, password: PASSWORD });

  const jwtSub = JSON.parse(
    Buffer.from((await client.auth.getSession()).data.session!.access_token.split('.')[1], 'base64').toString()
  ).sub;
  console.log(`  user id  : ${uid}`);
  console.log(`  jwt sub  : ${jwtSub}`);
  console.log(`  match    : ${uid === jwtSub}\n`);

  // CONTROL: posts uses the identical `with check (col = auth.uid())` shape.
  const post = await client.from('posts').insert({ user_id: uid, content: 'control' }).select('id').single();
  console.log(`  A. posts insert (control)            : ${post.error ? 'DENIED — ' + post.error.message : 'OK'}`);

  // B. service role — proves the table itself accepts the row.
  const svc = await admin.from('conversations').insert({ type: 'direct', created_by: uid }).select('id').single();
  console.log(`  B. conversations via service role    : ${svc.error ? 'FAILED — ' + svc.error.message : 'OK'}`);
  if (svc.data) await admin.from('conversations').delete().eq('id', svc.data.id);

  // C. authenticated, WITHOUT returning — separates WITH CHECK from RETURNING-select.
  const noRet = await client.from('conversations').insert({ type: 'direct', created_by: uid });
  console.log(`  C. authenticated, no RETURNING       : ${noRet.error ? 'DENIED (' + noRet.error.code + ') — ' + noRet.error.message : 'OK'}`);

  // D. authenticated, WITH returning.
  const withRet = await client.from('conversations').insert({ type: 'direct', created_by: uid }).select('id').single();
  console.log(`  D. authenticated, with RETURNING     : ${withRet.error ? 'DENIED (' + withRet.error.code + ') — ' + withRet.error.message : 'OK'}`);

  // E. group variant.
  const grp = await client.from('conversations').insert({ type: 'group', name: 'G', created_by: uid });
  console.log(`  E. authenticated group insert        : ${grp.error ? 'DENIED (' + grp.error.code + ') — ' + grp.error.message : 'OK'}`);

  // F. Does the row actually land despite the error?
  const { count } = await admin.from('conversations').select('*', { count: 'exact', head: true }).eq('created_by', uid);
  console.log(`  F. rows actually created             : ${count ?? 0}`);

  // created_by is SET NULL on user delete, so purge the conversations first.
  await admin.from('conversations').delete().eq('created_by', uid);
  for (const id of cleanup) await admin.auth.admin.deleteUser(id);
  console.log('\n  cleaned up');
})().catch(async (e) => {
  console.error('diagnostic failed:', e.message);
  for (const id of cleanup) await admin.auth.admin.deleteUser(id).catch(() => {});
});
