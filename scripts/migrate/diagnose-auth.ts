/**
 * Surfaces the REAL auth error instead of the UI's generic fallback.
 *
 *   npx tsx scripts/migrate/diagnose-auth.ts [email]
 *
 * Uses the same URL + publishable key the browser uses, so whatever this sees
 * is what the app sees. Prints the full error shape — name, status, code,
 * message — alongside how src/lib/authErrors.ts classifies it, since that is
 * what decides between "Invalid email or password." and the generic
 * "Something went wrong." fallback.
 *
 * Read-only except for step 2, which creates a throwaway probe user and tells
 * you to delete it. Never prints the key.
 */

import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config();

const strip = (v?: string) => (v ?? '').trim().replace(/^['"]|['"]$/g, '');

const url = strip(process.env.VITE_SUPABASE_URL);
const key = strip(process.env.VITE_SUPABASE_ANON_KEY);

const TARGET_EMAIL = process.argv[2] || 'kellas32@gmail.com';

function describe(label: string, err: any) {
  console.log(`\n── ${label}`);
  if (!err) {
    console.log('   (no error)');
    return;
  }
  console.log(`   name     : ${err.name ?? '(none)'}`);
  console.log(`   status   : ${err.status ?? '(none)'}`);
  console.log(`   code     : ${err.code ?? '(none)'}`);
  console.log(`   message  : ${err.message ?? '(none)'}`);
  if (err.cause) console.log(`   cause    : ${err.cause}`);
}

(async () => {
  console.log('Auth diagnosis\n');
  console.log(`  url        : ${url || '(MISSING)'}`);
  console.log(
    `  key type   : ${
      key.startsWith('sb_publishable_') ? 'publishable (new format)'
      : key.startsWith('eyJ') ? 'legacy JWT anon'
      : key.startsWith('sb_secret_') ? 'SECRET KEY — WRONG, this must never ship to a browser'
      : '(unrecognised)'
    }`
  );
  console.log(`  key length : ${key.length}`);

  if (!url || !key) {
    console.log('\n  FATAL: env not loaded. src/lib/supabase.ts throws at import time,');
    console.log('  which blanks the whole app rather than just the auth form.');
    process.exit(1);
  }

  // --- Is the auth service reachable, and how is it configured? --------------
  try {
    const res = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } });
    console.log(`\n  GET /auth/v1/settings -> ${res.status} ${res.statusText}`);
    if (res.ok) {
      const s: any = await res.json();
      console.log(`     email provider enabled : ${s.external?.email}`);
      console.log(`     signups disabled       : ${s.disable_signup}`);
      console.log(`     autoconfirm email      : ${s.mailer_autoconfirm}`);
    } else {
      console.log(`     body: ${(await res.text()).slice(0, 400)}`);
    }
  } catch (err: any) {
    console.log(`\n  GET /auth/v1/settings -> NETWORK FAILURE: ${err.message}`);
    if (err.cause) console.log(`     cause: ${err.cause}`);
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  // --- 1. Sign in ------------------------------------------------------------
  // Deliberately wrong password. GoTrue returns the same error for "no such
  // user" and "wrong password" (that is the anti-enumeration design), so this
  // cannot prove whether the account exists — but it cleanly separates a
  // credential rejection from a config or network failure, which is the actual
  // open question.
  const { error: signInErr } = await supabase.auth.signInWithPassword({
    email: TARGET_EMAIL,
    password: 'definitely-not-the-real-password-0000',
  });
  describe(`signInWithPassword("${TARGET_EMAIL}", deliberately wrong password)`, signInErr);

  // --- 2. Sign up, throwaway address ----------------------------------------
  const probe = `probe-${Date.now()}@example.com`;
  const { data: probeData, error: probeErr } = await supabase.auth.signUp({
    email: probe,
    password: 'Corr3ct-Horse-Battery-9!',
  });
  describe(`signUp("${probe}")`, probeErr);
  if (!probeErr) {
    console.log(`   user id  : ${probeData.user?.id ?? '(none)'}`);
    console.log(`   session  : ${probeData.session ? 'yes (autoconfirm on)' : 'no (confirmation required)'}`);
    console.log(`   >> probe user created — delete it when finished`);
  }

  // --- 3. Does the target address already exist? -----------------------------
  // With email confirmation on, GoTrue will not say. It returns a decoy user
  // with an empty `identities` array instead of an error, precisely so signup
  // cannot be used to enumerate addresses. That empty array is the tell.
  const { data: dupData, error: dupErr } = await supabase.auth.signUp({
    email: TARGET_EMAIL,
    password: 'Corr3ct-Horse-Battery-9!',
  });
  describe(`signUp("${TARGET_EMAIL}") — existence probe`, dupErr);
  if (!dupErr) {
    const identities = dupData.user?.identities;
    console.log(`   user id    : ${dupData.user?.id ?? '(none)'}`);
    console.log(`   identities : ${identities ? identities.length : '(none)'}`);
    console.log(
      `   reading    : ${
        identities && identities.length === 0
          ? 'address ALREADY EXISTS (decoy user, 0 identities)'
          : 'address was NEW — an account has just been created for it'
      }`
    );
    console.log(`   session    : ${dupData.session ? 'yes' : 'no'}`);
  }
})();
