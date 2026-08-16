/**
 * Validates candidate signup credentials against every gate before a human
 * spends a scarce confirmation email on them.
 *
 *   npx tsx scripts/migrate/check-test-credentials.ts <email> <username> <password>
 *
 * Checks: the users_username_check regex, username availability, the local
 * password policy, the live HaveIBeenPwned corpus, and whether the email is
 * already registered.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config();

const strip = (v?: string) => (v ?? '').trim().replace(/^['"]|['"]$/g, '');
const admin = createClient(
  strip(process.env.VITE_SUPABASE_URL),
  strip(process.env.SUPABASE_SERVICE_ROLE_KEY),
  { auth: { persistSession: false } }
);

const [email, username, password] = process.argv.slice(2);
if (!email || !username || !password) {
  console.log('usage: check-test-credentials.ts <email> <username> <password>');
  process.exit(2);
}

let failures = 0;
const ok = (l: string, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l: string, d = '') => { console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures++; };

// Mirrors src/lib/passwordPolicy.ts.
const MIN = 10;
const COMMON = new Set(['password', 'password1', '123456789', 'qwertyuiop', 'letmein123']);

(async () => {
  console.log('Credential pre-flight\n');
  console.log(`  email    : ${email}`);
  console.log(`  username : ${username}`);
  console.log(`  password : ${'*'.repeat(password.length)} (${password.length} chars)\n`);

  // --- username --------------------------------------------------------------
  /^[a-z0-9_]{3,30}$/.test(username)
    ? ok('username matches users_username_check', '^[a-z0-9_]{3,30}$')
    : bad('username matches users_username_check', 'lowercase letters, digits and _ only, 3–30 chars');

  const { count: takenName } = await admin
    .from('users').select('*', { count: 'exact', head: true }).eq('username', username);
  (takenName ?? 0) === 0 ? ok('username is free') : bad('username is free', 'already taken');

  // The form lowercases and strips spaces; confirm that is a no-op here, so
  // what gets stored is what was typed.
  const normalised = username.toLowerCase().replace(/\s+/g, '');
  normalised === username
    ? ok('username survives the form normalisation unchanged')
    : bad('username survives normalisation', `form would store "${normalised}"`);

  // --- email -----------------------------------------------------------------
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const existing = (users?.users ?? []).find((u) => u.email?.toLowerCase() === email.toLowerCase());
  existing ? bad('email is unregistered', `already exists (${existing.id})`) : ok('email is unregistered');

  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ? ok('email is well formed')
    : bad('email is well formed');

  // Supabase rejects some throwaway domains outright.
  /@(example|test|localhost)\.(com|org|net)$/i.test(email)
    ? bad('email domain accepted by GoTrue', 'example.com and friends are rejected as invalid')
    : ok('email domain plausible');

  // --- password policy -------------------------------------------------------
  const lower = password.toLowerCase();
  password.length >= MIN ? ok(`password length >= ${MIN}`) : bad(`password length >= ${MIN}`);
  !COMMON.has(lower) ? ok('not a common password') : bad('not a common password');

  const emailLocal = email.split('@')[0].toLowerCase();
  !(emailLocal.length >= 3 && lower.includes(emailLocal))
    ? ok('does not contain the email local-part')
    : bad('does not contain the email local-part');
  !(username.length >= 3 && lower.includes(username.toLowerCase()))
    ? ok('does not contain the username')
    : bad('does not contain the username');
  !/^(.)\1+$/.test(password) ? ok('not one repeated character') : bad('not one repeated character');
  !/^(?:0123456789|1234567890|abcdefghij|qwertyuiop)/.test(lower)
    ? ok('not a keyboard run')
    : bad('not a keyboard run');

  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  console.log(`        character classes: ${classes}/4`);

  // --- HIBP, the gate most likely to reject an otherwise fine password -------
  const hash = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`, {
      headers: { 'Add-Padding': 'true' },
    });
    if (!res.ok) {
      console.log(`  SKIP  HIBP breach check — API returned ${res.status} (policy fails open)`);
    } else {
      const suffix = hash.slice(5);
      let count = 0;
      for (const line of (await res.text()).split('\n')) {
        const [candidate, n] = line.trim().split(':');
        if (candidate === suffix) { count = parseInt(n, 10) || 0; break; }
      }
      count === 0
        ? ok('not in the HaveIBeenPwned corpus')
        : bad('not in the HaveIBeenPwned corpus', `seen ${count.toLocaleString()} times`);
    }
  } catch (err: any) {
    console.log(`  SKIP  HIBP breach check — ${err.message} (policy fails open)`);
  }

  console.log('\n' + '─'.repeat(58));
  console.log(failures === 0 ? 'CREDENTIALS OK — safe to use on the signup form.' : `${failures} problem(s).`);
  process.exit(failures === 0 ? 0 : 1);
})();
