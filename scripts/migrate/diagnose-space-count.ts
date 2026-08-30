/**
 * Ground truth for one reported mismatch: a space chip reading "hdsaghe 2"
 * while the map says "0 pins in hdsaghe".
 *
 *   npx tsx scripts/migrate/diagnose-space-count.ts
 *
 * Two numbers that look alike is exactly the case where reading the code is
 * not enough — 2 members and 2 pins render identically. This asks the
 * database, per space, with the service role (so RLS cannot hide anything)
 * and then again as the owner (so RLS can).
 */

import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config();

const strip = (v?: string) => (v ?? '').trim().replace(/^['"]|['"]$/g, '');
const url = strip(process.env.VITE_SUPABASE_URL);
const serviceKey = strip(process.env.SUPABASE_SERVICE_ROLE_KEY);
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

(async () => {
  const { data: spaces, error } = await admin
    .from('map_spaces')
    .select('id, name, created_by, created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;

  console.log(`${spaces?.length ?? 0} space(s), newest first\n`);
  console.log('  members  pins   space');
  console.log('  ' + '─'.repeat(56));

  for (const s of spaces ?? []) {
    const [{ count: members }, { count: pins }] = await Promise.all([
      admin.from('map_space_members').select('id', { count: 'exact', head: true }).eq('space_id', s.id),
      admin.from('pins').select('id', { count: 'exact', head: true }).eq('space_id', s.id),
    ]);
    const flag = (members ?? 0) !== (pins ?? 0) ? '' : '   <- both numbers equal';
    console.log(
      `  ${String(members ?? 0).padStart(7)}  ${String(pins ?? 0).padStart(4)}   ${s.name}${flag}`
    );
  }

  // The chip prints one bare number beside the space name. Which one is it?
  const target = (spaces ?? []).find((s) => s.name === process.argv[2]) ?? (spaces ?? [])[0];
  if (!target) return;

  console.log(`\nDetail for "${target.name}" (${target.id.slice(0, 8)}…)`);

  const { data: memberRows } = await admin
    .from('map_space_members')
    .select('user_id, role, users(username)')
    .eq('space_id', target.id);
  for (const m of memberRows ?? []) {
    console.log(`  member  ${(m as any).users?.username ?? m.user_id.slice(0, 8)}  (${m.role})`);
  }

  const { data: pinRows } = await admin
    .from('pins')
    .select('id, name, caption, creator_id')
    .eq('space_id', target.id);
  console.log(`  pins in this space: ${pinRows?.length ?? 0}`);
  for (const p of pinRows ?? []) {
    console.log(`    ${p.name ?? p.caption ?? '(no name)'}`);
  }

  // And what RLS shows the owner — if this differs from the count above, the
  // policy is hiding rows that exist, which is the other candidate cause.
  const anonKey = strip(process.env.VITE_SUPABASE_ANON_KEY);
  const { data: link } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: (await admin.auth.admin.getUserById(target.created_by)).data.user?.email ?? '',
  });
  const token = (link?.properties as any)?.hashed_token;
  if (token) {
    const asOwner = createClient(url, anonKey, { auth: { persistSession: false } });
    const { error: vErr } = await asOwner.auth.verifyOtp({ token_hash: token, type: 'magiclink' });
    if (!vErr) {
      const { data: seen, error: seenErr } = await asOwner
        .from('pins')
        .select('id')
        .eq('space_id', target.id);
      console.log(
        `  the owner sees through RLS: ${seenErr ? `ERROR ${seenErr.code} ${seenErr.message}` : `${seen?.length ?? 0} pin(s)`}`
      );
      const { data: isMember } = await asOwner.rpc('is_space_member', { space: target.id });
      console.log(`  is_space_member() for the owner: ${isMember}`);
    }
  }
})();
