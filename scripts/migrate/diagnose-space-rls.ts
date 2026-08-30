/**
 * What each member of a space actually sees through RLS.
 *
 *   npx tsx scripts/migrate/diagnose-space-rls.ts hdsaghe
 *
 * The service role bypasses RLS, so "the row exists" and "this user can read
 * it" are different questions. This asks the second one, as every member in
 * turn, which is the only way to tell a policy problem from a UI problem.
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

const wanted = process.argv[2];

(async () => {
  const { data: spaces } = await admin.from('map_spaces').select('id, name, created_by');
  const space = (spaces ?? []).find((s) => s.name === wanted);
  if (!space) throw new Error(`no space named ${wanted}`);

  console.log(`Space "${space.name}" ${space.id}\n`);

  const { data: members } = await admin
    .from('map_space_members')
    .select('user_id, role, users(username)')
    .eq('space_id', space.id);

  for (const m of members ?? []) {
    const username = (m as any).users?.username ?? m.user_id.slice(0, 8);
    const { data: u } = await admin.auth.admin.getUserById(m.user_id);
    const email = u.user?.email;
    if (!email) { console.log(`  ${username}: no email, skipped`); continue; }

    // A magic link is the only way to get a real user session without knowing
    // the password. It signs in as them, so RLS applies exactly as it does in
    // the browser.
    const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    const hashed = (link?.properties as any)?.hashed_token;
    const client = createClient(url, anonKey, { auth: { persistSession: false } });
    const { error: authErr } = await client.auth.verifyOtp({ token_hash: hashed, type: 'magiclink' });
    if (authErr) { console.log(`  ${username}: sign-in failed — ${authErr.message}`); continue; }

    // Exactly what MapView runs: every visible pin, unfiltered, then narrowed
    // client-side by space. If these two disagree the bug is in the filter.
    const { data: allPins, error: allErr } = await client
      .from('pins')
      .select('id, space_id, name, caption')
      .order('created_at', { ascending: false });
    const { data: scoped, error: scopedErr } = await client
      .from('pins')
      .select('id')
      .eq('space_id', space.id);
    const { data: mySpaces } = await client.from('map_spaces').select('id, name');
    const { data: isMember, error: rpcErr } = await client.rpc('is_space_member', { space: space.id });

    const inThisSpace = (allPins ?? []).filter((p) => p.space_id === space.id);

    console.log(`  ${username} (${m.role})`);
    console.log(`    spaces visible            ${(mySpaces ?? []).map((s) => s.name).join(', ') || 'none'}`);
    console.log(`    is_space_member()         ${rpcErr ? `ERROR ${rpcErr.code} ${rpcErr.message}` : isMember}`);
    console.log(`    pins.visible() total      ${allErr ? `ERROR ${allErr.code} ${allErr.message}` : allPins?.length}`);
    console.log(`    ...of which in this space ${inThisSpace.length}  [${inThisSpace.map((p) => p.name ?? p.caption).join(', ')}]`);
    console.log(`    same query, server-side   ${scopedErr ? `ERROR ${scopedErr.code}` : scoped?.length}`);
    console.log(`    members badge would show  ${members?.length}`);
    console.log();
  }
})();
