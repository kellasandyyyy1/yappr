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

/max-h-\[340px\]/.test(mapView)
  ? ok('media stays capped at 340px')
  : bad('media stays capped at 340px');

/className="h-32"/.test(mapView)
  ? ok('the mini-map is still 128px and last')
  : bad('the mini-map is still 128px');

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
