/**
 * Photo-bubble markers and the locket detail card.
 *
 *   npx tsx scripts/migrate/test-pin-markers.ts
 *
 * Source-level for the markup — PinMap imports leaflet's CSS, which node
 * cannot load — plus a live reverse-geocode check and the marker-overlap
 * arithmetic that the clustering question turns on.
 *
 * The three cases the brief asks for:
 *   a pin with a photo        -> square thumbnail
 *   a pin with only a song    -> circular avatar fallback
 *   pins close together       -> measured, see section 4
 */

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { reverseGeocode } from '../../api/_nominatim';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config();

let failures = 0;
const ok = (l: string, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l: string, d = '') => { console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures++; };

const pinMap = fs.readFileSync('src/components/PinMap.tsx', 'utf8').replace(/\r\n/g, '\n');
const mapView = fs.readFileSync('src/components/MapView.tsx', 'utf8').replace(/\r\n/g, '\n');

console.log('Pin markers and the locket card\n');

// --- 1. The bubble -----------------------------------------------------------
console.log('1. Photo bubble marker');

/const photoBubble = /.test(pinMap)
  ? ok('markers are photo bubbles', 'the teardrop is gone')
  : bad('markers are photo bubbles');

/width:60px; height:56px/.test(pinMap)
  ? ok('frame is 60x56', 'as specced')
  : bad('frame is 60x56');

/border-top:9px solid \$\{color\}/.test(pinMap)
  ? ok('has a pointer tail beneath')
  : bad('has a pointer tail beneath');

// The whole point of the fallback: square means "this is a picture of the
// place", round means "this is the person who added it".
/const innerRadius = hasPhoto \? '9px' : '999px'/.test(pinMap)
  ? ok('photo renders square, avatar renders circular')
  : bad('photo renders square, avatar renders circular');

/photoUrl \|\| avatarUrl \|\| ''/.test(pinMap)
  ? ok('falls back photo -> avatar', 'a song-only pin still shows a face')
  : bad('falls back photo -> avatar');

/onerror="this\.style\.display='none'"/.test(pinMap)
  ? ok('a dead image URL reveals the initial', 'no broken-image glyph in the frame')
  : bad('a dead image URL reveals the initial');

// divIcon takes raw HTML, so an unescaped quote in a display name closes the
// attribute and breaks the marker.
/const esc = /.test(pinMap) && /\$\{esc\(src\)\}/.test(pinMap)
  ? ok('values are HTML-escaped into the divIcon')
  : bad('values are HTML-escaped into the divIcon');

// Two pins with different photos must not share a cached bubble.
/photoUrl \?\? ""\}\|\$\{pin\.avatarUrl/.test(pinMap)
  ? ok('the icon cache keys on the imagery', 'not just colour')
  : bad('the icon cache keys on the imagery', 'pins would share one photo');

/zIndexOffset=\{i\}/.test(pinMap)
  ? ok('later pins draw above earlier ones')
  : bad('later pins draw above earlier ones');

// --- 2. What the marker is fed -----------------------------------------------
console.log('\n2. Marker imagery');

/const pictureOf = /.test(mapView)
  ? ok('MapView picks a picture per pin')
  : bad('MapView picks a picture per pin');

/type === 'photo' && m\.url/.test(mapView) && /type === 'video' && m\.posterUrl/.test(mapView)
  ? ok('photo first, then a video poster')
  : bad('photo first, then a video poster');

/avatarUrl: p\.creator\?\.photoURL/.test(mapView)
  ? ok('creator avatar is the fallback')
  : bad('creator avatar is the fallback');

/initial: \(p\.name \|\| p\.creator\?\.displayName/.test(mapView)
  ? ok('an initial is the last resort')
  : bad('an initial is the last resort');

// --- 3. The locket card ------------------------------------------------------
console.log('\n3. Locket detail card');

/h-16 w-16 shrink-0 rounded-2xl border-2 object-cover/.test(mapView)
  ? ok('64px rounded-square photo', 'matches the marker language')
  : bad('64px rounded-square photo');

/h-16 w-16 shrink-0 items-center justify-center rounded-full/.test(mapView)
  ? ok('64px circular avatar fallback')
  : bad('64px circular avatar fallback');

/placeName \?\? `\$\{openPin\.latitude\.toFixed\(4\)\}/.test(mapView)
  ? ok('place name, falling back to coordinates')
  : bad('place name, falling back to coordinates');

/added \{formatTimeAgo\(openPin\.createdAt\)\}/.test(mapView)
  ? ok('the "added Xs ago" attribution is kept')
  : bad('the attribution is kept');

// Video keeps a height cap. Photos no longer need one — they are cropped to a
// fixed banner, which caps them by construction.
/max-h-\[240px\]/.test(mapView)
  ? ok('video stays height-capped', '240px')
  : bad('video stays height-capped');

/className="h-32"/.test(mapView)
  ? ok('the mini-map is still 128px and last')
  : bad('the mini-map is still 128px');

// The name printed twice — once in the title bar, once as the heading — after
// it moved into the body and was left in the header too.
{
  const titleIsName = /title={openPin.name/.test(mapView);
  titleIsName
    ? bad('the name is not printed twice', 'the title bar repeats the heading')
    : ok('the name is not printed twice', 'title bar carries the space instead');
}

/id="pin-detail" className="truncate text-xl/.test(mapView)
  ? ok('the heading labels the dialog', 'aria-labelledby points at it')
  : bad('the heading labels the dialog');

// Cover strip, then the gallery. The distinction is the whole point of this
// layout: the crop is decoration, the grid is the photo.
/h-28 w-full overflow-hidden rounded-xl/.test(mapView)
  ? ok('the cover is a small strip', '112px, inside the 100-120 the brief asks for')
  : bad('the cover is a small strip');

/<img src={cover} alt="" loading="lazy" className="h-full w-full object-cover"/.test(mapView)
  ? ok('the cover crops to fill', 'object-cover')
  : bad('the cover crops to fill');

// A tappable cover would put a second hit target on the same picture, a
// thumb-width above the grid copy that already opens it.
{
  const coverBlock = mapView.slice(mapView.indexOf('{cover && ('), mapView.indexOf('{cover && (') + 300);
  /<button/.test(coverBlock)
    ? bad('the cover is decoration, not a second viewer', 'it is a button')
    : ok('the cover is decoration, not a second viewer');
}

// (The thumbnails used to be object-contain. They crop now — see the square
// cell assertions below, and the lightbox check that keeps the original whole.)

mapView.includes(`photos.length > 1 ? 'grid-cols-2' : 'grid-cols-1'`)
  ? ok('two columns from two photos up', 'a lone photo spans the card')
  : bad('two columns from two photos up');

// One photo must render twice, as cover and as gallery. Dropping the first
// from the grid is the obvious "fix" for the repetition and is wrong: a
// single-photo pin would then have a crop and no full view of it at all.
mapView.includes('const cover = photos[0]?.url') && !mapView.includes('photos.slice(1)')
  ? ok('the cover photo is still in the grid', 'one photo shows up twice, by design')
  : bad('the cover photo is still in the grid');

mapView.includes('onClick={() => setViewingImage(m.url!)}')
  ? ok('tapping a gallery photo opens it full size')
  : bad('tapping a gallery photo opens it full size');

/Tap to expand/.test(mapView)
  ? ok('the gallery says the full image is a tap away')
  : bad('the gallery says the full image is a tap away');

// Video is played, not browsed, so it stays out of the thumbnail grid.
{
  const gridIdx = mapView.indexOf('grid-cols-2');
  const videoIdx = mapView.indexOf('{videos.map(');
  gridIdx !== -1 && videoIdx > gridIdx
    ? ok('video keeps its own full-width block', 'after the grid')
    : bad('video keeps its own full-width block');
}

// The song is now part of the "You / added Xs ago" row, not a block of its
// own. Source order is the check: it has to appear before the cover, which is
// the first thing in the media group below.
{
  const attribIdx = mapView.indexOf('added {formatTimeAgo(openPin.createdAt)}');
  const songIdx = mapView.indexOf('<ThemeSongCard');
  const coverIdx = mapView.indexOf('{cover && (');
  attribIdx !== -1 && songIdx > attribIdx && songIdx < coverIdx
    ? ok('the song sits in the attribution row', 'above the cover, not between cover and gallery')
    : bad('the song sits in the attribution row',
        `attribution ${attribIdx}, song ${songIdx}, cover ${coverIdx}`);
}

mapView.includes('variant="inline"')
  ? ok('it renders as the inline control', 'play button + title, no card')
  : bad('it renders as the inline control');

// The full-width chip is what the inline control replaced. Leaving it behind
// would put the same song on the card twice.
!mapView.includes('className="max-w-none"')
  ? ok('the full-width song block is gone')
  : bad('the full-width song block is gone', 'the song renders twice');

// A pin can hold more than one song: the composer appends without a cap.
// Rendering only the first is the tempting simplification and it drops data.
mapView.includes("resolved.filter((m) => m.type === 'song' && m.youtubeVideoId).map(")
  ? ok('every attached song is rendered', 'not just the first')
  : bad('every attached song is rendered');


// Uniform cells. Ragged rows read as a broken layout rather than as photos.
mapView.includes('aspect-square overflow-hidden')
  ? ok('grid cells are a fixed square')
  : bad('grid cells are a fixed square');

mapView.includes('h-full w-full cursor-zoom-in object-cover')
  ? ok('thumbnails fill their cell', 'object-cover')
  : bad('thumbnails fill their cell');

// Cropping the thumbnail is not the crop that was removed last round. That
// one left no way to see the picture whole; this one is an index, and the
// lightbox still opens the original.
mapView.includes('onClick={() => setViewingImage(m.url!)}')
  ? ok('the full image is still reachable uncropped', 'the square is only the thumbnail')
  : bad('the full image is still reachable uncropped');

// The cover was indistinguishable from a grid tile that had drifted up.
mapView.includes('bg-gradient-to-t from-black/70')
  ? ok('the cover has a header gradient', 'it no longer reads as a stray duplicate')
  : bad('the cover has a header gradient');

// The caption is a note in someone's voice, not another metadata line.
mapView.includes('text-[15px] italic leading-relaxed')
  ? ok('the caption is set apart', 'italic — this app has no serif to reach for')
  : bad('the caption is set apart');

// The last row was being cut by the modal edge with no sign it was scrollable.
mapView.includes('space-y-4 pb-8')
  ? ok('the scroll area has bottom padding')
  : bad('the scroll area has bottom padding');

// sticky, not absolute: the scroll container has no positioned ancestor, so
// an absolute overlay would hang off the page instead of the modal.
mapView.includes('pointer-events-none sticky bottom-0 -mt-8')
  ? ok('a fade marks the bottom edge', 'sticky, and negative-margined so nothing is unreachable')
  : bad('a fade marks the bottom edge');

// --- 4. Overlap, measured ----------------------------------------------------
console.log('\n4. How close is too close');

/**
 * Web Mercator ground resolution: metres per pixel at a latitude and zoom.
 * Two 60px bubbles collide when their centres are nearer than 60px.
 */
const metresPerPixel = (lat: number, zoom: number) =>
  (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;

const BUBBLE_PX = 60;
console.log('     At latitude 51.5, two markers overlap when closer than:');
for (const zoom of [12, 14, 15, 16, 18]) {
  const metres = metresPerPixel(51.5, zoom) * BUBBLE_PX;
  console.log(`       zoom ${String(zoom).padStart(2)}  ${metres.toFixed(0).padStart(5)} m`);
}
const atCityZoom = metresPerPixel(51.5, 15) * BUBBLE_PX;
atCityZoom > 100
  ? ok('overlap is real at city zoom', `${atCityZoom.toFixed(0)}m — clustering needs its own scope`)
  : bad('overlap is real at city zoom');

// --- 5. Reverse geocoding, live ----------------------------------------------
console.log('\n5. Reverse geocoding (live)');
try {
  // Westminster Bridge.
  const place = await reverseGeocode(51.5007, -0.1246);
  place?.name
    ? ok('coordinates resolve to a place name', place.name)
    : bad('coordinates resolve to a place name', 'null');

  const t0 = Date.now();
  await reverseGeocode(51.5007, -0.1246);
  const cached = Date.now() - t0;
  cached < 50
    ? ok('a repeat lookup is cached', `${cached}ms`)
    : bad('a repeat lookup is cached', `${cached}ms`);

  // The sea has no name, and that is a legitimate pin location.
  const nowhere = await reverseGeocode(0, 0);
  console.log(`     0,0 (Atlantic) -> ${nowhere ? nowhere.name : 'null, falls back to coordinates'}`);
  ok('an unnamed point does not throw');
} catch (err) {
  bad('reverse geocoding', String(err));
}

console.log('\n' + '─'.repeat(60));
console.log(failures === 0 ? 'PIN MARKERS OK' : `${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
