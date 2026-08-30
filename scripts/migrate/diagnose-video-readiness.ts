/**
 * What already exists for video, before anything is built.
 *
 *   npx tsx scripts/migrate/diagnose-video-readiness.ts
 *
 * Checks the live project rather than assuming the image/voice setup covers
 * video: bucket presence, size limits, allowed MIME types, and whether the
 * posts/messages tables can even represent a video.
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

const sql = async (q: string) => {
  const res = await fetch(`${url}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ q }),
  });
  return res.ok ? res.json() : null;
};

(async () => {
  console.log(`Video readiness on ${url}\n`);

  // --- 1. Buckets ------------------------------------------------------------
  console.log('1. Storage buckets');
  const { data: buckets, error } = await admin.storage.listBuckets();
  if (error) {
    console.log(`   FAILED: ${error.message}`);
  } else {
    for (const b of buckets ?? []) {
      const anyB = b as any;
      const limit = anyB.file_size_limit ?? anyB.fileSizeLimit;
      const mimes = anyB.allowed_mime_types ?? anyB.allowedMimeTypes;
      console.log(
        `   ${b.name.padEnd(14)} public=${String(b.public).padEnd(5)} ` +
        `limit=${limit ? `${(Number(limit) / 1024 / 1024).toFixed(0)}MB` : 'none'} ` +
        `mime=${mimes ? JSON.stringify(mimes) : 'any'}`
      );
    }
    const names = (buckets ?? []).map((b) => b.name);
    for (const want of ['post-videos', 'chat-videos']) {
      console.log(`   ${names.includes(want) ? 'EXISTS  ' : 'MISSING '} ${want}`);
    }
  }

  // --- 2. Can a video be stored on a post or message? ------------------------
  console.log('\n2. Schema');
  const { data: post, error: pErr } = await admin.from('posts').select('*').limit(1);
  if (pErr) console.log(`   posts: ${pErr.message}`);
  else {
    const cols = post?.[0] ? Object.keys(post[0]) : [];
    console.log(`   posts columns: ${cols.join(', ') || '(no rows to sample)'}`);
    console.log(`   posts.video_url  -> ${cols.includes('video_url') ? 'EXISTS' : 'MISSING'}`);
  }

  const { data: msg, error: mErr } = await admin.from('messages').select('*').limit(1);
  if (mErr) console.log(`   messages: ${mErr.message}`);
  else {
    const cols = msg?.[0] ? Object.keys(msg[0]) : [];
    console.log(`   messages columns: ${cols.join(', ') || '(no rows to sample)'}`);
    console.log(`   messages.video_url -> ${cols.includes('video_url') ? 'EXISTS' : 'MISSING'}`);
  }

  // --- 3. Does the type column accept 'video'? -------------------------------
  console.log('\n3. Does `type` accept "video"?');
  for (const table of ['posts', 'messages']) {
    const probe = await admin.from(table).insert({ type: 'video' } as any).select('id');
    const m = probe.error?.message ?? '';
    if (/violates check constraint|invalid input value/i.test(m)) {
      console.log(`   ${table}: REJECTED — ${m.split('\n')[0].slice(0, 110)}`);
    } else if (/null value|not-null|violates foreign key/i.test(m)) {
      console.log(`   ${table}: type='video' passed the check; blocked later by ${m.split('\n')[0].slice(0, 70)}`);
    } else {
      console.log(`   ${table}: ${m ? m.slice(0, 110) : 'INSERTED (cleaning up)'}`);
      if (!m && probe.data?.[0]) await admin.from(table).delete().eq('id', probe.data[0].id);
    }
  }

  console.log('\n' + '─'.repeat(60));
})();
