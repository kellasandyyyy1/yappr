/**
 * Creates the two video storage buckets.
 *
 *   npx tsx scripts/migrate/create-video-buckets.ts
 *
 * Buckets are not part of the SQL schema, so no migration creates them.
 *
 * The existing `posts` and `chat` buckets CANNOT hold video: both cap at 25MB
 * and both restrict MIME types to image/* and audio/* only, so an upload would
 * be rejected at the bucket before any policy was consulted. Verified against
 * the live project rather than assumed — see diagnose-video-readiness.ts.
 *
 * Two buckets, not one, because their read semantics are incompatible: a public
 * bucket bypasses RLS for reads entirely, so chat video in a public bucket would
 * be readable by anyone who guessed a path. See 0014_video_storage_policies.sql.
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

/**
 * 50MB — and that is a ceiling, not a choice.
 *
 * Supabase enforces a PROJECT-level upload limit above every bucket. Probed
 * against this project: 60MB, 80MB and 100MB were all rejected at bucket
 * creation with "The object exceeded the maximum allowed size"; 50MB was
 * accepted. Raising it is a dashboard/plan change (Settings -> Storage ->
 * upload file size limit), not something this script can do.
 *
 * The client rejects an oversized file first, naming the actual size, because
 * a bucket rejection surfaces as an opaque 413. This limit is the backstop.
 */
const VIDEO_LIMIT = 50 * MB;

/**
 * quicktime is what an iPhone produces (.mov). Leaving it out would mean video
 * silently failing for every iOS user while working fine on Android.
 * image/jpeg is here because the poster frame lives beside the video.
 */
const VIDEO_MIME = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'image/jpeg',
];

const BUCKETS = [
  {
    name: 'post-videos',
    public: true,
    fileSizeLimit: VIDEO_LIMIT,
    allowedMimeTypes: VIDEO_MIME,
    why: 'Videos attached to posts. Public, like the `posts` bucket: the feed renders them for every viewer and signing each one would be a round trip per video.',
  },
  {
    name: 'chat-videos',
    public: false,
    fileSizeLimit: VIDEO_LIMIT,
    allowedMimeTypes: VIDEO_MIME,
    why: 'Videos sent in conversations. PRIVATE: a public bucket serves /object/public/<path> with no auth, which would expose every chat video to anyone who guessed a path regardless of RLS.',
  },
];

(async () => {
  console.log('Video buckets\n');

  const { data: existing, error: listErr } = await admin.storage.listBuckets();
  if (listErr) {
    console.error(`Could not list buckets: ${listErr.message}`);
    process.exit(1);
  }
  const names = new Set((existing ?? []).map((b) => b.name));

  for (const bucket of BUCKETS) {
    const { name, why, ...options } = bucket;
    const action = names.has(name) ? 'update' : 'create';

    const { error } =
      action === 'create'
        ? await admin.storage.createBucket(name, options)
        : await admin.storage.updateBucket(name, options);

    if (error) {
      console.log(`  FAIL  ${name} — ${error.message}`);
      process.exitCode = 1;
    } else {
      console.log(`  ${action === 'create' ? 'CREATED' : 'UPDATED'}  ${name}`);
      console.log(`          public=${options.public}  limit=${options.fileSizeLimit / MB}MB`);
      console.log(`          ${why}`);
    }
  }

  // Read back rather than trusting the write.
  console.log('\nVerifying:');
  const { data: after } = await admin.storage.listBuckets();
  for (const bucket of BUCKETS) {
    const found: any = (after ?? []).find((b) => b.name === bucket.name);
    if (!found) {
      console.log(`  FAIL  ${bucket.name} is still absent`);
      process.exitCode = 1;
      continue;
    }
    const limit = found.file_size_limit ?? found.fileSizeLimit;
    const mimes = found.allowed_mime_types ?? found.allowedMimeTypes ?? [];
    const okPublic = found.public === bucket.public;
    const okLimit = Number(limit) === bucket.fileSizeLimit;
    const okMime = bucket.allowedMimeTypes.every((m) => mimes.includes(m));
    console.log(
      `  ${okPublic && okLimit && okMime ? 'OK  ' : 'BAD '}  ${bucket.name} ` +
      `public=${found.public} limit=${(Number(limit) / MB).toFixed(0)}MB mime=${mimes.length} types`
    );
    if (!okPublic || !okLimit || !okMime) process.exitCode = 1;
  }
})();
