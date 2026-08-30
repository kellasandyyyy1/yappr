/**
 * Does a member actually receive the other members' user rows?
 *
 * The avatar stack renders spaces[].members[].user. That comes from an
 * embedded users(...) select, and an embed returns null for any row the
 * viewer's RLS forbids — silently. A stack that quietly shows one face
 * instead of five would look like a design choice, not a policy.
 */
import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config();

const strip = (v?: string) => (v ?? '').trim().replace(/^['"]|['"]$/g, '');
const url = strip(process.env.VITE_SUPABASE_URL);
const anonKey = strip(process.env.VITE_SUPABASE_ANON_KEY);
const admin = createClient(url, strip(process.env.SUPABASE_SERVICE_ROLE_KEY), {
  auth: { persistSession: false },
});

(async () => {
  const { data: space } = await admin
    .from('map_spaces').select('id, name').eq('name', process.argv[2] ?? 'hdsaghe').single();
  const { data: members } = await admin
    .from('map_space_members').select('user_id').eq('space_id', space!.id);

  for (const m of members ?? []) {
    const { data: u } = await admin.auth.admin.getUserById(m.user_id);
    const email = u.user?.email;
    if (!email) continue;
    const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    const client = createClient(url, anonKey, { auth: { persistSession: false } });
    await client.auth.verifyOtp({ token_hash: (link?.properties as any)?.hashed_token, type: 'magiclink' });

    // Exactly the shape MapView renders from.
    const { data: mine } = await client
      .from('map_spaces')
      .select('id, name, map_space_members(user_id, role, users(id, username, display_name, photo_url))')
      .eq('id', space!.id)
      .single();

    const rows = (mine as any)?.map_space_members ?? [];
    const withUser = rows.filter((r: any) => r.users);
    console.log(`  as ${u.user?.id.slice(0, 8)}: ${rows.length} member row(s), ${withUser.length} with a user record`);
    for (const r of rows) {
      console.log(`      ${r.user_id.slice(0, 8)} -> ${r.users ? r.users.display_name ?? r.users.username : 'NULL (RLS hid it)'}`);
    }
  }
})();
