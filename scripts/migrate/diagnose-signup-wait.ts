/**
 * Retries a real anon-key signUp until the project's email quota allows it.
 *
 *   npx tsx scripts/migrate/diagnose-signup-wait.ts
 *
 * This is the one step diagnose-account-lifecycle.ts cannot fake: the anon-key
 * signUp HTTP call itself, including GoTrue dispatching a confirmation email.
 * Everything downstream of it is already covered there via an admin-created
 * unconfirmed account.
 *
 * Emits a line only on a state change, so it is quiet while waiting.
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

const INTERVAL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 15; // ~75 minutes

const client = createClient(url, anonKey, { auth: { persistSession: false } });
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const stamp = Date.now();
    const email = `privy-signup-${stamp}@privy-test.invalid`;
    const username = `signupwait${stamp}`.slice(0, 30).toLowerCase();

    const { data, error } = await client.auth.signUp({
      email,
      password: 'Corr3ct-Horse-Battery-9!',
      options: { data: { username, display_name: 'Signup Wait', terms_version: 'v-test' } },
    });

    if (error?.code === 'over_email_send_rate_limit') {
      if (attempt === 1 || attempt % 3 === 0) {
        console.log(`still rate limited (attempt ${attempt}/${MAX_ATTEMPTS}) — retrying in 5m`);
      }
      await sleep(INTERVAL_MS);
      continue;
    }

    if (error) {
      console.log(`SIGNUP FAILED (not a rate limit): status=${error.status} code=${error.code} msg="${error.message}"`);
      process.exit(1);
    }

    const userId = data.user?.id;
    console.log(`SIGNUP SUCCEEDED via anon key on attempt ${attempt}`);
    console.log(`  user id : ${userId}`);
    console.log(`  email   : ${email}`);
    console.log(`  session : ${data.session ? 'yes' : 'no (confirmation required)'}`);
    console.log(`  a confirmation email was dispatched by GoTrue`);

    // Profile row, created by the 0009 trigger in the same transaction.
    const { data: profile } = await admin
      .from('users').select('username, display_name, terms_version, terms_accepted_at')
      .eq('id', userId!).maybeSingle();
    console.log(
      profile
        ? `  profile : CREATED @${profile.username} (terms ${profile.terms_version} at ${profile.terms_accepted_at})`
        : `  profile : MISSING — the trigger did not fire`
    );

    if (userId) {
      await admin.auth.admin.deleteUser(userId);
      console.log('  cleaned up');
    }
    process.exit(profile ? 0 : 1);
  }

  console.log(`gave up after ${MAX_ATTEMPTS} attempts — quota window longer than expected`);
  process.exit(1);
})();
