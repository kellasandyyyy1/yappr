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

// The identity block is the person, not the place: the place is the cover
// above it. A 64px crop of the cover photo sitting directly under the cover
// was the same image three times over, counting its grid tile.
mapView.includes('<Avatar user={openPin.creator} size="xl" />')
  ? ok('the identity block shows the creator', 'the photo is the cover now')
  : bad('the identity block shows the creator');

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

// The mini-map is gone. The place name at the top already says where this
// is, and a 128px map of a location stated two lines above was restating it
// less legibly — plus the coordinates under it, a third telling.
const detailBody = mapView.slice(mapView.indexOf("<ModalBody"), mapView.indexOf("</ModalBody>"));
!detailBody.includes("<PinMap")
  ? ok('the pin detail has no mini-map', 'the place name already says where this is')
  : bad('the pin detail has no mini-map');

!detailBody.includes("toFixed(5)")
  ? ok('and no coordinates line', 'it went with the map it labelled')
  : bad('and no coordinates line');

// The map on the screen behind must still be there.
mapView.includes("<PinMap")
  ? ok('the main map is untouched')
  : bad('the main map is untouched');

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

// The cover is the first thing in the body, above the name and the avatar.
{
  const bodyIdx = mapView.indexOf('<ModalBody');
  const coverIdx = mapView.indexOf('{cover && (');
  const nameIdx = mapView.indexOf('id="pin-detail"');
  const attribIdx = mapView.indexOf('added {formatTimeAgo(openPin.createdAt)}');
  coverIdx > bodyIdx && coverIdx < nameIdx && nameIdx < attribIdx
    ? ok('cover, then name, then attribution', 'the cover is the top of the card')
    : bad('cover, then name, then attribution',
        `cover ${coverIdx}, name ${nameIdx}, attribution ${attribIdx}`);
}

// A cover photo that stops short of the edges is a picture in a card, not a
// cover. The body pads by 20/24px, so it has to reach back out through that.
mapView.includes('-mx-5 -mt-4 h-32 overflow-hidden border-b')
  ? ok('the cover is full-bleed', '128px, edge to edge, flush under the title bar')
  : bad('the cover is full-bleed');

mapView.includes('sm:-mx-6')
  ? ok('it clears the wider desktop padding too')
  : bad('it clears the wider desktop padding too');

// A pin with only a song has no cover to overlap, and the avatar must not be
// pulled up into the title bar.
mapView.includes("cover && '-mt-8'")
  ? ok('the overlap is conditional on there being a cover')
  : bad('the overlap is conditional on there being a cover');

// The cover is position:relative, and positioned boxes paint after in-flow
// ones whatever the DOM order — a static identity row would hide the
// overlapping half of the avatar behind the cover image.
mapView.includes("relative flex items-end gap-3")
  ? ok('the identity row is positioned too', 'or the avatar would paint behind the cover')
  : bad('the identity row is positioned too');

// space-y-4 on the body sets margin-top via `> * + *`, two classes of
// specificity, which outranks -mt-8 and cancels the overlap silently. The
// nesting is what makes the negative margin work, so it is worth asserting.
{
  const bodyIdx = mapView.indexOf('space-y-4 pb-8');
  const wrapIdx = mapView.indexOf('const cover =');
  const overlapIdx = mapView.indexOf("cover && '-mt-8'");
  const between = mapView.slice(bodyIdx, overlapIdx);
  wrapIdx > bodyIdx && between.split('<div>').length > 1
    ? ok('cover and identity share one body child', 'so space-y cannot outrank the overlap')
    : bad('cover and identity share one body child');
}

mapView.includes('rounded-full ring-4 ring-surface')
  ? ok('the avatar is ringed in the modal colour', 'it cuts a hole rather than sitting flat')
  : bad('the avatar is ringed in the modal colour');

// The space colour is what ties this pin to its marker on the map.
mapView.includes("style={{ borderColor: colorOf.get(openPin.spaceId) }}")
  ? ok('the space colour survives on the avatar')
  : bad('the space colour survives on the avatar');

// One avatar, not two. The big one replaced the small one in the row below.
!mapView.includes('<Avatar user={openPin.creator} size="sm" />')
  ? ok('the attribution row lost its duplicate avatar', 'the name still links to the profile')
  : bad('the attribution row lost its duplicate avatar');

// (The thumbnails used to be object-contain. They crop now — see the square
// cell assertions below, and the lightbox check that keeps the original whole.)

// The ternary is written across lines now, so match its parts.
mapView.includes('photos.length > 1') && mapView.includes("? 'grid-cols-2'")
  ? ok('two columns from two photos up', 'one photo gets a capped single column')
  : bad('two columns from two photos up');

// The cover photo must still appear in the grid. Skipping it there is the
// obvious de-duplication and it is wrong: a single-photo pin would keep the
// cropped strip and lose the only full view of the picture.
!mapView.includes('photos.slice(1)') && mapView.includes('photos.map((m) => (')
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

// The song still rides the attribution row, which now sits under the cover.
{
  const attribIdx = mapView.indexOf('added {formatTimeAgo(openPin.createdAt)}');
  const songIdx = mapView.indexOf('<ThemeSongCard');
  const galleryIdx = mapView.indexOf("'grid gap-2',");
  attribIdx !== -1 && songIdx > attribIdx && songIdx < galleryIdx
    ? ok('the song sits in the attribution row', 'not a block of its own')
    : bad('the song sits in the attribution row',
        `attribution ${attribIdx}, song ${songIdx}, gallery ${galleryIdx}`);
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
// One square at full card width was ~460px of a single photo and ran the
// card past the bottom of the modal.
mapView.includes("'mx-auto w-full max-w-[280px] grid-cols-1'")
  ? ok('a lone photo is capped', 'it no longer overflows the card')
  : bad('a lone photo is capped');

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
