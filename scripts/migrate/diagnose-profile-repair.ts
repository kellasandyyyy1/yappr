/**
 * Verifies recovery from a missing profile row.
 *
 *   npx tsx scripts/migrate/diagnose-profile-repair.ts
 *
 * Two cases, both against the live database with real RLS:
 *
 *   A. account has signup metadata -> the profile can be recreated by the
 *      signed-in user themselves, under `users_insert_own`
 *   B. account has no metadata (the Supabase dashboard's "Add user") -> there
 *      is no username to build a profile from, so recovery must decline rather
 *      than invent one
 *
 * The insert here mirrors users.ensureProfile() in src/lib/db.ts. It is
 * duplicated rather than imported because that module reads `import.meta.env`,
 * which only exists under Vite. What matters is that the *privilege* question
 * is answered against the real policies: can an ordinary signed-in user create
 * their own missing row, with no service key involved?
 */

import path from 'node:path';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config();

const strip = (v?: string) => (v ?? '').trim().replace(/^['"]|['"]$/g, '');
const url = strip(process.env.VITE_SUPABASE_URL);
const anonKey = strip(process.env.VITE_SUPABASE_ANON_KEY);
const serviceKey = strip(process.env.SUPABASE_SERVICE_ROLE_KEY);

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const PASSWORD = 'Corr3ct-Horse-Battery-9!';

let failures = 0;
const ok = (l: string, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l: string, d = '') => { console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures++; };

/** The ensureProfile() insert, run as the signed-in user. */
async function repair(client: SupabaseClient, userId: string) {
  const { data } = await client.auth.getUser();
  const meta = (data.user?.user_metadata ?? {}) as Record<string, unknown>;
  const username = typeof meta.username === 'string' ? meta.username.trim() : '';
  if (!username) return { declined: true as const };

  const displayName =
    typeof meta.display_name === 'string' && meta.display_name.trim()
      ? meta.display_name.trim()
      : username;

  const { error } = await client.from('users').insert({
    id: userId, username, display_name: displayName, email: data.user?.email ?? '',
  });
  return { declined: false as const, error };
}

async function signIn(email: string) {
  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign in: ${error.message}`);
  return { client, userId: data.user!.id };
}

(async () => {
  console.log(`Profile repair on "${url}"\n`);
  const created: string[] = [];

  try {
    // --- A. metadata present, profile missing --------------------------------
    console.log('A. Account created through signup, profile row lost:');
    const stampA = Date.now();
    const emailA = `repair-a-${stampA}@privy-test.invalid`;
    const usernameA = `repaira${stampA}`.slice(0, 30).toLowerCase();

    const { data: a, error: aErr } = await admin.auth.admin.createUser({
      email: emailA, password: PASSWORD, email_confirm: true,
      user_metadata: { username: usernameA, display_name: 'Repair A' },
    });
    if (aErr || !a.user) throw new Error(`createUser A: ${aErr?.message}`);
    created.push(a.user.id);

    const { count: madeByTrigger } = await admin
      .from('users').select('*', { count: 'exact', head: true }).eq('id', a.user.id);
    (madeByTrigger ?? 0) === 1
      ? ok('trigger created the profile at signup')
      : bad('trigger created the profile at signup', `count=${madeByTrigger}`);

    // Break it, exactly as the bug leaves it.
    await admin.from('users').delete().eq('id', a.user.id);
    const { count: afterDelete } = await admin
      .from('users').select('*', { count: 'exact', head: true }).eq('id', a.user.id);
    (afterDelete ?? 0) === 0 ? ok('profile row removed (simulating the broken state)')
                             : bad('profile row removed', `count=${afterDelete}`);

    const sessionA = await signIn(emailA);
    ok('signs in despite the missing profile', 'auth is unaffected');

    const resultA = await repair(sessionA.client, sessionA.userId);
    if (resultA.declined) bad('repair attempted', 'declined despite metadata being present');
    else if (resultA.error) bad('repair insert under RLS', resultA.error.message);
    else {
      const { data: fixed } = await admin
        .from('users').select('username, display_name').eq('id', a.user.id).maybeSingle();
      fixed
        ? ok('profile recreated by the user themselves', `@${fixed.username} / ${fixed.display_name}`)
        : bad('profile recreated', 'still missing');
    }

    // --- B. no metadata ------------------------------------------------------
    console.log('\nB. Account created in the dashboard (no metadata):');
    const stampB = Date.now();
    const emailB = `repair-b-${stampB}@privy-test.invalid`;

    const { data: b, error: bErr } = await admin.auth.admin.createUser({
      email: emailB, password: PASSWORD, email_confirm: true,
    });
    if (bErr || !b.user) throw new Error(`createUser B: ${bErr?.message}`);
    created.push(b.user.id);

    const { count: noProfile } = await admin
      .from('users').select('*', { count: 'exact', head: true }).eq('id', b.user.id);
    (noProfile ?? 0) === 0
      ? ok('trigger correctly skipped it', 'no metadata, so no profile')
      : bad('trigger correctly skipped it', `unexpectedly created ${noProfile} row(s)`);

    const sessionB = await signIn(emailB);
    const resultB = await repair(sessionB.client, sessionB.userId);
    resultB.declined
      ? ok('repair declines', 'no username available — will not invent a public handle')
      : bad('repair declines', 'it invented a profile from nothing');

    const { count: stillNone } = await admin
      .from('users').select('*', { count: 'exact', head: true }).eq('id', b.user.id);
    (stillNone ?? 0) === 0
      ? ok('no profile fabricated', 'user gets the visible error instead of a silent bounce')
      : bad('no profile fabricated', `${stillNone} row(s) created`);
  } finally {
    for (const id of created) await admin.auth.admin.deleteUser(id).catch(() => {});
    const { count } = await admin.from('users').select('*', { count: 'exact', head: true });
    console.log(`\n  teardown: ${created.length} account(s) removed, ${count ?? 0} profile row(s) left`);
  }

  console.log('\n' + '─'.repeat(58));
  console.log(failures === 0 ? 'PROFILE REPAIR OK' : `${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
