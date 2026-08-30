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
checked >= 3 ? ok('all PinMap uses checked', `${checked}`) : bad('all PinMap uses checked', `${checked}`);

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

console.log('\n' + '─'.repeat(60));
console.log(failures === 0 ? 'MAP RENDER OK' : `${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
