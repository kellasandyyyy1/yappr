/**
 * Video upload and playback, end to end, with a real file.
 *
 *   npx tsx scripts/migrate/test-video.ts
 *
 * Uses a genuine 9.7MB H.264 MP4, not a stub: a few bytes with an .mp4 name
 * would pass every check here and still be unplayable, and would never exercise
 * the bucket's size limit or a multi-second upload.
 *
 * The fixture is downloaded once to the scratch dir on first run.
 *
 * Covers, as a real signed-in user rather than the service role:
 *   - the two video buckets exist with the right limits and MIME types
 *   - a post video uploads, is publicly readable, and comes back as video/mp4
 *   - a chat video uploads to the PRIVATE bucket and is NOT publicly readable
 *   - a non-participant cannot read another conversation's video
 *   - posts.type='video' and messages.type='video' round-trip with their URLs
 *   - an oversized file is refused by the bucket
 */

import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config();

const strip = (v?: string) => (v ?? '').trim().replace(/^['"]|['"]$/g, '');
const url = strip(process.env.VITE_SUPABASE_URL);
const anonKey = strip(process.env.VITE_SUPABASE_ANON_KEY);
const serviceKey = strip(process.env.SUPABASE_SERVICE_ROLE_KEY);
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

const FIXTURE_URL =
  'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_10MB.mp4';
const FIXTURE = path.join(
  process.env.TEMP || '/tmp',
  'claude', 'privy-video-fixture', 'sample-10mb.mp4'
);

let failures = 0;
const ok = (l: string, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l: string, d = '') => { console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures++; };

const MB = 1024 * 1024;

async function fixture(): Promise<Buffer> {
  if (fs.existsSync(FIXTURE)) return fs.readFileSync(FIXTURE);
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  console.log('  (downloading the test video once…)');
  const res = await fetch(FIXTURE_URL);
  if (!res.ok) throw new Error(`fixture download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(FIXTURE, buf);
  return buf;
}

(async () => {
  console.log(`Video end-to-end on ${url}\n`);
  const created: string[] = [];
  const cleanup: Array<() => PromiseLike<unknown>> = [];

  try {
    const video = await fixture();
    const isRealMp4 = video.slice(4, 8).toString('latin1') === 'ftyp';
    isRealMp4
      ? ok('fixture is a real MP4', `${(video.length / MB).toFixed(1)}MB, ftyp${video.slice(8, 12).toString('latin1')}`)
      : bad('fixture is a real MP4', 'no ftyp box — not a usable test');

    // --- 1. Buckets ----------------------------------------------------------
    console.log('\n1. Buckets');
    const { data: buckets } = await admin.storage.listBuckets();
    for (const [name, wantPublic] of [['post-videos', true], ['chat-videos', false]] as const) {
      const b: any = (buckets ?? []).find((x) => x.name === name);
      if (!b) { bad(`${name} exists`); continue; }
      const limit = Number(b.file_size_limit ?? b.fileSizeLimit ?? 0);
      const mimes: string[] = b.allowed_mime_types ?? b.allowedMimeTypes ?? [];
      b.public === wantPublic
        ? ok(`${name} public=${wantPublic}`)
        : bad(`${name} public=${wantPublic}`, `got ${b.public}`);
      limit >= 50 * MB
        ? ok(`${name} allows large files`, `${(limit / MB).toFixed(0)}MB`)
        : bad(`${name} allows large files`, `${(limit / MB).toFixed(0)}MB`);
      ['video/mp4', 'video/webm', 'video/quicktime'].every((m) => mimes.includes(m))
        ? ok(`${name} accepts mp4/webm/quicktime`)
        : bad(`${name} accepts mp4/webm/quicktime`, JSON.stringify(mimes));
    }

    // --- 2. Two signed-in users, one conversation ----------------------------
    const stamp = Date.now();
    const mk = async (name: string) => {
      const email = `vid-${name}-${stamp}@privy-test.invalid`;
      const password = 'Corr3ct-Horse-Battery-9!';
      const { data, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { username: `vid${name}${stamp}`.slice(0, 30).toLowerCase(), display_name: name },
      });
      if (error || !data.user) throw new Error(`${name}: ${error?.message}`);
      created.push(data.user.id);
      const client = createClient(url, anonKey, { auth: { persistSession: false } });
      await client.auth.signInWithPassword({ email, password });
      return { id: data.user.id, client };
    };

    const alice = await mk('alice');
    const bob = await mk('bob');
    const carol = await mk('carol'); // deliberately outside the conversation

    // --- 3. Post video -------------------------------------------------------
    console.log('\n2. Post video (public bucket)');
    const postPath = `${alice.id}/${stamp}.mp4`;
    const upload = await alice.client.storage
      .from('post-videos')
      .upload(postPath, video, { contentType: 'video/mp4', upsert: true });
    if (upload.error) {
      bad('upload to post-videos', upload.error.message);
    } else {
      ok('upload to post-videos', `${(video.length / MB).toFixed(1)}MB`);
      cleanup.push(() => admin.storage.from('post-videos').remove([postPath]));

      const publicUrl = alice.client.storage.from('post-videos').getPublicUrl(postPath).data.publicUrl;
      const head = await fetch(publicUrl, { method: 'HEAD' });
      const type = head.headers.get('content-type') ?? '';
      const bytes = Number(head.headers.get('content-length') ?? 0);
      head.ok && type.startsWith('video/')
        ? ok('publicly readable as video', `${head.status} ${type}, ${(bytes / MB).toFixed(1)}MB`)
        : bad('publicly readable as video', `${head.status} ${type}`);

      // Range support is what makes seeking work; without it the scrub bar can
      // only replay from the start.
      const ranged = await fetch(publicUrl, { headers: { Range: 'bytes=0-1023' } });
      ranged.status === 206
        ? ok('supports range requests, so seeking works', `206, ${ranged.headers.get('content-range')}`)
        : bad('supports range requests, so seeking works', `got ${ranged.status}`);
    }

    // --- 4. Chat video -------------------------------------------------------
    console.log('\n3. Chat video (private bucket)');
    const { data: convo, error: convoErr } = await admin
      .from('conversations').insert({ type: 'direct', created_by: alice.id })
      .select('id').single();
    if (convoErr) throw new Error(`conversation: ${convoErr.message}`);
    cleanup.push(() => admin.from('conversations').delete().eq('id', convo.id));

    // conversation_MEMBERS, with a role. The first version of this used
    // `conversation_participants` and ignored the error, so alice was never
    // actually a member — and every chat-video check failed with an RLS
    // violation that looked like a broken policy rather than a broken test.
    const { error: memberErr } = await admin.from('conversation_members').insert([
      { conversation_id: convo.id, user_id: alice.id, role: 'member' },
      { conversation_id: convo.id, user_id: bob.id, role: 'member' },
    ]);
    if (memberErr) throw new Error(`conversation_members: ${memberErr.message}`);
    ok('conversation with two members');

    const chatPath = `${convo.id}/${alice.id}-${stamp}.mp4`;
    const chatUpload = await alice.client.storage
      .from('chat-videos')
      .upload(chatPath, video, { contentType: 'video/mp4', upsert: true });
    if (chatUpload.error) {
      bad('upload to chat-videos', chatUpload.error.message);
    } else {
      ok('participant can upload to chat-videos');
      cleanup.push(() => admin.storage.from('chat-videos').remove([chatPath]));

      const signed = await bob.client.storage.from('chat-videos').createSignedUrl(chatPath, 60);
      if (signed.error) bad('the other participant can sign a URL', signed.error.message);
      else {
        const head = await fetch(signed.data.signedUrl, { method: 'HEAD' });
        head.ok
          ? ok('the other participant can play it', `${head.status} ${head.headers.get('content-type')}`)
          : bad('the other participant can play it', String(head.status));
      }

      // The whole point of the private bucket.
      const publicAttempt = await fetch(
        `${url}/storage/v1/object/public/chat-videos/${chatPath}`, { method: 'HEAD' });
      publicAttempt.ok
        ? bad('chat video is NOT publicly readable', `${publicAttempt.status} — anyone with the path can watch it`)
        : ok('chat video is NOT publicly readable', String(publicAttempt.status));

      const outsider = await carol.client.storage.from('chat-videos').createSignedUrl(chatPath, 60);
      outsider.error
        ? ok('a non-participant cannot sign a URL', outsider.error.message.slice(0, 50))
        : bad('a non-participant cannot sign a URL', 'signing succeeded');
    }

    // --- 5. Rows -------------------------------------------------------------
    console.log('\n4. Schema round-trip');
    const publicUrl = alice.client.storage.from('post-videos').getPublicUrl(postPath).data.publicUrl;

    const { data: post, error: postErr } = await alice.client
      .from('posts')
      .insert({
        user_id: alice.id, content: 'video post', type: 'video', visibility: 'public',
        video_url: publicUrl, video_poster_url: publicUrl.replace('.mp4', '.poster.jpg'),
      })
      .select('id, type, video_url, video_poster_url').single();
    if (postErr) {
      bad('post with type=video', `${postErr.code} ${postErr.message.split('\n')[0]}`);
    } else {
      cleanup.push(() => admin.from('posts').delete().eq('id', post.id));
      post.type === 'video' && post.video_url === publicUrl
        ? ok('post with type=video round-trips', post.id.slice(0, 8))
        : bad('post with type=video round-trips', JSON.stringify(post));
    }

    const { data: message, error: msgErr } = await alice.client
      .from('messages')
      .insert({
        conversation_id: convo.id, sender_id: alice.id, content: 'Sent a video',
        type: 'video',
        video_url: `supabase://chat-videos/${chatPath}`,
        video_poster_url: `supabase://chat-videos/${chatPath}.poster.jpg`,
      })
      .select('id, type, video_url').single();
    if (msgErr) {
      bad('message with type=video', `${msgErr.code} ${msgErr.message.split('\n')[0]}`);
    } else {
      message.type === 'video' && String(message.video_url).startsWith('supabase://chat-videos/')
        ? ok('message with type=video round-trips', 'stored as the supabase:// form')
        : bad('message with type=video round-trips', JSON.stringify(message));
    }

    // --- 6. The size limit is real -------------------------------------------
    console.log('\n5. Limits');
    const oversized = Buffer.concat([video, Buffer.alloc(45 * MB)]); // ~55MB
    const tooBig = await alice.client.storage
      .from('post-videos')
      .upload(`${alice.id}/${stamp}-oversized.mp4`, oversized, { contentType: 'video/mp4' });
    tooBig.error
      ? ok('a 55MB upload is refused', tooBig.error.message.slice(0, 60))
      : bad('a 55MB upload is refused', 'it was accepted — the bucket limit is not applying');

    const wrongType = await alice.client.storage
      .from('post-videos')
      .upload(`${alice.id}/${stamp}.txt`, Buffer.from('not a video'), { contentType: 'text/plain' });
    wrongType.error
      ? ok('a non-video MIME type is refused', wrongType.error.message.slice(0, 60))
      : bad('a non-video MIME type is refused', 'it was accepted');
  } catch (err) {
    bad('harness', (err as Error).message);
  } finally {
    // Promise.resolve first: a PostgrestFilterBuilder is thenable but has no
    // .catch until it has been awaited, so calling .catch on it throws.
    for (const fn of cleanup.reverse()) await Promise.resolve(fn()).catch(() => {});
    for (const id of created) await admin.auth.admin.deleteUser(id).catch(() => {});
    console.log(`\n  teardown: ${created.length} account(s) and ${cleanup.length} object(s) removed`);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(failures === 0 ? 'VIDEO OK' : `${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
})();
