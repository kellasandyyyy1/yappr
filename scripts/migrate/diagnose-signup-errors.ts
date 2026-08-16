/**
 * Reproduces every way signup can fail and reports the REAL error shape.
 *
 *   npx tsx scripts/migrate/diagnose-signup-errors.ts
 *
 * The point is the last column: how src/lib/authErrors.ts classifies each one.
 * Anything landing on the generic "Something went wrong. Please try again."
 * fallback is an unhandled branch — the user sees nothing actionable and the
 * console says nothing useful.
 *
 * Uses the anon key, exactly as the browser does. Cleans up after itself.
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

const client = createClient(url, anonKey, { auth: { persistSession: false } });
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

const PASSWORD = 'Corr3ct-Horse-Battery-9!';
const created: string[] = [];

// --- Mirrors src/lib/authErrors.ts -------------------------------------------
const CREDENTIAL_CODES = new Set([
  'invalid_credentials', 'user_not_found', 'user_banned',
  'email_address_invalid', 'validation_failed', 'bad_json',
]);
const SAFE = new Set([
  'email_not_confirmed', 'over_request_rate_limit', 'over_email_send_rate_limit',
  'weak_password', 'user_already_exists', 'email_exists', 'signup_disabled',
  'email_provider_disabled', 'reauthentication_needed', 'session_expired',
  'otp_expired', 'mfa_verification_failed', 'mfa_challenge_expired',
  'captcha_failed', 'same_password',
]);

function classify(err: any): string {
  const code = err?.code ?? '';
  const status = err?.status ?? null;
  const msg = String(err?.message ?? '');
  if (CREDENTIAL_CODES.has(code)) return 'generic credentials msg';
  if (SAFE.has(code)) return 'SPECIFIC message';
  if (!code && /failed to fetch|networkerror/i.test(msg)) return 'blocked (CSP/offline)';
  if (!code && (status === 400 || status === 422)) return 'generic credentials msg';
  return '>>> FALLS BACK TO "Something went wrong" <<<';
}

function report(label: string, err: any) {
  console.log(`\n── ${label}`);
  if (!err) { console.log('   (succeeded — no error)'); return; }
  console.log(`   status  : ${err.status ?? '(none)'}`);
  console.log(`   code    : ${err.code ?? '(none)'}`);
  console.log(`   message : ${err.message}`);
  console.log(`   UI shows: ${classify(err)}`);
}

async function signUp(email: string, username: string, password = PASSWORD) {
  const { data, error } = await client.auth.signUp({
    email, password,
    options: { data: { username, display_name: username, terms_version: 'v-test' } },
  });
  if (data?.user?.id) created.push(data.user.id);
  return error;
}

(async () => {
  console.log(`Signup failure modes against ${url}`);

  const stamp = Date.now();

  // 1. A clean, valid signup — the control.
  report('valid signup (control)', await signUp(`ok-${stamp}@privy-test.invalid`, `ok${stamp}`.slice(0, 30)));

  // 2. Username already taken. The handle_new_user trigger hits the unique
  //    constraint, the auth.users insert rolls back, and GoTrue surfaces a
  //    database error rather than a validation one. Prime suspect.
  const dupName = `dup${stamp}`.slice(0, 30);
  await admin.auth.admin.createUser({
    email: `holder-${stamp}@privy-test.invalid`, password: PASSWORD, email_confirm: true,
    user_metadata: { username: dupName, display_name: 'Holder' },
  }).then(r => { if (r.data?.user?.id) created.push(r.data.user.id); });
  report('duplicate username', await signUp(`dup2-${stamp}@privy-test.invalid`, dupName));

  // 3. Username that violates the check constraint (^[a-z0-9_]{3,30}$).
  //    The form lowercases and strips spaces but does not reject punctuation.
  report('username with illegal characters', await signUp(`bad-${stamp}@privy-test.invalid`, 'has.dots!'));

  // 4. Username too short (< 3 chars).
  report('username too short', await signUp(`sh-${stamp}@privy-test.invalid`, 'ab'));

  // 5. Email already registered.
  report('email already registered', await signUp(`holder-${stamp}@privy-test.invalid`, `other${stamp}`.slice(0, 30)));

  // 6. Weak password (GoTrue's own minimum).
  report('weak password', await signUp(`weak-${stamp}@privy-test.invalid`, `weak${stamp}`.slice(0, 30), '123'));

  // --- cleanup ---------------------------------------------------------------
  for (const id of created) await admin.auth.admin.deleteUser(id).catch(() => {});
  const { count } = await admin.from('users').select('*', { count: 'exact', head: true });
  console.log(`\n\ncleanup: removed ${created.length} account(s); ${count ?? 0} profile row(s) remain`);
})();
