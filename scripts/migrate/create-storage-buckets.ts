/**
 * Creates the three storage buckets the app uploads to.
 *
 *   npx tsx scripts/migrate/create-storage-buckets.ts
 *
 * Buckets are not part of the SQL schema, so nothing in supabase/migrations
 * ever created them. `src/lib/supabase.ts` has always uploaded to `avatars`,
 * `posts` and `chat`, and all three were absent — which is why images failed
 * to attach in posts, comments, chat and the avatar picker simultaneously.
 *
 * Size limits are set per bucket. Without one Supabase applies the project
 * default, and an oversized upload fails with an opaque error rather than
 * something the UI can explain.
 *
 * Idempotent — existing buckets are updated, not duplicated.
 */

import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config();

const strip = (v?: string) => (v ?? '').trim().replace(/^['"]|['"]$/g, '');
const admin = createClient(
  strip(process.env.VITE_SUPABASE_URL),
  strip(process.env.SUPABASE_SERVICE_ROLE_KEY),
  { auth: { persistSession: false } }
);

const MB = 1024 * 1024;

const BUCKETS = [
  {
    name: 'avatars',
    public: true,
    fileSizeLimit: 5 * MB,
    allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    why: 'Profile photos. Public: they render in feeds, chat and search, and signing every one would mean a round trip per avatar.',
  },
  {
    name: 'posts',
    public: true,
    fileSizeLimit: 25 * MB,
    allowedMimeTypes: [
      'image/png', 'image/jpeg', 'image/webp', 'image/gif',
      'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4',
    ],
    why: 'Post images, voice notes and group photos. Public for the same reason as avatars. Audio types included — voice posts land here too.',
  },
  {
    name: 'chat',
    public: false,
    fileSizeLimit: 25 * MB,
    allowedMimeTypes: [
      'image/png', 'image/jpeg', 'image/webp', 'image/gif',
      'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4',
    ],
    why: 'Chat attachments. PRIVATE — Firebase protected these by unguessable URL, and a public bucket would be strictly weaker. Read through signed URLs.',
  },
];

(async () => {
  console.log('Creating storage buckets\n');

  const { data: existing } = await admin.storage.listBuckets();
  const have = new Set((existing ?? []).map((b) => b.name));

  for (const bucket of BUCKETS) {
    const opts = {
      public: bucket.public,
      fileSizeLimit: bucket.fileSizeLimit,
      allowedMimeTypes: bucket.allowedMimeTypes,
    };

    if (have.has(bucket.name)) {
      const { error } = await admin.storage.updateBucket(bucket.name, opts);
      console.log(error ? `  FAIL  update ${bucket.name} — ${error.message}`
                        : `  ok    updated ${bucket.name}`);
    } else {
      const { error } = await admin.storage.createBucket(bucket.name, opts);
      console.log(error ? `  FAIL  create ${bucket.name} — ${error.message}`
                        : `  ok    created ${bucket.name} (public=${bucket.public}, ${bucket.fileSizeLimit / MB}MB)`);
    }
    console.log(`        ${bucket.why}`);
  }

  const { data: after } = await admin.storage.listBuckets();
  console.log(`\n  buckets now: ${(after ?? []).map((b) => `${b.name}${b.public ? '' : ' (private)'}`).join(', ') || '(none)'}`);
  console.log('\n  Buckets alone are not enough — storage.objects has RLS and no');
  console.log('  policies yet, so uploads will still be denied. Apply');
  console.log('  supabase/migrations/0012_storage_policies.sql next.');
})();
