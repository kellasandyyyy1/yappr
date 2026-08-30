/**
 * One icon set, reached one way.
 *
 *   npx tsx scripts/migrate/test-icons.ts
 *
 * The app draws Tabler icons through a single alias module, so call sites keep
 * the names they always used. The value of that is entirely in it staying the
 * only door: one component importing straight from the package, or from a
 * second library, and "change the icon set" is a 37-file job again.
 */

import fs from 'node:fs';
import path from 'node:path';

let failures = 0;
const ok = (l: string, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l: string, d = '') => { console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures++; };

const files: string[] = [];
const walk = (dir: string) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (/\.tsx?$/.test(e.name)) files.push(full);
  }
};
walk('src');

const icons = fs.readFileSync('src/components/icons.ts', 'utf8').replace(/\r\n/g, '\n');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

console.log('Icons\n');

// --- 1. The set ---------------------------------------------------------------
console.log('1. Which set');

icons.includes("from '@tabler/icons-react'")
  ? ok('the alias module draws from Tabler')
  : bad('the alias module draws from Tabler');

pkg.dependencies?.['@tabler/icons-react']
  ? ok('Tabler is a dependency', pkg.dependencies['@tabler/icons-react'])
  : bad('Tabler is a dependency');

!pkg.dependencies?.['lucide-react'] && !pkg.devDependencies?.['lucide-react']
  ? ok('lucide is no longer a dependency', 'nothing can quietly go back to it')
  : bad('lucide is no longer a dependency');

// --- 2. One door ---------------------------------------------------------------
console.log('\n2. One door');

const direct = files.filter(
  (f) => !f.endsWith(`icons.ts`) && fs.readFileSync(f, 'utf8').includes("from '@tabler/icons-react'")
);
direct.length === 0
  ? ok('nothing imports Tabler directly', 'every icon goes through the alias module')
  : bad('nothing imports Tabler directly', direct.join(', '));

const stragglers = files.filter((f) => fs.readFileSync(f, 'utf8').includes("from 'lucide-react'"));
stragglers.length === 0
  ? ok('no file still imports lucide')
  : bad('no file still imports lucide', stragglers.join(', '));

const importers = files.filter((f) => fs.readFileSync(f, 'utf8').includes("from './icons'"));
importers.length > 30
  ? ok('the module is what the app imports', `${importers.length} files`)
  : bad('the module is what the app imports', `${importers.length} files`);

// --- 3. Every alias resolves --------------------------------------------------
console.log('\n3. Every alias resolves');

// Read the package's own export list rather than trusting the names. A name
// that does not exist is a build error, but a name that exists and draws the
// wrong thing is not — so the mapping is worth stating explicitly.
const aliases = [...icons.matchAll(/^\s*(Icon[A-Za-z0-9]+) as ([A-Za-z0-9]+),/gm)]
  .map(([, tabler, local]) => ({ tabler, local }));

aliases.length >= 70
  ? ok('the module aliases the whole set', `${aliases.length} icons`)
  : bad('the module aliases the whole set', `${aliases.length}`);

const tablerPkg = JSON.parse(
  fs.readFileSync('node_modules/@tabler/icons-react/package.json', 'utf8')
);
const dts = path.join('node_modules/@tabler/icons-react', tablerPkg.types);
if (fs.existsSync(dts)) {
  const declared = new Set(
    [...fs.readFileSync(dts, 'utf8').matchAll(/declare const (Icon[A-Za-z0-9]+)\s*:/g)].map((m) => m[1])
  );
  const ghosts = aliases.filter((a) => !declared.has(a.tabler));
  ghosts.length === 0
    ? ok('every aliased name exists in the package', `checked against ${declared.size} exports`)
    : bad('every aliased name exists in the package', ghosts.map((g) => g.tabler).join(', '));
} else {
  bad('the package type definitions are readable', dts);
}

// Two locals pointing at one glyph is usually a mistake — the app thinks it is
// drawing two different things. Reported, not failed: Share/Share2 style pairs
// can legitimately collapse when one library draws them the same.
const byTabler = new Map<string, string[]>();
for (const a of aliases) byTabler.set(a.tabler, [...(byTabler.get(a.tabler) ?? []), a.local]);
const collisions = [...byTabler].filter(([, locals]) => locals.length > 1);
console.log(
  collisions.length === 0
    ? '     no two names share a glyph'
    : `     sharing a glyph: ${collisions.map(([t, l]) => `${l.join('/')} -> ${t}`).join(', ')}`
);

// --- 4. Call sites are untouched ----------------------------------------------
console.log('\n4. Props still work');

// Tabler spreads rest props onto the <svg> LAST, so these override its own
// stroke-width and fill. That is the reason no call site had to change; if a
// future version spreads first, these are the places that break.
const createComponent = fs.readFileSync(
  'node_modules/@tabler/icons-react/dist/esm/createReactComponent.mjs',
  'utf8'
);
/\.\.\.rest\s*\n?\s*\}/.test(createComponent)
  ? ok('rest props are spread last', 'strokeWidth and fill from call sites still win')
  : bad('rest props are spread last', 'strokeWidth/fill overrides would stop working');

const withStrokeWidth = files.filter((f) => /<[A-Z]\w*[^>]*strokeWidth=/.test(fs.readFileSync(f, 'utf8')));
withStrokeWidth.length > 0
  ? ok('call sites still pass strokeWidth', `${withStrokeWidth.length} files rely on it`)
  : bad('call sites still pass strokeWidth');

const withFill = files.filter((f) => /<[A-Z]\w*[^>]*fill="currentColor"/.test(fs.readFileSync(f, 'utf8')));
withFill.length > 0
  ? ok('call sites still pass fill', `${withFill.length} files — filled play/pause/heart`)
  : bad('call sites still pass fill');

console.log('\n' + '─'.repeat(60));
console.log(failures === 0 ? 'ICONS OK' : `${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
