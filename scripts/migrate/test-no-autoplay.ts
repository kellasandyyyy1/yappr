/**
 * Guard: no theme-song player may start itself.
 *
 *   npx tsx scripts/migrate/test-no-autoplay.ts
 *
 * This is a source-level check, not a browser test — the failure it guards is a
 * documented YouTube IFrame API behaviour that no headless assertion reaches:
 *
 *   "If the player is paused when the function is called, it will remain
 *    paused. If the function is called from another state (playing, video
 *    cued, etc.), the player will play the video."   — seekTo()
 *
 * A player that has just fired onReady is in state 5 (video cued), never
 * paused. So a seekTo() inside onReady starts playback — and with one card per
 * music post, every song in the feed started at once. The rule is simply that
 * onReady must not seek.
 */

import fs from 'node:fs';

let failures = 0;
const ok = (l: string, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l: string, d = '') => { console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures++; };

const read = (p: string) => fs.readFileSync(p, 'utf8');

/** Body of `const <name>... = (event) => { ... }`, brace-matched. */
const handlerBody = (src: string, name: string): string | null => {
  const at = src.indexOf(`const ${name}`);
  if (at === -1) return null;
  const open = src.indexOf('{', src.indexOf('=>', at));
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  return null;
};

/** Code only — comments explain the rule and must not trip it. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

console.log('Theme song autoplay guard\n');

for (const [file, handler] of [
  ['src/components/ThemeSongCard.tsx', 'onReady'],
  ['src/components/ThemeSongSearch.tsx', 'onPlayerReady'],
  ['src/components/ThemeSongSearch.tsx', 'onPreviewReady'],
] as const) {
  const body = handlerBody(read(file), handler);
  // A handler that no longer exists cannot seek. onPlayerReady went away with
  // the pasted-link flow it existed to serve; the rule still holds for it.
  if (body === null) { ok(`${handler} does not seek`, `${file} — handler removed`); continue; }
  const code = stripComments(body);
  code.includes('seekTo')
    ? bad(`${handler} does not seek`, `${file} — seekTo() in onReady starts playback`)
    : ok(`${handler} does not seek`, file);
}

// The card must also refuse playback it did not ask for, so a future change
// that reintroduces an autoplay path is caught at runtime rather than shipping.
const card = read('src/components/ThemeSongCard.tsx');
const state = stripComments(handlerBody(card, 'onStateChange') ?? '');
/!\s*userStartedRef\.current/.test(state)
  ? ok('onStateChange rejects unrequested playback')
  : bad('onStateChange rejects unrequested playback', 'no userStartedRef guard');

stripComments(handlerBody(card, 'togglePlay') ?? '').includes('userStartedRef.current = true')
  ? ok('togglePlay records user intent')
  : bad('togglePlay records user intent');

// autoplay must stay off in every embed.
for (const file of ['src/components/ThemeSongCard.tsx', 'src/components/ThemeSongSearch.tsx']) {
  const src = stripComments(read(file));
  const vals = [...src.matchAll(/autoplay:\s*(\w+)/g)].map((m) => m[1]);
  vals.length && vals.every((v) => v === '0')
    ? ok('autoplay: 0 in every embed', `${file} (${vals.length})`)
    : bad('autoplay: 0 in every embed', `${file} — ${JSON.stringify(vals)}`);
}

// One song at a time.
/claimPlayback\(/.test(card) && /releasePlayback\(/.test(card)
  ? ok('single-player registry wired up')
  : bad('single-player registry wired up');

console.log('\n' + '─'.repeat(60));
console.log(failures === 0 ? 'NO-AUTOPLAY OK' : `${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
