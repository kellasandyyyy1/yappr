/**
 * Why does the theme-song player sit on "Warming up the player…"?
 *
 *   npx tsx scripts/migrate/diagnose-music-playback.ts
 *
 * That toast is raised by ThemeSongCard.togglePlay when playerRef.current is
 * still null — i.e. the IFrame API never fired onReady. This checks everything
 * that can cause that from outside the browser:
 *
 *   1. Is the IFrame API script itself reachable?
 *   2. Are the video IDs we actually stored real, and still embeddable?
 *   3. Does the embed page load for our origin?
 *
 * A video whose owner disabled embedding, or that was pulled, never reaches
 * onReady — the iframe renders an error screen instead — which is exactly the
 * stuck state being reported.
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

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

(async () => {
  console.log('Theme-song playback diagnosis\n');

  // --- 1. The API script -----------------------------------------------------
  console.log('1. YouTube IFrame API reachability');
  for (const target of [
    'https://www.youtube.com/iframe_api',
    'https://s.ytimg.com/yts/jsbin/www-widgetapi.js',
  ]) {
    try {
      const res = await fetch(target, { headers: { 'user-agent': UA } });
      const body = target.endsWith('iframe_api') ? await res.text() : '';
      console.log(`   ${res.status}  ${target}`);
      if (body) {
        const m = body.match(/https:\\?\/\\?\/[^"']*widgetapi[^"']*/);
        console.log(`        loader points at: ${m ? m[0].replace(/\\/g, '') : '(not found)'}`);
      }
    } catch (err) {
      console.log(`   ERR  ${target} — ${(err as Error).message}`);
    }
  }

  // --- 2. What is actually stored --------------------------------------------
  console.log('\n2. Stored theme songs');
  const { data: songs, error } = await admin
    .from('songs')
    .select('youtube_id, title, artist')
    .limit(50);

  if (error) {
    console.log(`   query failed: ${error.code} ${error.message}`);
  } else if (!songs?.length) {
    console.log('   none — no song rows exist, so nothing can play.');
  } else {
    console.log(`   ${songs.length} row(s)\n`);

    for (const s of songs) {
      const id = (s as any).youtube_id as string;
      const label = `${id}  "${(s as any).title}"`;

      const shapeOk = /^[\w-]{11}$/.test(id ?? '');
      if (!shapeOk) {
        console.log(`   BAD ID   ${label} — not an 11-char video id`);
        continue;
      }

      // oEmbed is the cheapest authoritative answer: 200 = public and
      // embeddable, 401 = embedding disabled, 404 = gone/private.
      let verdict = '';
      try {
        const res = await fetch(
          `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`,
          { headers: { 'user-agent': UA } }
        );
        verdict =
          res.status === 200 ? 'embeddable'
          : res.status === 401 ? 'EMBEDDING DISABLED by owner'
          : res.status === 404 ? 'NOT FOUND / private / removed'
          : `unexpected ${res.status}`;
      } catch (err) {
        verdict = `fetch failed — ${(err as Error).message}`;
      }

      // The embed page itself is what the iframe loads. A non-200 here means
      // onReady can never fire.
      let embedStatus: string;
      try {
        const res = await fetch(`https://www.youtube.com/embed/${id}`, {
          headers: { 'user-agent': UA },
        });
        const html = await res.text();
        const blocked = /UNPLAYABLE|Video unavailable|playabilityStatus".{0,40}"ERROR/i.test(html);
        embedStatus = `${res.status}${blocked ? ' (page says UNPLAYABLE)' : ''}`;
      } catch (err) {
        embedStatus = `ERR ${(err as Error).message}`;
      }

      console.log(`   ${verdict === 'embeddable' ? 'OK  ' : 'FAIL'}     ${label}`);
      console.log(`              oembed: ${verdict}   |   /embed/: ${embedStatus}`);
    }
  }

  // --- 3. Which users have one set -------------------------------------------
  console.log('\n3. Profiles with a theme song set');
  const { data: profiles, error: pErr } = await admin
    .from('users')
    .select('username, theme_song_id')
    .not('theme_song_id', 'is', null)
    .limit(20);
  if (pErr) console.log(`   query failed: ${pErr.code} ${pErr.message}`);
  else if (!profiles?.length) console.log('   none');
  else profiles.forEach((p: any) => console.log(`   @${p.username} → ${p.theme_song_id}`));

  console.log('\n' + '─'.repeat(60));
})();
