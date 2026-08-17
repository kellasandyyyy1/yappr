/**
 * Checks that image/audio uploads can actually work.
 *
 *   npx tsx scripts/migrate/diagnose-storage.ts
 *
 * src/lib/supabase.ts uploads to three buckets — `avatars`, `posts`, `chat` —
 * but nothing in the migrations ever created them, and buckets are not part of
 * the SQL schema. If they are absent every upload fails identically in
 * CreatePostModal, CommentsModal, ChatView and the avatar picker.
 *
 * Tests as a real signed-in user, not the service role, because the service
 * role bypasses storage RLS and would report success on a bucket no user can
 * actually write to.
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

const REQUIRED = [
  { name: 'avatars', public: true, why: 'profile photos, rendered everywhere' },
  { name: 'posts', public: true, why: 'post images, voice notes, group photos' },
  { name: 'chat', public: false, why: 'chat attachments — private, served via signed URLs' },
];

let failures = 0;
const ok = (l: string, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l: string, d = '') => { console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures++; };

(async () => {
  console.log(`Storage diagnosis on ${url}\n`);

  // --- Which buckets exist? ---------------------------------------------------
  console.log('Buckets:');
  const { data: buckets, error: listErr } = await admin.storage.listBuckets();
  if (listErr) { bad('list buckets', listErr.message); process.exit(1); }

  const existing = new Map((buckets ?? []).map((b) => [b.name, b]));
  console.log(`        found: ${existing.size ? [...existing.keys()].join(', ') : '(none)'}`);

  for (const want of REQUIRED) {
    const got = existing.get(want.name);
    if (!got) {
      bad(`bucket "${want.name}"`, `MISSING — ${want.why}`);
      continue;
    }
    got.public === want.public
      ? ok(`bucket "${want.name}"`, `public=${got.public}`)
      : bad(`bucket "${want.name}"`, `public=${got.public}, expected ${want.public}`);
  }

  if (failures > 0) {
    console.log('\n  Missing buckets explain uploads failing in every screen at once.');
  }

  // --- Can a real user upload? -----------------------------------------------
  console.log('\nUpload as a signed-in user:');
  const stamp = Date.now();
  const email = `storage-${stamp}@privy-test.invalid`;
  const password = 'Corr3ct-Horse-Battery-9!';

  const { data: made, error: makeErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { username: `storage${stamp}`.slice(0, 30), display_name: 'Storage Test' },
  });
  if (makeErr || !made.user) { bad('create test user', makeErr?.message); process.exit(1); }
  const userId = made.user.id;

  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password });
  if (signInErr) { bad('sign in', signInErr.message); }

  // A one-pixel PNG.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );

  for (const want of REQUIRED) {
    if (!existing.has(want.name)) {
      console.log(`  SKIP  upload to "${want.name}" — bucket does not exist`);
      continue;
    }
    const objectPath = `${userId}/${stamp}-probe.png`;
    const { error: upErr } = await client.storage
      .from(want.name)
      .upload(objectPath, png, { contentType: 'image/png', upsert: true });

    if (upErr) {
      bad(`upload to "${want.name}"`, upErr.message);
    } else {
      ok(`upload to "${want.name}"`, objectPath);
      // Can it be read back the way the app reads it?
      if (want.public) {
        const publicUrl = client.storage.from(want.name).getPublicUrl(objectPath).data.publicUrl;
        const res = await fetch(publicUrl);
        res.ok ? ok(`  public read "${want.name}"`, `${res.status}`)
               : bad(`  public read "${want.name}"`, `${res.status}`);
      } else {
        const { data: signed, error: signErr } = await client.storage
          .from(want.name).createSignedUrl(objectPath, 60);
        if (signErr || !signed) bad(`  signed URL "${want.name}"`, signErr?.message);
        else {
          const res = await fetch(signed.signedUrl);
          res.ok ? ok(`  signed read "${want.name}"`, `${res.status}`)
                 : bad(`  signed read "${want.name}"`, `${res.status}`);
        }
      }
      await admin.storage.from(want.name).remove([objectPath]).catch(() => {});
    }
  }

  await admin.auth.admin.deleteUser(userId).catch(() => {});
  console.log('\n  teardown: test account removed');

  console.log('\n' + '─'.repeat(60));
  console.log(failures === 0 ? 'STORAGE OK' : `${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
})();
