/**
 * End-to-end signup check against the live project.
 *
 *   npx tsx scripts/migrate/diagnose-signup.ts
 *
 * Uses the publishable key and the same call the browser makes, then verifies
 * with the service role that the profile row exists. This is the check that
 * would have caught the orphaned-account bug: signup "succeeding" while
 * `public.users` stayed empty.
 *
 * Cleans up after itself.
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

const stamp = Date.now();
const email = `signup-check-${stamp}@privy-test.invalid`;
const username = `signupcheck${stamp}`.slice(0, 30).toLowerCase();

let failures = 0;
const ok = (label: string, detail = '') => console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
const bad = (label: string, detail = '') => { console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); failures++; };

(async () => {
  console.log(`Signup end-to-end check on "${url}"\n`);

  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Exactly what AuthView now sends.
  const { data, error } = await client.auth.signUp({
    email,
    password: 'Corr3ct-Horse-Battery-9!',
    options: {
      data: { username, display_name: 'Signup Check', terms_version: 'v-test' },
    },
  });

  let userId: string | undefined;

  if (error?.code === 'over_email_send_rate_limit') {
    // Every signup with confirmation enabled sends an email, and Supabase's
    // built-in SMTP allows only a handful per hour. Repeated testing exhausts
    // it. Fall back to the admin API, which writes the identical
    // raw_user_meta_data without sending anything — the trigger cannot tell the
    // difference, so the metadata contract is still exercised end to end. What
    // this fallback does NOT cover is the anon-key signUp round trip itself.
    console.log(`  SKIP  anon signUp — ${error.message}`);
    console.log('        (project email quota exhausted; using the admin path instead)\n');

    const { data: adminData, error: adminError } = await admin.auth.admin.createUser({
      email,
      password: 'Corr3ct-Horse-Battery-9!',
      email_confirm: true,
      user_metadata: { username, display_name: 'Signup Check', terms_version: 'v-test' },
    });
    if (adminError) { bad('admin createUser', adminError.message); process.exit(1); }
    userId = adminData.user?.id;
    ok('account created (admin path, same metadata)', userId);
  } else if (error) {
    bad('signUp', `${error.code ?? error.status}: ${error.message}`);
    process.exit(1);
  } else {
    userId = data.user?.id;
    ok('signUp returned a user', userId);
    console.log(`        session: ${data.session ? 'yes (autoconfirm on)' : 'no (confirmation required)'}`);
  }

  if (!userId) { bad('no user id returned'); process.exit(1); }

  // THE point of this script. Under the old code this row did not exist when
  // confirmation was on, because the client-side insert was rejected by RLS.
  const { data: profile, error: profileError } = await admin
    .from('users')
    .select('id, username, display_name, email, terms_version, terms_accepted_at')
    .eq('id', userId)
    .maybeSingle();

  if (profileError) bad('profile lookup', profileError.message);
  else if (!profile) bad('profile row exists', 'NONE — orphaned account, the bug is still present');
  else {
    ok('profile row exists', profile.id);
    profile.username === username
      ? ok('username carried through', profile.username)
      : bad('username carried through', `got "${profile.username}", expected "${username}"`);
    profile.display_name === 'Signup Check'
      ? ok('display_name carried through', profile.display_name)
      : bad('display_name carried through', `got "${profile.display_name}"`);
    profile.terms_version === 'v-test'
      ? ok('consent version recorded', profile.terms_version)
      : bad('consent version recorded', `got "${profile.terms_version}"`);
    profile.terms_accepted_at
      ? ok('consent timestamp stamped', String(profile.terms_accepted_at))
      : bad('consent timestamp stamped', 'null');
    profile.email === email
      ? ok('email carried through')
      : bad('email carried through', `got "${profile.email}"`);
  }

  // Teardown.
  const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
  if (deleteError) bad('teardown', deleteError.message);
  else {
    const { count } = await admin.from('users').select('*', { count: 'exact', head: true }).eq('id', userId);
    (count ?? 0) === 0
      ? ok('teardown', 'auth user and profile both removed')
      : bad('teardown', `${count} profile row(s) survived`);
  }

  console.log('\n' + '─'.repeat(58));
  console.log(failures === 0 ? 'SIGNUP OK — account and profile created together.' : `${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
