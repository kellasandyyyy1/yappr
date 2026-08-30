/**
 * Music search, against the real YouTube Data API.
 *
 *   npx tsx scripts/migrate/test-youtube-search.ts
 *
 * Exercises api/_youtube.ts — the module both the Vercel function and the dev
 * server call — so a bad key, an unenabled API, or an exhausted quota shows up
 * here as a named failure rather than as an empty result list in the picker.
 *
 * Each search.list call costs 100 units of a 10,000/day quota, so this runs a
 * deliberately small number of them.
 */

import path from 'node:path';
import dotenv from 'dotenv';
import { searchMusic, YouTubeSearchError } from '../../api/_youtube';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config();

let failures = 0;
const ok = (l: string, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l: string, d = '') => { console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures++; };

const key = (process.env.YOUTUBE_API_KEY ?? '').trim();

(async () => {
  console.log('YouTube music search\n');

  console.log('1. Credential');
  if (!key) {
    bad('YOUTUBE_API_KEY is set', 'absent — song search returns 503 and the picker shows "not set up yet"');
    console.log('\n' + '─'.repeat(60));
    console.log('1 failure(s).');
    process.exit(1);
  }
  ok('YOUTUBE_API_KEY is set', `len=${key.length}, prefix=${key.slice(0, 6)}…`);
  /^AIza[\w-]{35}$/.test(key)
    ? ok('key has the Google API key shape')
    : bad('key has the Google API key shape', 'not AIza + 35 chars — check for stray quotes or whitespace');

  console.log('\n2. Live search');
  let tracks: Awaited<ReturnType<typeof searchMusic>> = [];
  try {
    tracks = await searchMusic('daft punk one more time', key, 5);
    tracks.length > 0
      ? ok('returns results', `${tracks.length} track(s)`)
      : bad('returns results', '0 — the query reached YouTube but matched nothing');
  } catch (err) {
    bad('returns results', err instanceof YouTubeSearchError ? `${err.status} ${err.message}` : String(err));
  }

  if (tracks.length) {
    const t = tracks[0];
    console.log(`\n     first result: "${t.title}" — ${t.artist}`);
    /^[\w-]{11}$/.test(t.youtubeId)
      ? ok('videoId is an 11-char id, not a URL', t.youtubeId)
      : bad('videoId is an 11-char id, not a URL', t.youtubeId);
    t.coverUrl.startsWith('https://i.ytimg.com/') || t.coverUrl.startsWith('https://img.youtube.com/')
      ? ok('thumbnail host is allowed by our CSP img-src', new URL(t.coverUrl).host)
      : bad('thumbnail host is allowed by our CSP img-src', new URL(t.coverUrl).host);
    t.title && t.artist ? ok('title and channel are populated') : bad('title and channel are populated');
    !/&(amp|quot|#39|lt|gt);/.test(t.title)
      ? ok('HTML entities are decoded in titles')
      : bad('HTML entities are decoded in titles', t.title);
  }

  // videoEmbeddable=true is the filter that stops someone picking a track that
  // cannot play in our embed — the 101/150 error class that previously left a
  // card loading forever.
  console.log('\n3. Every result is actually embeddable');
  for (const t of tracks.slice(0, 3)) {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${t.youtubeId}&format=json`
    );
    res.status === 200
      ? ok(`embeddable: ${t.youtubeId}`, t.title.slice(0, 40))
      : bad(`embeddable: ${t.youtubeId}`, `oembed ${res.status} — videoEmbeddable filter is not holding`);
  }

  console.log('\n4. Guards');
  (await searchMusic('a', key)).length === 0
    ? ok('one-character query is refused without calling the API')
    : bad('one-character query is refused without calling the API');

  const t0 = Date.now();
  await searchMusic('daft punk one more time', key, 5);
  const elapsed = Date.now() - t0;
  elapsed < 50
    ? ok('repeat query served from cache', `${elapsed}ms — no quota spent`)
    : bad('repeat query served from cache', `${elapsed}ms — the cache is not being hit, quota burns per keystroke`);

  console.log('\n' + '─'.repeat(60));
  console.log(failures === 0 ? 'YOUTUBE SEARCH OK' : `${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
})();
