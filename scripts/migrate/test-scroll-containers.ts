/**
 * Guard: scroll containers must actually be able to scroll.
 *
 *   npx tsx scripts/migrate/test-scroll-containers.ts
 *
 * This project has now shipped the same flexbox bug seven times, so it gets a
 * test rather than another comment.
 *
 * A flex item's `min-height` defaults to `auto`, which resolves to its content
 * size — meaning a flex item cannot shrink below its content unless it is given
 * `min-h-0`. Put an `overflow-y-auto` pane inside a flex column without that,
 * and the pane grows to fit its content instead of to its parent. Nothing
 * scrolls; the content is simply clipped by whichever ancestor has
 * `overflow: hidden`, and the reader sees a list cut off at the bottom edge
 * with no way to reach the rest.
 *
 * Two rules, both about the same trap:
 *
 *   1. `overflow-y-auto` + `flex-1`  ⇒  must also have `min-h-0`.
 *   2. A root that combines `flex`, `flex-col` and `h-full`, in a file that
 *      scrolls, is a percentage height standing in for a real flex chain. It
 *      works until it doesn't — `h-full` resolves against the parent, so it
 *      silently becomes `auto` the moment an ancestor stops having a definite
 *      height, and it never had `min-h-0` to begin with.
 */

import fs from 'node:fs';
import path from 'node:path';

let failures = 0;
const ok = (l: string, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l: string, d = '') => { console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures++; };

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.isFile() && full.endsWith('.tsx') ? [full] : [];
  });

const files = walk('src');
const rel = (f: string) => f.split(path.sep).join('/');

/** Every quoted class string in the file, with its line number. */
const classStrings = (src: string): { line: number; value: string }[] => {
  const out: { line: number; value: string }[] = [];
  src.split('\n').forEach((text, i) => {
    for (const m of text.matchAll(/"([^"]*)"/g)) out.push({ line: i + 1, value: m[1] });
  });
  return out;
};

const has = (s: string, cls: string) =>
  new RegExp(`(^|[\\s"])${cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s"]|$)`).test(s);

console.log(`Scroll containers (${files.length} .tsx files)\n`);

// --- Rule 1 ------------------------------------------------------------------
console.log('1. overflow-y-auto + flex-1 must carry min-h-0');
let rule1 = 0;
for (const f of files) {
  for (const { line, value } of classStrings(fs.readFileSync(f, 'utf8'))) {
    if (!has(value, 'overflow-y-auto') || !has(value, 'flex-1')) continue;
    rule1++;
    if (!has(value, 'min-h-0')) {
      bad('missing min-h-0', `${rel(f)}:${line}`);
    }
  }
}
if (failures === 0) ok('every flex-1 scroll pane has min-h-0', `${rule1} checked`);

// --- Rule 2 ------------------------------------------------------------------
console.log('\n2. no percentage-height flex root in a file that scrolls');
const before = failures;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  if (!src.includes('overflow-y-auto')) continue;
  for (const { line, value } of classStrings(src)) {
    if (has(value, 'flex') && has(value, 'flex-col') && has(value, 'h-full')) {
      bad('flex column sized by h-full', `${rel(f)}:${line} — use "flex min-h-0 flex-1 flex-col"`);
    }
  }
}
if (failures === before) ok('no flex column relies on h-full for its height');

console.log('\n' + '─'.repeat(60));
console.log(failures === 0 ? 'SCROLL CONTAINERS OK' : `${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
