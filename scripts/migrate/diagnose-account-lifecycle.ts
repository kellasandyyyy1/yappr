/**
 * Full account lifecycle against the live project, via the anon key — the same
 * path the browser takes.
 *
 *   npx tsx scripts/migrate/diagnose-account-lifecycle.ts
 *
 *   1. sign up with a fresh address
 *   2. confirm the account exists in auth.users (what the dashboard shows)
 *   3. read the project's email-confirmation setting
 *   4. attempt login while UNCONFIRMED, with the right password and the wrong
 *      one, and compare the two error codes — that comparison is what decides
 *      whether a specific "confirm your email" message would leak account
 *      existence
 *   5. confirm the address, then log in for real
 *
 * Cleans up unless --keep is passed.
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

const KEEP = process.argv.includes('--keep');
const stamp = Date.now();
const EMAIL = process.env.TEST_EMAIL || `privy-lifecycle-${stamp}@privy-test.invalid`;
const PASSWORD = 'Corr3ct-Horse-Battery-9!';
const USERNAME = `lifecycle${stamp}`.slice(0, 30).toLowerCase();

const client = createClient(url, anonKey, { auth: { persistSession: false } });
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

let failures = 0;
const ok = (l: string, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l: string, d = '') => { console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures++; };
const info = (l: string, d = '') => console.log(`        ${l}${d ? `: ${d}` : ''}`);

function errShape(e: any) {
  if (!e) return 'no error';
  return `status=${e.status ?? '(none)'} code=${e.code ?? '(none)'} msg="${e.message}"`;
}

(async () => {
  console.log(`Account lifecycle on "${url}"`);
  console.log(`  email    : ${EMAIL}`);
  console.log(`  username : ${USERNAME}\n`);

  // --- 3 (read first; it determines what the rest should look like) ---------
  console.log('Email provider settings:');
  const settings: any = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: anonKey } })
    .then((r) => r.json())
    .catch(() => ({}));
  const confirmationRequired = settings.mailer_autoconfirm === false;
  info('email provider enabled', String(settings.external?.email));
  info('signups disabled', String(settings.disable_signup));
  info('mailer_autoconfirm', String(settings.mailer_autoconfirm));
  info('=> confirmation required before login', String(confirmationRequired));

  // --- 1. Sign up ------------------------------------------------------------
  console.log('\n1. Sign up (anon key, exactly what the browser sends):');
  const { data: signUpData, error: signUpError } = await client.auth.signUp({
    email: EMAIL,
    password: PASSWORD,
    options: { data: { username: USERNAME, display_name: 'Lifecycle Test', terms_version: 'v-test' } },
  });

  let userId = signUpData?.user?.id;

  if (signUpError) {
    if (signUpError.code === 'over_email_send_rate_limit') {
      // Fall back to an admin-created UNCONFIRMED account. This sends no email,
      // so it does not touch the quota, and the resulting row is identical to
      // what signUp produces — same metadata, same email_confirmed_at = null.
      // Everything downstream (existence, the unconfirmed-login error codes,
      // confirm-then-login) is therefore tested for real.
      //
      // What it does NOT cover: the anon-key signUp HTTP call itself. That one
      // needs the quota, and is retried by diagnose-signup-wait.ts.
      console.log(`  SKIP  anon signUp — ${errShape(signUpError)}`);
      console.log('        quota window still open; using an admin-created unconfirmed');
      console.log('        account instead, which sends no email and is otherwise identical.');

      const { data: adminData, error: adminError } = await admin.auth.admin.createUser({
        email: EMAIL,
        password: PASSWORD,
        email_confirm: false, // leave it unconfirmed, like a real signup
        user_metadata: { username: USERNAME, display_name: 'Lifecycle Test', terms_version: 'v-test' },
      });
      if (adminError) { bad('admin createUser fallback', adminError.message); process.exit(1); }
      userId = adminData.user?.id;
      ok('account created (admin fallback, unconfirmed)', userId);
    } else {
      bad('signUp', errShape(signUpError));
      process.exit(1);
    }
  } else {
    ok('signUp accepted', userId);
    info('session returned', signUpData.session ? 'yes' : 'no (as expected with confirmation on)');
  }

  if (!userId) { bad('no user id'); process.exit(1); }

  // --- 2. Does it exist? -----------------------------------------------------
  console.log('\n2. Account present in auth.users (what the dashboard lists):');
  const { data: authRow } = await admin.auth.admin.getUserById(userId);
  if (!authRow?.user) bad('auth user exists');
  else {
    ok('auth user exists', authRow.user.id);
    info('email', authRow.user.email ?? '(none)');
    info('created_at', authRow.user.created_at);
    info('email_confirmed_at', authRow.user.email_confirmed_at ?? 'null (unconfirmed)');
  }

  const { data: profile } = await admin
    .from('users').select('id, username, display_name, terms_version').eq('id', userId).maybeSingle();
  profile
    ? ok('profile row created by trigger', `@${profile.username}`)
    : bad('profile row created by trigger', 'MISSING');

  // --- 4. Login while unconfirmed -------------------------------------------
  console.log('\n3. Login while UNCONFIRMED:');

  const { error: rightPw } = await client.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  console.log(`  correct password -> ${errShape(rightPw)}`);

  const { error: wrongPw } = await client.auth.signInWithPassword({
    email: EMAIL, password: 'this-is-not-the-password-xyz',
  });
  console.log(`  wrong password   -> ${errShape(wrongPw)}`);

  const codesDiffer = (rightPw as any)?.code !== (wrongPw as any)?.code;
  console.log('\n  Enumeration analysis:');
  if (codesDiffer) {
    console.log('    The two codes DIFFER. `email_not_confirmed` is only returned once the');
    console.log('    password has already been accepted, so surfacing a specific "confirm');
    console.log('    your email" message reveals the account exists ONLY to someone who');
    console.log('    already holds valid credentials. That is not a usable enumeration');
    console.log('    oracle, and the clearer message is worth it.');
  } else {
    console.log('    The two codes are IDENTICAL. A specific message here WOULD leak that');
    console.log('    the address is registered to anyone who can guess it. Keep it generic.');
  }

  // --- 5. Confirm, then log in ----------------------------------------------
  console.log('\n4. Confirm the address, then log in:');
  console.log('   (equivalent to clicking the emailed link; the address above is');
  console.log('    undeliverable by design, so the link is applied via the admin API)');

  const { error: confirmError } = await admin.auth.admin.updateUserById(userId, { email_confirm: true });
  if (confirmError) { bad('confirm email', confirmError.message); process.exit(1); }
  ok('email marked confirmed');

  const { data: loginData, error: loginError } = await client.auth.signInWithPassword({
    email: EMAIL, password: PASSWORD,
  });

  if (loginError) {
    bad('login after confirmation', errShape(loginError));
  } else {
    ok('login after confirmation', 'session issued');
    info('user id matches signup', String(loginData.user?.id === userId));
    info('access token', loginData.session?.access_token ? 'present' : 'MISSING');

    // The token's assurance level, which every RLS policy now checks.
    const claims = loginData.session?.access_token
      ? JSON.parse(Buffer.from(loginData.session.access_token.split('.')[1], 'base64').toString())
      : {};
    info('aal claim', claims.aal ?? '(none)');
    info('role claim', claims.role ?? '(none)');

    // Can the session actually read its own profile through RLS? This is the
    // step that would fail if 0006's guard were misapplied.
    const authed = createClient(url, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${loginData.session!.access_token}` } },
    });
    const { data: me, error: meError } = await authed
      .from('users').select('id, username').eq('id', userId).maybeSingle();
    if (meError) bad('signed-in session reads its own profile', meError.message);
    else if (!me) bad('signed-in session reads its own profile', 'RLS returned 0 rows');
    else ok('signed-in session reads its own profile', `@${me.username}`);
  }

  // --- Teardown --------------------------------------------------------------
  if (KEEP) {
    console.log(`\n  --keep set; leaving ${EMAIL} in place (id ${userId})`);
  } else {
    const { error: delError } = await admin.auth.admin.deleteUser(userId);
    delError ? bad('teardown', delError.message) : ok('\nteardown', 'account and profile removed');
  }

  console.log('\n' + '─'.repeat(60));
  console.log(failures === 0 ? 'LIFECYCLE OK' : `${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
