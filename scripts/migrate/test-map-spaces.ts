/**
 * Map Spaces, end to end, as real signed-in users.
 *
 *   npx tsx scripts/migrate/test-map-spaces.ts
 *
 * Membership IS the visibility model, so most of this is about who cannot see
 * things. A space that leaks is worse than one that fails to load.
 *
 * The scenario the brief asks for:
 *   alice creates a space and invites bob
 *   both add pins; each sees the other's
 *   carol, a member of nothing, sees no space, no members and no pins
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

let failures = 0;
const ok = (l: string, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l: string, d = '') => { console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures++; };

(async () => {
  console.log(`Map Spaces on ${url}\n`);
  const created: string[] = [];
  const cleanup: Array<() => PromiseLike<unknown>> = [];

  try {
    const stamp = Date.now();
    const mk = async (name: string) => {
      const email = `sp-${name}-${stamp}@privy-test.invalid`;
      const password = 'Corr3ct-Horse-Battery-9!';
      const { data, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { username: `sp${name}${stamp}`.slice(0, 30).toLowerCase(), display_name: name },
      });
      if (error || !data.user) throw new Error(`${name}: ${error?.message}`);
      created.push(data.user.id);
      const client = createClient(url, anonKey, { auth: { persistSession: false } });
      await client.auth.signInWithPassword({ email, password });
      return { id: data.user.id, client, name };
    };

    const alice = await mk('alice');   // owner
    const bob = await mk('bob');       // member
    const carol = await mk('carol');   // member of nothing
    ok('three signed-in users');

    // --- 1. Create a space ----------------------------------------------------
    console.log('\n1. Create a space');
    // .select() means INSERT ... RETURNING, which needs the SELECT policy to
    // pass against the brand-new row. That is what broke pins twice.
    const { data: space, error: spaceErr } = await alice.client
      .from('map_spaces')
      .insert({ name: 'Summer trip', created_by: alice.id })
      .select('id, name')
      .single();
    if (spaceErr) { bad('create space (INSERT ... RETURNING)', `${spaceErr.code} ${spaceErr.message}`); return; }
    cleanup.push(() => admin.from('map_spaces').delete().eq('id', space.id));
    ok('create space (INSERT ... RETURNING)', space.name);

    const { error: ownerErr } = await alice.client
      .from('map_space_members')
      .insert({ space_id: space.id, user_id: alice.id, role: 'owner' })
      .select('id');
    ownerErr
      ? bad('owner adds their own first membership row', `${ownerErr.code} ${ownerErr.message}`)
      : ok('owner adds their own first membership row');

    const { error: inviteErr } = await alice.client
      .from('map_space_members')
      .insert({ space_id: space.id, user_id: bob.id, role: 'member' })
      .select('id');
    inviteErr ? bad('owner invites bob', inviteErr.message) : ok('owner invites bob');

    // --- 2. Both members add pins --------------------------------------------
    console.log('\n2. Both members add pins');
    const drop = async (who: typeof alice, lat: number, lng: number, caption: string) => {
      const { data, error } = await who.client
        .from('pins')
        .insert({ space_id: space.id, creator_id: who.id, latitude: lat, longitude: lng, caption })
        .select('id')
        .single();
      error ? bad(`${who.name} drops a pin`, `${error.code} ${error.message}`) : ok(`${who.name} drops a pin`, caption);
      return data?.id as string | undefined;
    };

    const alicePin = await drop(alice, 51.5, -0.12, 'the bench');
    const bobPin = await drop(bob, 48.85, 2.35, 'the bridge');

    if (alicePin) {
      const { error } = await alice.client.from('pin_media').insert({
        pin_id: alicePin, media_type: 'song', youtube_video_id: 'fl66dFTg5-Y', order_index: 0,
      });
      error ? bad('attach media', error.message) : ok('attach media to a pin');
    }

    // --- 3. Everyone in the space sees everything ----------------------------
    console.log('\n3. Shared visibility');
    const pinsFor = async (who: typeof alice) => {
      const { data, error } = await who.client
        .from('pins')
        .select('id, caption, creator_id, pin_media(id)')
        .eq('space_id', space.id);
      if (error) { bad(`${who.name} reads pins`, `${error.code} ${error.message}`); return []; }
      return data ?? [];
    };

    for (const who of [alice, bob]) {
      const rows = await pinsFor(who);
      rows.length === 2
        ? ok(`${who.name} sees both pins`, rows.map((r: any) => r.caption).join(', '))
        : bad(`${who.name} sees both pins`, `${rows.length} pin(s)`);
      const withMedia = rows.find((r: any) => r.pin_media?.length);
      withMedia ? ok(`${who.name} sees the attached media`) : bad(`${who.name} sees the attached media`);
    }

    const { data: memberRows } = await bob.client
      .from('map_space_members').select('user_id, role').eq('space_id', space.id);
    memberRows?.length === 2
      ? ok('a member can see the member list', `${memberRows.length} members`)
      : bad('a member can see the member list', `${memberRows?.length} rows`);

    // --- 4. A non-member sees nothing at all ---------------------------------
    console.log('\n4. Isolation — carol is in no space');
    const { data: carolSpaces } = await carol.client.from('map_spaces').select('id').eq('id', space.id);
    (carolSpaces ?? []).length === 0
      ? ok('carol cannot see the space')
      : bad('carol cannot see the space', `${carolSpaces?.length} row(s)`);

    const { data: carolPins } = await carol.client.from('pins').select('id').eq('space_id', space.id);
    (carolPins ?? []).length === 0
      ? ok('carol cannot see its pins')
      : bad('carol cannot see its pins', `${carolPins?.length} pin(s)`);

    const { data: carolMembers } = await carol.client
      .from('map_space_members').select('user_id').eq('space_id', space.id);
    (carolMembers ?? []).length === 0
      ? ok('carol cannot see the member list')
      : bad('carol cannot see the member list', `${carolMembers?.length} row(s)`);

    if (alicePin) {
      const { data: carolMedia } = await carol.client
        .from('pin_media').select('id').eq('pin_id', alicePin);
      (carolMedia ?? []).length === 0
        ? ok('carol cannot see the media either')
        : bad('carol cannot see the media either', `${carolMedia?.length} row(s)`);
    }

    const { error: carolPinErr } = await carol.client
      .from('pins')
      .insert({ space_id: space.id, creator_id: carol.id, latitude: 1, longitude: 1 });
    carolPinErr
      ? ok('carol cannot drop a pin into it', carolPinErr.code)
      : bad('carol cannot drop a pin into it', 'the insert succeeded');

    const { error: carolJoinErr } = await carol.client
      .from('map_space_members').insert({ space_id: space.id, user_id: carol.id, role: 'member' });
    carolJoinErr
      ? ok('carol cannot add herself', carolJoinErr.code)
      : bad('carol cannot add herself', 'the insert succeeded');

    // --- 5. Owner authority ---------------------------------------------------
    console.log('\n5. Owner authority');
    const { error: bobInviteErr } = await bob.client
      .from('map_space_members').insert({ space_id: space.id, user_id: carol.id, role: 'member' });
    bobInviteErr
      ? ok('a member cannot invite', bobInviteErr.code)
      : bad('a member cannot invite', 'the insert succeeded');

    await bob.client.from('map_space_members').delete().eq('space_id', space.id).eq('user_id', alice.id);
    const { count: stillThere } = await admin
      .from('map_space_members').select('id', { count: 'exact', head: true })
      .eq('space_id', space.id).eq('user_id', alice.id);
    stillThere === 1
      ? ok('a member cannot remove the owner')
      : bad('a member cannot remove the owner', 'the owner was removed');

    const { error: renameErr } = await bob.client
      .from('map_spaces').update({ name: 'bobs space' }).eq('id', space.id).select('id');
    const { data: afterRename } = await admin.from('map_spaces').select('name').eq('id', space.id).single();
    afterRename?.name === 'Summer trip'
      ? ok('a member cannot rename the space', renameErr ? renameErr.code : 'update matched no rows')
      : bad('a member cannot rename the space', `name is now "${afterRename?.name}"`);

    // --- 6. Leaving -----------------------------------------------------------
    console.log('\n6. Leaving');
    const { error: leaveErr } = await bob.client
      .from('map_space_members').delete().eq('space_id', space.id).eq('user_id', bob.id);
    leaveErr ? bad('bob can leave voluntarily', leaveErr.message) : ok('bob can leave voluntarily');

    const afterLeave = await pinsFor(bob);
    afterLeave.length === 0
      ? ok('once out, bob sees nothing in it', 'including the pin he added')
      : bad('once out, bob sees nothing in it', `${afterLeave.length} pin(s) still visible`);

    // His pin stays for the rest of the space — leaving is not a retraction.
    const { count: bobsPinKept } = await admin
      .from('pins').select('id', { count: 'exact', head: true }).eq('id', bobPin!);
    bobsPinKept === 1
      ? ok("his pin stays in the space", 'leaving is not a retraction')
      : bad('his pin stays in the space', `${bobsPinKept} rows`);

    // --- 7. Cascade -----------------------------------------------------------
    console.log('\n7. Delete the space');
    const { error: delErr } = await alice.client.from('map_spaces').delete().eq('id', space.id);
    delErr ? bad('owner deletes the space', delErr.message) : ok('owner deletes the space');

    const { count: pinsLeft } = await admin
      .from('pins').select('id', { count: 'exact', head: true }).eq('space_id', space.id);
    const { count: membersLeft } = await admin
      .from('map_space_members').select('id', { count: 'exact', head: true }).eq('space_id', space.id);
    (pinsLeft ?? 0) === 0 && (membersLeft ?? 0) === 0
      ? ok('pins and members cascade away', `${pinsLeft} pins, ${membersLeft} members`)
      : bad('pins and members cascade away', `${pinsLeft} pins, ${membersLeft} members left`);

    // --- 8. The retired table -------------------------------------------------
    console.log('\n8. pin_shares is retired');
    const { error: sharesErr } = await admin.from('pin_shares').select('id').limit(1);
    sharesErr && /does not exist|schema cache/i.test(sharesErr.message)
      ? ok('pin_shares is gone', sharesErr.code)
      : bad('pin_shares is gone', sharesErr ? sharesErr.message : 'the table still answers queries');
  } catch (err) {
    bad('harness', (err as Error).message);
  } finally {
    for (const fn of cleanup.reverse()) await Promise.resolve(fn()).catch(() => {});
    for (const id of created) await admin.auth.admin.deleteUser(id).catch(() => {});
    console.log(`\n  teardown: ${created.length} account(s) removed`);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(failures === 0 ? 'MAP SPACES OK' : `${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
})();
