/**
 * Songs attached to a pin keep their name.
 *
 *   npx tsx scripts/migrate/test-song-title.ts
 *
 * The card said "Attached song" for every track because the composer knew the
 * title and the database had no column for it. This covers both halves of the
 * fix: the column (0021, new pins) and the oEmbed lookup (old pins).
 */

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { lookupTitle } from '../../api/_youtube';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config();

let failures = 0;
const ok = (l: string, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l: string, d = '') => { console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures++; };

const read = (p: string) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const migration = read('supabase/migrations/0021_pin_song_title.sql');
const pins = read('src/lib/pins.ts');
const composer = read('src/components/CreatePinModal.tsx');
const mapView = read('src/components/MapView.tsx');

console.log('Pin song titles\n');

// --- 1. The column ------------------------------------------------------------
console.log('1. Where the title is kept');

migration.includes('add column if not exists song_title') && migration.includes('add column if not exists song_artist')
  ? ok('0021 adds song_title and song_artist')
  : bad('0021 adds song_title and song_artist');

// Every row written before 0021 has no title and nothing to derive one from.
!/song_title\s+text\s+not null/i.test(migration)
  ? ok('the columns are nullable', 'existing rows would otherwise need invented titles')
  : bad('the columns are nullable');

migration.includes('char_length(song_title) between 1 and 200')
  ? ok('the title is length-checked')
  : bad('the title is length-checked');

// --- 2. The write path --------------------------------------------------------
console.log('\n2. The title survives the trip to the database');

// This is where it was lost: the picker had the title, the push dropped it.
composer.includes('songTitle: m.song.title')
  ? ok('the composer sends the title it already has')
  : bad('the composer sends the title it already has');

pins.includes('song_title: m.songTitle ?? null')
  ? ok('create() writes the column')
  : bad('create() writes the column');

pins.includes('song_title, song_artist')
  ? ok('the pin query selects it back')
  : bad('the pin query selects it back');

pins.includes('songTitle: m.song_title ?? undefined')
  ? ok('mapPin exposes it to the UI')
  : bad('mapPin exposes it to the UI');

// A select that does not ask for the column returns undefined for every pin,
// which looks exactly like "no title stored" — worth its own check above.

// --- 3. The read path ---------------------------------------------------------
console.log('\n3. What the card shows');

mapView.includes('m.songTitle')
  ? ok('the stored title is preferred')
  : bad('the stored title is preferred');

mapView.includes('songNames[m.youtubeVideoId!]?.title')
  ? ok('a looked-up title is the fallback', 'for pins made before 0021')
  : bad('a looked-up title is the fallback');

mapView.includes("?? 'Attached song'")
  ? ok('the placeholder is the last resort', 'a deleted video still renders')
  : bad('the placeholder is the last resort');

// --- 4. The lookup, live ------------------------------------------------------
console.log('\n4. oEmbed lookup (live)');
try {
  // The id the map-spaces suite attaches to its test pin.
  const track = await lookupTitle('fl66dFTg5-Y');
  if (track?.title) {
    ok('a real video resolves to a real title', `${track.title}${track.artist ? ` — ${track.artist}` : ''}`);
    track.title !== 'Attached song'
      ? ok('which is not the placeholder')
      : bad('which is not the placeholder');
  } else {
    bad('a real video resolves to a real title', 'null');
  }

  const t0 = Date.now();
  await lookupTitle('fl66dFTg5-Y');
  const cached = Date.now() - t0;
  cached < 50
    ? ok('a repeat lookup is cached', `${cached}ms`)
    : bad('a repeat lookup is cached', `${cached}ms`);

  // Deleted and private videos are the common case for an old pin, and they
  // must not throw — the card has to open regardless.
  const gone = await lookupTitle('aaaaaaaaaaa');
  gone === null
    ? ok('a dead video id returns null', 'the card falls back, it does not fail')
    : bad('a dead video id returns null', JSON.stringify(gone));
} catch (err) {
  bad('oEmbed lookup', String(err));
}

// --- 5. Quota -----------------------------------------------------------------
console.log('\n5. Quota');

const youtube = read('api/_youtube.ts');
// videos.list would spend the same 10,000/day the song search needs at 100
// units a call. oEmbed is free and keyless, which is the whole point.
!/lookupTitle[\s\S]*?googleapis\.com/.test(youtube)
  ? ok('the lookup does not touch the Data API', 'no key, no quota')
  : bad('the lookup does not touch the Data API');

read('api/youtube-title.ts').includes("res.status(401).json({ error: 'Unauthorized' })")
  ? ok('the endpoint is authenticated', 'not an open proxy on our domain')
  : bad('the endpoint is authenticated');

read('server.ts').includes('/api/youtube-title')
  ? ok('the dev server has the same route', 'so local and production cannot drift')
  : bad('the dev server has the same route');

console.log('\n' + '─'.repeat(60));
console.log(failures === 0 ? 'SONG TITLE OK' : `${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
