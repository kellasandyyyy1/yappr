/**
 * Memory Pins, end to end, as real signed-in users.
 *
 *   npx tsx scripts/migrate/test-memory-pins.ts
 *
 * The whole feature is a privacy boundary, so most of this is about who can
 * NOT see a pin. A share that leaks is worse than a share that fails.
 *
 * Covers:
 *   - create a pin with photo, video and song media
 *   - the creator sees it; a stranger does not
 *   - share 1:1 → that person sees it, with media intact
 *   - share into a group → members see it, non-members do not
 *   - a recipient can read but not modify
 *   - nobody can share a pin they do not own, or into a group they are not in
 *   - deleting a pin takes its media and shares with it
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

const PIN_SELECT = `
  id, creator_id, latitude, longitude, caption, created_at,
  pin_media(id, media_type, media_url, youtube_video_id, order_index),
  pin_shares(id, shared_with_user_id, conversation_id)
`;

(async () => {
  console.log(`Memory Pins on ${url}\n`);
  const created: string[] = [];
  const cleanup: Array<() => PromiseLike<unknown>> = [];

  try {
    const stamp = Date.now();
    const mk = async (name: string) => {
      const email = `pin-${name}-${stamp}@privy-test.invalid`;
      const password = 'Corr3ct-Horse-Battery-9!';
      const { data, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { username: `pin${name}${stamp}`.slice(0, 30).toLowerCase(), display_name: name },
      });
      if (error || !data.user) throw new Error(`${name}: ${error?.message}`);
      created.push(data.user.id);
      const client = createClient(url, anonKey, { auth: { persistSession: false } });
      await client.auth.signInWithPassword({ email, password });
      return { id: data.user.id, client, name };
    };

    const alice = await mk('alice');   // creator
    const bob = await mk('bob');       // shared with directly
    const carol = await mk('carol');   // in the shared group
    const dave = await mk('dave');     // no access to anything
    ok('four signed-in users');

    // --- 1. Create ------------------------------------------------------------
    console.log('\n1. Create a pin with media');
    const { data: pin, error: pinErr } = await alice.client
      .from('pins')
      .insert({ creator_id: alice.id, latitude: 51.50722, longitude: -0.1275, caption: 'the bench' })
      .select('id')
      .single();
    if (pinErr) { bad('create pin', `${pinErr.code} ${pinErr.message}`); return; }
    cleanup.push(() => admin.from('pins').delete().eq('id', pin.id));
    ok('create pin', pin.id.slice(0, 8));

    const { error: mediaErr } = await alice.client.from('pin_media').insert([
      { pin_id: pin.id, media_type: 'photo', media_url: 'https://example.test/a.jpg', order_index: 0 },
      { pin_id: pin.id, media_type: 'video', media_url: 'https://example.test/a.mp4', order_index: 1 },
      { pin_id: pin.id, media_type: 'song', youtube_video_id: 'fl66dFTg5-Y', order_index: 2 },
    ]);
    mediaErr ? bad('attach photo, video and song', mediaErr.message) : ok('attach photo, video and song');

    // The check constraint is what stops a row that renders as nothing.
    const { error: badMedia } = await alice.client.from('pin_media')
      .insert({ pin_id: pin.id, media_type: 'song', order_index: 9 });
    badMedia
      ? ok('a song with no youtube id is rejected', badMedia.code)
      : bad('a song with no youtube id is rejected', 'it was accepted');

    const { error: badPhoto } = await alice.client.from('pin_media')
      .insert({ pin_id: pin.id, media_type: 'photo', order_index: 9 });
    badPhoto
      ? ok('a photo with no url is rejected', badPhoto.code)
      : bad('a photo with no url is rejected', 'it was accepted');

    // --- 2. Private by default ------------------------------------------------
    console.log('\n2. Private until shared');
    const seenBy = async (who: { client: any; name: string }) => {
      const { data } = await who.client.from('pins').select(PIN_SELECT).eq('id', pin.id);
      return (data ?? []).length > 0 ? data[0] : null;
    };

    (await seenBy(alice)) ? ok('the creator sees it') : bad('the creator sees it');
    for (const who of [bob, carol, dave]) {
      (await seenBy(who))
        ? bad(`${who.name} cannot see it yet`, 'an unshared pin is visible')
        : ok(`${who.name} cannot see it yet`);
    }

    // --- 3. Share 1:1 ---------------------------------------------------------
    console.log('\n3. Share with one person');
    const { error: shareErr } = await alice.client.from('pin_shares')
      .insert({ pin_id: pin.id, shared_with_user_id: bob.id });
    shareErr ? bad('share with bob', shareErr.message) : ok('share with bob');

    const bobsView = await seenBy(bob);
    if (!bobsView) bad('bob can now see it');
    else {
      ok('bob can now see it');
      bobsView.pin_media?.length === 3
        ? ok('media survives the share', `${bobsView.pin_media.length} items`)
        : bad('media survives the share', `${bobsView.pin_media?.length} items`);
      const song = bobsView.pin_media?.find((m: any) => m.media_type === 'song');
      song?.youtube_video_id === 'fl66dFTg5-Y'
        ? ok('the song id is intact', song.youtube_video_id)
        : bad('the song id is intact', JSON.stringify(song));
      Number(bobsView.latitude) === 51.50722 && Number(bobsView.longitude) === -0.1275
        ? ok('coordinates are intact', `${bobsView.latitude}, ${bobsView.longitude}`)
        : bad('coordinates are intact', `${bobsView.latitude}, ${bobsView.longitude}`);
    }

    (await seenBy(dave)) ? bad('dave still cannot see it') : ok('dave still cannot see it');

    // --- 4. Read-only for recipients -----------------------------------------
    console.log('\n4. Recipients read, they do not write');
    const { error: editErr } = await bob.client.from('pins')
      .update({ caption: 'bob was here' }).eq('id', pin.id).select('id');
    const { data: afterEdit } = await admin.from('pins').select('caption').eq('id', pin.id).single();
    afterEdit?.caption === 'the bench'
      ? ok('bob cannot edit the caption', editErr ? editErr.code : 'update matched no rows')
      : bad('bob cannot edit the caption', `caption is now "${afterEdit?.caption}"`);

    const { error: addErr } = await bob.client.from('pin_media')
      .insert({ pin_id: pin.id, media_type: 'photo', media_url: 'https://example.test/bob.jpg', order_index: 5 });
    addErr
      ? ok('bob cannot attach his own media', addErr.code)
      : bad('bob cannot attach his own media', 'the insert succeeded');

    // --- 5. Share into a group ------------------------------------------------
    console.log('\n5. Share into a group');
    const { data: convo, error: convoErr } = await admin
      .from('conversations').insert({ type: 'group', name: 'pin group', created_by: alice.id })
      .select('id').single();
    if (convoErr) throw new Error(`conversation: ${convoErr.message}`);
    cleanup.push(() => admin.from('conversations').delete().eq('id', convo.id));
    const { error: memberErr } = await admin.from('conversation_members').insert([
      { conversation_id: convo.id, user_id: alice.id, role: 'member' },
      { conversation_id: convo.id, user_id: carol.id, role: 'member' },
    ]);
    if (memberErr) throw new Error(`conversation_members: ${memberErr.message}`);

    const { error: groupShareErr } = await alice.client.from('pin_shares')
      .insert({ pin_id: pin.id, conversation_id: convo.id });
    groupShareErr ? bad('share into the group', groupShareErr.message) : ok('share into the group');

    (await seenBy(carol))
      ? ok('carol sees it through group membership')
      : bad('carol sees it through group membership');
    (await seenBy(dave))
      ? bad('dave is in no group and still cannot see it')
      : ok('dave is in no group and still cannot see it');

    // --- 6. Nobody shares what they do not own -------------------------------
    console.log('\n6. Share authority');
    const { error: hijack } = await bob.client.from('pin_shares')
      .insert({ pin_id: pin.id, shared_with_user_id: dave.id });
    hijack
      ? ok('bob cannot re-share a pin he does not own', hijack.code)
      : bad('bob cannot re-share a pin he does not own', 'the insert succeeded');

    const { data: outsideConvo } = await admin
      .from('conversations').insert({ type: 'group', name: 'not alices', created_by: dave.id })
      .select('id').single();
    cleanup.push(() => admin.from('conversations').delete().eq('id', outsideConvo!.id));
    await admin.from('conversation_members')
      .insert({ conversation_id: outsideConvo!.id, user_id: dave.id, role: 'member' });

    const { error: pushErr } = await alice.client.from('pin_shares')
      .insert({ pin_id: pin.id, conversation_id: outsideConvo!.id });
    pushErr
      ? ok('a pin cannot be pushed into a group the sharer is not in', pushErr.code)
      : bad('a pin cannot be pushed into a group the sharer is not in', 'the insert succeeded');

    // Both targets at once, or neither, is a malformed share.
    const { error: bothErr } = await alice.client.from('pin_shares')
      .insert({ pin_id: pin.id, shared_with_user_id: bob.id, conversation_id: convo.id });
    bothErr ? ok('a share cannot target a person AND a group', bothErr.code)
            : bad('a share cannot target a person AND a group');

    // --- 7. Delete cascades ---------------------------------------------------
    console.log('\n7. Delete');
    const { error: delErr } = await alice.client.from('pins').delete().eq('id', pin.id);
    delErr ? bad('creator deletes the pin', delErr.message) : ok('creator deletes the pin');

    const { count: mediaLeft } = await admin
      .from('pin_media').select('id', { count: 'exact', head: true }).eq('pin_id', pin.id);
    const { count: sharesLeft } = await admin
      .from('pin_shares').select('id', { count: 'exact', head: true }).eq('pin_id', pin.id);
    (mediaLeft ?? 0) === 0 && (sharesLeft ?? 0) === 0
      ? ok('media and shares cascade away', `${mediaLeft} media, ${sharesLeft} shares`)
      : bad('media and shares cascade away', `${mediaLeft} media, ${sharesLeft} shares left`);
  } catch (err) {
    bad('harness', (err as Error).message);
  } finally {
    for (const fn of cleanup.reverse()) await Promise.resolve(fn()).catch(() => {});
    for (const id of created) await admin.auth.admin.deleteUser(id).catch(() => {});
    console.log(`\n  teardown: ${created.length} account(s) removed`);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(failures === 0 ? 'MEMORY PINS OK' : `${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
})();
