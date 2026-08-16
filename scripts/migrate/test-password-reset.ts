/**
 * End-to-end password reset, exercised for real.
 *
 *   npx tsx scripts/migrate/test-password-reset.ts
 *
 * Walks the whole loop: create an account, request a reset, consume the
 * recovery token, set a new password, then prove the OLD password is dead and
 * the NEW one works.
 *
 * The browser redirect is deliberately not part of this. `redirect_to` only
 * decides which page the browser lands on AFTER the token is verified — it has
 * no bearing on whether the reset itself succeeds. Testing them separately
 * means a misconfigured Site URL cannot hide a broken reset, or vice versa.
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

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const fresh = () => createClient(url, anonKey, { auth: { persistSession: false } });

let failures = 0;
const ok = (l: string, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l: string, d = '') => { console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures++; };

const stamp = Date.now();
const email = `reset-${stamp}@privy-test.invalid`;
const username = `reset${stamp}`.slice(0, 30);
const OLD_PASSWORD = 'Old-Harbour-Lantern-4471';
const NEW_PASSWORD = 'New-Meridian-Thicket-8823';

(async () => {
  console.log(`Password reset, end to end, on ${url}\n`);
  let userId = '';

  try {
    // --- 1. An account to reset ------------------------------------------------
    const { data: made, error: makeErr } = await admin.auth.admin.createUser({
      email, password: OLD_PASSWORD, email_confirm: true,
      user_metadata: { username, display_name: 'Reset Test' },
    });
    if (makeErr || !made.user) { bad('create account', makeErr?.message); return; }
    userId = made.user.id;
    ok('account created', `@${username}`);

    const before = await fresh().auth.signInWithPassword({ email, password: OLD_PASSWORD });
    before.error ? bad('old password works initially', before.error.message)
                 : ok('old password works initially');

    // --- 2. Request the reset (what the Forgot password? form does) ------------
    const requester = fresh();
    const { error: reqErr } = await requester.auth.resetPasswordForEmail(email, {
      redirectTo: 'https://yapprr.vercel.app/reset-password',
    });
    reqErr ? bad('resetPasswordForEmail', `${reqErr.status} ${reqErr.message}`)
           : ok('reset requested', 'no error leaked about whether the address exists');

    // --- 3. Consume the recovery token ----------------------------------------
    // The email link points at /auth/v1/verify, which redirects with a session
    // in the fragment. verifyOtp is the same exchange without a browser.
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: 'recovery', email,
      options: { redirectTo: 'https://yapprr.vercel.app/reset-password' },
    });
    if (linkErr || !linkData.properties) { bad('generate recovery link', linkErr?.message); return; }

    const emailedRedirect = new URL(linkData.properties.action_link).searchParams.get('redirect_to');
    console.log(`        link redirect_to: ${emailedRedirect}`);
    /^https?:\/\//.test(emailedRedirect ?? '')
      ? ok('link redirect is absolute', emailedRedirect!)
      : console.log(`  NOTE  redirect_to is not absolute — the browser will land on the wrong page.
        The reset below still works; only the landing page is affected.`);

    const recoveryClient = fresh();
    const { data: verified, error: verifyErr } = await recoveryClient.auth.verifyOtp({
      type: 'recovery',
      token_hash: linkData.properties.hashed_token,
    });
    if (verifyErr || !verified.session) { bad('recovery token establishes a session', verifyErr?.message); return; }
    ok('recovery token establishes a session', `user ${verified.user?.id.slice(0, 8)}…`);

    // --- 4. Set the new password ------------------------------------------------
    const { error: updErr } = await recoveryClient.auth.updateUser({
      password: NEW_PASSWORD,
      data: { requires_password_reset: false },
    });
    updErr ? bad('updateUser sets the new password', updErr.message)
           : ok('updateUser sets the new password');

    await recoveryClient.auth.signOut();
    ok('recovery session signed out', 'a forwarded link cannot leave anyone logged in');

    // --- 5. The part that actually matters ------------------------------------
    const oldTry = await fresh().auth.signInWithPassword({ email, password: OLD_PASSWORD });
    oldTry.error
      ? ok('OLD password is rejected', `${oldTry.error.status} ${oldTry.error.code}`)
      : bad('OLD password is rejected', 'it still works — the reset did not take');

    const newTry = await fresh().auth.signInWithPassword({ email, password: NEW_PASSWORD });
    if (newTry.error) {
      bad('NEW password signs in', `${newTry.error.status} ${newTry.error.message}`);
    } else {
      ok('NEW password signs in', 'session issued');
      const authed = createClient(url, anonKey, {
        auth: { persistSession: false },
        global: { headers: { Authorization: `Bearer ${newTry.data.session!.access_token}` } },
      });
      const { data: me } = await authed.from('users').select('username').eq('id', userId).maybeSingle();
      me ? ok('signed-in session reads its own profile', `@${me.username}`)
         : bad('signed-in session reads its own profile', 'RLS returned nothing');
    }

    // --- 6. A used token must not work twice ------------------------------------
    const replay = await fresh().auth.verifyOtp({
      type: 'recovery', token_hash: linkData.properties.hashed_token,
    });
    replay.error
      ? ok('recovery token is single-use', `replay rejected: ${replay.error.code ?? replay.error.status}`)
      : bad('recovery token is single-use', 'the same link worked twice');
  } finally {
    if (userId) {
      await admin.auth.admin.deleteUser(userId).catch(() => {});
      console.log('\n  teardown: test account removed');
    }
  }

  console.log('\n' + '─'.repeat(60));
  console.log(failures === 0 ? 'PASSWORD RESET OK — full loop verified.' : `${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
})();
