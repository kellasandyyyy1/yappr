/**
 * The map can actually render, and errors can actually be read.
 *
 *   npx tsx scripts/migrate/test-map-render.ts
 *
 * Two bugs shipped together and looked like one: the map was a blank box and
 * the error above it said "[object Object]". They were unrelated, and neither
 * was catchable by a type check.
 *
 * Source-level, because both are CSS/JS facts no headless assertion reaches.
 */

import fs from 'node:fs';
import { describeError } from '../../src/lib/utils';

let failures = 0;
const ok = (l: string, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l: string, d = '') => { console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures++; };

const pinMap = fs.readFileSync('src/components/PinMap.tsx', 'utf8').replace(/\r\n/g, '\n');

console.log('Map rendering and error readability\n');

// --- 1. Leaflet's requirements -----------------------------------------------
console.log('1. Leaflet');

/import 'leaflet\/dist\/leaflet\.css'/.test(pinMap)
  ? ok("leaflet.css is imported", 'without it tiles stack in a column and controls vanish')
  : bad('leaflet.css is imported');

/className="absolute inset-0"/.test(pinMap)
  ? ok('the map box is absolutely positioned', 'sizes against the wrapper\'s used height')
  : bad('the map box is absolutely positioned');

// h-full is a percentage height. Against a wrapper sized by min-height or a
// flex basis — which is how every caller sizes it — that resolves to auto, and
// an uninitialised Leaflet container has no content, so it collapses to 0.
/<MapContainer[\s\S]{0,900}className="[^"]*h-full/.test(pinMap)
  ? bad('the map box does not use h-full', 'percentage height collapses to 0 here')
  : ok('the map box does not use h-full');

/relative overflow-hidden rounded-2xl/.test(pinMap)
  ? ok('the wrapper is positioned', 'inset-0 needs a positioned ancestor')
  : bad('the wrapper is positioned', 'absolute inset-0 would escape to the page');

// Tile provider. CARTO's dark basemap now stamps unauthenticated tiles with a
// diagonal "API KEY REQUIRED" — verified by fetching one and looking at it —
// so it cannot be used keyless, whatever its docs once said.
/basemaps.cartocdn.com/.test(pinMap)
  ? bad('no CARTO tiles without a key', 'unauthenticated CARTO tiles are watermarked')
  : ok('no CARTO tiles without a key');

/tile.openstreetmap.org/.test(pinMap)
  ? ok('tiles come from OpenStreetMap', 'genuinely keyless')
  : bad('tiles come from OpenStreetMap');

/map-dark/.test(pinMap)
  ? ok('the dark filter class is applied', '.map-dark on the wrapper')
  : bad('the dark filter class is applied', 'the map will be a bright rectangle');

{
  const css = fs.readFileSync('src/index.css', 'utf8');
  /.map-dark .leaflet-tile-pane/.test(css)
    ? ok('the filter targets the TILE PANE only', 'markers and controls stay uninverted')
    : bad('the filter targets the tile pane only');
}

// The tile host has to be allowed by BOTH policies, or the map renders as an
// empty black rectangle with working zoom controls — which is what shipped.
{
  const vercel = fs.readFileSync('vercel.json', 'utf8');
  const server = fs.readFileSync('server.ts', 'utf8');
  vercel.includes('https://tile.openstreetmap.org')
    ? ok('vercel.json img-src allows the tile host')
    : bad('vercel.json img-src allows the tile host', 'tiles will be blocked in production');
  server.includes('https://tile.openstreetmap.org')
    ? ok('server.ts img-src allows the tile host')
    : bad('server.ts img-src allows the tile host', 'tiles will be blocked in dev');
}

// A blocked tile host produces no visible error of its own. Leaflet fires
// tileerror; without handling it the failure is a silent black box.
/tileerror:/.test(pinMap)
  ? ok('tile failures are detected', 'Leaflet tileerror is handled')
  : bad('tile failures are detected', 'a blocked host would fail silently');

/tilesFailed &&/.test(pinMap)
  ? ok('and surfaced to the reader')
  : bad('and surfaced to the reader');

/failed >= 3/.test(pinMap)
  ? ok('one missing edge tile does not cry wolf', 'needs 3 failures and 0 loads')
  : bad('one missing edge tile does not cry wolf');

// --- 2. Every caller gives it a height ---------------------------------------
console.log('\n2. Callers');
const callers = ['src/components/MapView.tsx', 'src/components/CreatePinModal.tsx'];
let checked = 0;
for (const file of callers) {
  const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  for (const m of src.matchAll(/<PinMap[\s\S]{0,500}?className="([^"]*)"/g)) {
    checked++;
    const cls = m[1];
    /(^|\s)(h-|min-h-)/.test(cls)
      ? ok(`${file.split('/').pop()} sizes the map`, cls)
      : bad(`${file.split('/').pop()} sizes the map`, `"${cls}" has no height — the map will be 0px tall`);
  }
}
// Two now, not three: the pin detail dropped its mini-map — the place name at
// the top of that card already says where the pin is. The guard is that every
// REMAINING use is sized, so the count moves with the code; a map rendered
// 0px tall is the bug this whole section exists for.
checked >= 2 ? ok('all PinMap uses checked', `${checked}`) : bad('all PinMap uses checked', `${checked}`);

// --- 3. Errors are readable ---------------------------------------------------
console.log('\n3. Error readability');

// The exact shape Supabase returns. It is NOT an Error, which is why the
// `err instanceof Error ? err.message : String(err)` idiom renders it as the
// literal text "[object Object]".
const postgrestError = {
  code: 'PGRST205',
  details: null,
  hint: "Perhaps you meant the table 'public.posts'",
  message: "Could not find the table 'public.pins' in the schema cache",
};

const described = describeError(postgrestError);
described.includes('PGRST205') && described.includes('Could not find the table')
  ? ok('a Supabase error describes itself', described.slice(0, 72) + '…')
  : bad('a Supabase error describes itself', described);

described.includes('[object Object]')
  ? bad('never renders [object Object]')
  : ok('never renders [object Object]');

for (const [label, input, expect] of [
  ['a real Error', new Error('boom'), 'boom'],
  ['a plain string', 'just a string', 'just a string'],
  ['a GoTrue error', { error_description: 'invalid grant' }, 'invalid grant'],
] as const) {
  describeError(input).includes(expect)
    ? ok(label, describeError(input))
    : bad(label, describeError(input));
}

// Anything unrecognisable must still say something, never "[object Object]".
const weird = describeError({ nested: { deep: true } });
weird.includes('[object Object]')
  ? bad('an unrecognisable object still says something', weird)
  : ok('an unrecognisable object still says something', weird);

// And no error surface may go back to the old idiom.
const offenders = ['src/components/MapView.tsx', 'src/components/CommentsModal.tsx']
  .filter((f) => /instanceof Error \? \w+\.message : String\(/.test(fs.readFileSync(f, 'utf8')));
offenders.length === 0
  ? ok('no error surface uses the String(err) idiom')
  : bad('no error surface uses the String(err) idiom', offenders.join(', '));

// --- 4. The counts on screen -------------------------------------------------
console.log('\n4. Counts come from one place');

const view = fs.readFileSync('src/components/MapView.tsx', 'utf8').replace(/\r\n/g, '\n');

// The chip beside a space name read {s.members.length}. Next to a space
// name a bare number reads as a pin count, so a space with two members and
// one pin showed "2" beside a map saying "1 pin" — two numbers from two
// queries, which is the shape of the earlier comment-count bug.
!view.includes('<span className="text-subtle">{s.members.length}</span>')
  ? ok('the chip does not show the member count')
  : bad('the chip does not show the member count', 'members and pins will disagree');

view.includes('const pinCountFor = (spaceId: string | null) =>')
  ? ok('there is one counting function', 'pinCountFor')
  : bad('there is one counting function');

// Every number on the screen, named. If a new one appears that does not go
// through pinCountFor, this is where it should fail.
{
  const sites = [
    ['header',      '${shownPinCount} pin${shownPinCount === 1'],
    ['chip badge',  '{pinCountFor(s.id)}'],
    ['chip tooltip', '${pinCountFor(s.id)} pin(s)'],
    ['empty state', 'shownPinCount === 0 && !error'],
  ];
  for (const [where, needle] of sites) {
    view.includes(needle)
      ? ok(`${where} counts through it`)
      : bad(`${where} counts through it`, needle);
  }
}

// visiblePins is for DRAWING markers. The moment a label counts it instead,
// there are two ways to ask the same question again — which is exactly how
// the badge and the header came to disagree.
!view.includes('visiblePins.length')
  ? ok('no label counts the render array', 'visiblePins draws, pinCountFor counts')
  : bad('no label counts the render array', 'a second source has crept back in');

// A count field on the space object is an invitation to fetch the number a
// second time. It was declared and never used; it is gone.
{
  const lib = fs.readFileSync('src/lib/pins.ts', 'utf8');
  !lib.includes('pinCount')
    ? ok('MapSpace has no pinCount field', 'nothing to fill from a second query')
    : bad('MapSpace has no pinCount field');

  // And no query anywhere asks the database to count pins.
  !/from\('pins'\)[\s\S]{0,120}count:/.test(lib)
    ? ok('no server-side pin count query', 'one fetch, counted locally')
    : bad('no server-side pin count query');
}

// Derived, not fetched: a second query for the same fact is what drifts.
!/from\('pins'\)[\s\S]{0,200}count:/.test(view)
  ? ok('no separate count query', 'one fetch, two readings of it')
  : bad('no separate count query');

// The member count briefly lived in this tooltip, because the chip's digit
// used to be one. The pin detail shows the members themselves now — as faces,
// in the attribution row — so the tooltip went back to describing its own
// digit. Members are not lost, they moved somewhere better.
!view.includes('member(s)')
  ? ok('the chip tooltip describes its own digit', 'members are shown as faces in the pin detail')
  : bad('the chip tooltip describes its own digit', 'it still mentions members');

view.includes('<AvatarStack')
  ? ok('and the members are shown where they mean something')
  : bad('and the members are shown where they mean something');

// visiblePins is (pins ?? []), so a null pins reads as zero. Gating the
// text on `spaces` alone stated "0 pins in X" while pins were in flight.
view.includes('{spaces === null || pins === null')
  ? ok('the header waits for pins', 'not just for spaces')
  : bad('the header waits for pins');

view.includes('spaces !== null && pins !== null && spaces.length > 0')
  ? ok('the empty state waits for pins', '"no pins" is a fact, not a loading state')
  : bad('the empty state waits for pins');

// The chip prints nothing rather than 0 until the pins land.
view.includes('{pins !== null && (')
  ? ok('the chip shows no number while loading')
  : bad('the chip shows no number while loading');

// --- 5. The map frames what is selected --------------------------------------
console.log('\n5. Framing the selection');

// Switching tabs changed the pin list and left the viewport alone, so the
// pins for the newly chosen space were usually off-screen.
pinMap.includes('function FitToPins(')
  ? ok('PinMap can frame a set of pins')
  : bad('PinMap can frame a set of pins');

view.includes('fitKey={`${activeSpaceId')
  ? ok('MapView keys the frame on the selected space')
  : bad('MapView keys the frame on the selected space');

// The key carries the count as well as the space, so the map also frames
// when the pins first arrive — pins load after the first render, and a key
// of just the space id would never change on that.
view.includes(':${shownPinCount}`}')
  ? ok('and on the pins arriving', 'the key carries the count too')
  : bad('and on the pins arriving');

// Refitting on the pins array itself would snap the map back every time
// anyone panned, and on every poll.
/\}, \[fitKey\]\);/.test(pinMap)
  ? ok('it fits on the key, not on every render')
  : bad('it fits on the key, not on every render');

// fitBounds on an empty list throws, and 0,0 is the Atlantic.
pinMap.includes('if (points.length === 0) return;')
  ? ok('an empty space keeps its view', 'rather than fitting to nothing')
  : bad('an empty space keeps its view');

// A single point has no extent for fitBounds to work with.
pinMap.includes('if (points.length === 1)')
  ? ok('one pin gets setView, not fitBounds')
  : bad('one pin gets setView, not fitBounds');

// Two pins ten metres apart would otherwise fit to maximum zoom.
pinMap.includes('maxZoom: FIT_MAX_ZOOM')
  ? ok('the fit is zoom-capped', 'nearby pins do not slam to street level')
  : bad('the fit is zoom-capped');

pinMap.includes('padding: [48, 48]')
  ? ok('with padding', 'markers are not flush against the edge')
  : bad('with padding');

// The composer places a pin; it must not be yanked around while doing it.
{
  const composer = fs.readFileSync('src/components/CreatePinModal.tsx', 'utf8');
  !composer.includes('fitKey')
    ? ok('the composer opts out', 'undefined fitKey leaves its viewport alone')
    : bad('the composer opts out');
}

console.log('\n' + '─'.repeat(60));
console.log(failures === 0 ? 'MAP RENDER OK' : `${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
