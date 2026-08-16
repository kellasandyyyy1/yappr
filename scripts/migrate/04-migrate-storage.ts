/**
 * Step 4 — Copy files from Firebase Storage to Supabase Storage and rewrite
 * every URL stored in the database.
 *
 *   npx tsx scripts/migrate/04-migrate-storage.ts [--dry-run]
 *
 * Env: GOOGLE_APPLICATION_CREDENTIALS, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Run this AFTER 03-import-supabase.ts: it updates rows that must already
 * exist. Re-runnable — files already present are skipped.
 */

import admin from 'firebase-admin';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { ensureDirs, readJson, DATA_DIR, IssueLog, chunk } from './shared';
import { firebaseConfig, supabaseConfig } from './config';

const DRY_RUN = process.argv.includes('--dry-run');
const config = firebaseConfig();
const { url: SUPABASE_URL, serviceKey: SERVICE_KEY } = supabaseConfig();

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: config.projectId,
    storageBucket: config.storageBucket,
  });
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const issues = new IssueLog();

/**
 * Bucket layout mirrors the Firestore folder structure but splits by access
 * level, which Firebase Storage rules did in code and Supabase does per bucket.
 *
 *   avatars  — public read (they appear next to every post)
 *   posts    — public read (subject to post visibility at the row level)
 *   chat     — PRIVATE. Message images must not be world-readable by URL.
 *
 * NOTE: Firebase Storage download URLs contain an unguessable token, so chat
 * images were effectively "secret link" protected. A public Supabase bucket
 * would be strictly weaker, so chat media goes to a private bucket served
 * through signed URLs.
 */
const BUCKETS = [
  { name: 'avatars', public: true },
  { name: 'posts', public: true },
  { name: 'chat', public: false },
] as const;

function bucketForPath(objectPath: string): string {
  if (objectPath.startsWith('avatars/')) return 'avatars';
  if (objectPath.startsWith('posts/')) return 'posts';
  if (objectPath.startsWith('chat/') || objectPath.startsWith('messages/')) return 'chat';
  return 'posts';
}

/** Extracts the storage object path out of a Firebase download URL. */
function objectPathFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'firebasestorage.googleapis.com') {
      // /v0/b/<bucket>/o/<url-encoded-path>?alt=media&token=...
      const match = parsed.pathname.match(/\/o\/(.+)$/);
      return match ? decodeURIComponent(match[1]) : null;
    }
    if (parsed.hostname === 'storage.googleapis.com') {
      return parsed.pathname.replace(/^\/[^/]+\//, '');
    }
    return null;
  } catch {
    return null;
  }
}

async function ensureBuckets() {
  for (const bucket of BUCKETS) {
    if (DRY_RUN) continue;
    const { error } = await supabase.storage.createBucket(bucket.name, {
      public: bucket.public,
      fileSizeLimit: 20 * 1024 * 1024,
    });
    if (error && !/already exists/i.test(error.message)) {
      console.log(`  bucket ${bucket.name}: ${error.message}`);
    } else {
      console.log(`  bucket ${bucket.name} ready (${bucket.public ? 'public' : 'private'})`);
    }
  }
}

const urlCache = new Map<string, string>();

/** Downloads one object from Firebase and uploads it to Supabase. */
async function transferFile(firebaseUrl: string): Promise<string | null> {
  const cached = urlCache.get(firebaseUrl);
  if (cached) return cached;

  const objectPath = objectPathFromUrl(firebaseUrl);
  if (!objectPath) {
    // Already a Supabase URL, a YouTube thumbnail, or a data: URI — leave it.
    return null;
  }

  const bucket = bucketForPath(objectPath);

  try {
    const file = admin.storage().bucket(config.storageBucket).file(objectPath);
    const [exists] = await file.exists();
    if (!exists) {
      issues.warn(objectPath, 'Referenced file does not exist in Firebase Storage; URL left unchanged', { firebaseUrl });
      return null;
    }

    if (DRY_RUN) return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${objectPath}`;

    const [buffer] = await file.download();
    const [metadata] = await file.getMetadata();

    const { error } = await supabase.storage.from(bucket).upload(objectPath, buffer, {
      contentType: metadata.contentType || 'application/octet-stream',
      upsert: true,
    });
    if (error) {
      issues.error(objectPath, `Upload to Supabase failed: ${error.message}`, { firebaseUrl });
      return null;
    }

    const { data } = supabase.storage.from(bucket).getPublicUrl(objectPath);
    // Private buckets have no usable public URL; store the object path and let
    // the client mint a signed URL at read time.
    const newUrl = BUCKETS.find((b) => b.name === bucket)!.public
      ? data.publicUrl
      : `supabase://${bucket}/${objectPath}`;

    urlCache.set(firebaseUrl, newUrl);
    return newUrl;
  } catch (err) {
    issues.error(objectPath, `Transfer failed: ${(err as Error).message}`, { firebaseUrl });
    return null;
  }
}

/** Rewrites one URL column across a table. */
async function rewriteColumn(table: string, column: string, idColumn = 'id') {
  const { data: rows, error } = await supabase
    .from(table)
    .select(`${idColumn}, ${column}`)
    .not(column, 'is', null);

  if (error) { console.log(`  ${table}.${column}: query failed — ${error.message}`); return; }
  if (!rows || rows.length === 0) { console.log(`  ${table}.${column}: nothing to rewrite`); return; }

  let rewritten = 0, skipped = 0;
  for (const row of rows as any[]) {
    const oldUrl = row[column];
    if (typeof oldUrl !== 'string' || !oldUrl.includes('firebasestorage')) { skipped++; continue; }

    const newUrl = await transferFile(oldUrl);
    if (!newUrl) { skipped++; continue; }

    if (!DRY_RUN) {
      const { error: updateError } = await supabase
        .from(table).update({ [column]: newUrl }).eq(idColumn, row[idColumn]);
      if (updateError) {
        issues.error(`${table}/${row[idColumn]}`, `URL update failed: ${updateError.message}`, null, table);
        continue;
      }
    }
    rewritten++;
    if (rewritten % 20 === 0) process.stdout.write(`\r  ${table}.${column}: ${rewritten} rewritten…`);
  }
  process.stdout.write('\r');
  console.log(`  ${table.padEnd(18)}.${column.padEnd(12)} ${String(rewritten).padStart(5)} rewritten, ${skipped} skipped`);
}

/** post_images has a composite key, so it needs its own pass. */
async function rewritePostImages() {
  const { data: rows, error } = await supabase.from('post_images').select('post_id, position, url');
  if (error || !rows) { console.log(`  post_images: ${error?.message ?? 'no rows'}`); return; }

  let rewritten = 0;
  for (const row of rows as any[]) {
    if (typeof row.url !== 'string' || !row.url.includes('firebasestorage')) continue;
    const newUrl = await transferFile(row.url);
    if (!newUrl) continue;
    if (!DRY_RUN) {
      await supabase.from('post_images').update({ url: newUrl })
        .eq('post_id', row.post_id).eq('position', row.position);
    }
    rewritten++;
  }
  console.log(`  post_images       .url          ${String(rewritten).padStart(5)} rewritten`);
}

async function main() {
  ensureDirs();
  console.log(`Migrating storage: ${config.storageBucket} → ${SUPABASE_URL}`);
  if (DRY_RUN) console.log('DRY RUN — no uploads, no updates.\n');

  console.log('\nBuckets:');
  await ensureBuckets();

  console.log('\nRewriting URL references:');
  await rewriteColumn('users', 'photo_url');
  await rewriteColumn('posts', 'voice_url');
  await rewritePostImages();
  await rewriteColumn('comments', 'image_url');
  await rewriteColumn('comments', 'voice_url');
  await rewriteColumn('messages', 'image_url');
  await rewriteColumn('messages', 'voice_url');
  await rewriteColumn('conversations', 'photo_url');
  // songs.cover_url points at img.youtube.com, not Firebase — intentionally skipped.

  console.log('\nIssues:');
  issues.report('storage');
  issues.save(path.join(DATA_DIR, 'issues-storage.json'));
  console.log(`\n${urlCache.size} unique files transferred.`);
}

main().catch((err) => { console.error('\nStorage migration failed:', err); process.exit(1); });
