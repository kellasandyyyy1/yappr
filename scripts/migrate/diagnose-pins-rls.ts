/**
 * Why is an insert into `pins` denied?
 *
 *   npx tsx scripts/migrate/diagnose-pins-rls.ts
 *
 * 42501 "violates row-level security policy" means RLS is on and no policy
 * matched — which is a different problem from the table being absent, and a
 * different problem again from a missing grant (that says "permission denied
 * for table"). This narrows down which.
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

const show = (label: string, error: any) =>
  console.log(`  ${error ? `DENIED  ${label} — ${error.code} ${String(error.message).split('\n')[0]}` : `OK      ${label}`}`);

(async () => {
  console.log(`Pins RLS on ${url}\n`);
  const created: string[] = [];
  let pinId = '';

  try {
    const stamp = Date.now();
    const email = `rls-${stamp}@privy-test.invalid`;
    const password = 'Corr3ct-Horse-Battery-9!';
    const { data, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
      user_metadata: { username: `rls${stamp}`.slice(0, 30), display_name: 'RLS probe' },
    });
    if (error || !data.user) throw new Error(error?.message);
    created.push(data.user.id);

    const client = createClient(url, anonKey, { auth: { persistSession: false } });
    const { data: session } = await client.auth.signInWithPassword({ email, password });
    const jwt = session.session!.access_token;

    // --- 1. What the database will see as auth.uid() -------------------------
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
    console.log('1. The token');
    console.log(`   sub  (auth.uid()) : ${claims.sub}`);
    console.log(`   role              : ${claims.role}`);
    console.log(`   aal               : ${claims.aal ?? '(absent)'}`);
    console.log(`   matches user id   : ${claims.sub === data.user.id}`);

    // --- 2. Does the row itself work, with RLS bypassed? ---------------------
    console.log('\n2. Service role (RLS bypassed)');
    const { data: svcPin, error: svcErr } = await admin
      .from('pins')
      .insert({ creator_id: data.user.id, latitude: 1.5, longitude: 2.5, caption: 'probe' })
      .select('id')
      .single();
    show('insert as service role', svcErr);
    if (svcPin) pinId = svcPin.id;

    // --- 3. Each policy, separately ------------------------------------------
    console.log('\n3. As the signed-in user');

    const { error: insErr } = await client
      .from('pins')
      .insert({ creator_id: data.user.id, latitude: 3.5, longitude: 4.5 })
      .select('id');
    show('INSERT  (pins_insert_own)', insErr);

    if (pinId) {
      const { data: rows, error: selErr } = await client.from('pins').select('id').eq('id', pinId);
      if (selErr) show('SELECT  (pins_select_visible)', selErr);
      else
        console.log(
          `  ${rows?.length ? 'OK      ' : 'EMPTY   '}SELECT  (pins_select_visible) — ${rows?.length ?? 0} row(s) for the creator`
        );
    }

    const { error: mediaErr } = await client
      .from('pin_media')
      .insert({ pin_id: pinId, media_type: 'photo', media_url: 'https://example.test/x.jpg' })
      .select('id');
    show('INSERT  pin_media (pin_media_write_own)', mediaErr);

    const { error: shareErr } = await client
      .from('pin_shares')
      .insert({ pin_id: pinId, shared_with_user_id: data.user.id })
      .select('id');
    show('INSERT  pin_shares (pin_shares_write_own)', shareErr);

    // --- 4. Is the helper callable? -----------------------------------------
    console.log('\n4. can_view_pin()');
    const { data: canView, error: fnErr } = await client.rpc('can_view_pin', { pin: pinId });
    if (fnErr) console.log(`   DENIED  rpc can_view_pin — ${fnErr.code} ${fnErr.message}`);
    else console.log(`   OK      rpc can_view_pin → ${canView}`);

    // --- 5. Reading it back the way the app does -----------------------------
    console.log('\n5. The exact select MapView runs');
    const { data: appRows, error: appErr } = await client
      .from('pins')
      .select('id, creator_id, latitude, longitude, caption, created_at, pin_media(id), pin_shares(id)')
      .order('created_at', { ascending: false });
    appErr
      ? console.log(`   DENIED  ${appErr.code} ${appErr.message}`)
      : console.log(`   OK      ${appRows?.length ?? 0} pin(s) visible`);
  } catch (err) {
    console.log(`  harness: ${(err as Error).message}`);
  } finally {
    if (pinId) await admin.from('pins').delete().eq('id', pinId).then(() => {}, () => {});
    for (const id of created) await admin.auth.admin.deleteUser(id).catch(() => {});
    console.log('\n  teardown done');
  }
})();
