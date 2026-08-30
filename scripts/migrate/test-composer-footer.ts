/**
 * The composer footer fits on one line, on a phone.
 *
 *   npx tsx scripts/migrate/test-composer-footer.ts
 *
 * The Post button was clipped once already because five labelled attachment
 * buttons plus Post exceeded the modal's width. That was found by eye, in a
 * screenshot, after shipping. This measures it instead.
 *
 * Sizes are read out of the component's own class names, so changing a button
 * from h-9 to h-11, or adding a sixth attachment type, moves the numbers here
 * rather than silently overflowing on a 375px phone that nobody tested.
 */

import fs from 'node:fs';

let failures = 0;
const ok = (l: string, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l: string, d = '') => { console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures++; };

const src = fs.readFileSync('src/components/CreatePostModal.tsx', 'utf8').replace(/\r\n/g, '\n');
const modal = fs.readFileSync('src/components/Modal.tsx', 'utf8').replace(/\r\n/g, '\n');

/** Tailwind spacing: n * 0.25rem = n * 4px. */
const sp = (n: number) => n * 4;

console.log('Composer footer width\n');

// --- 1. Geometry constants, asserted against source --------------------------
console.log('1. Layout constants');

const footer = src.slice(src.indexOf('<ModalFooter'), src.indexOf('</ModalFooter>'));

// On mobile the sheet is inset-x-0 — full viewport width. Worth asserting,
// because a max-width there would change every number below.
modal.includes('inset-x-0 bottom-0 rounded-t-3xl')
  ? ok('mobile sheet is full-bleed (inset-x-0)')
  : bad('mobile sheet is full-bleed', 'Modal.tsx no longer uses inset-x-0 on mobile');

const footerPad = /modal-footer px-5/.test(modal) ? sp(5) : NaN;
Number.isFinite(footerPad)
  ? ok('footer padding is px-5', `${footerPad}px each side`)
  : bad('footer padding is px-5', 'ModalFooter padding changed');

const rowGapMatch = footer.match(/className="flex items-center gap-(\d+)"/);
if (!rowGapMatch) { bad('footer is one flex row with a known gap'); }
const rowGap = sp(Number(rowGapMatch?.[1] ?? 1));
ok('footer is one flex row', `gap-${rowGapMatch?.[1]} = ${rowGap}px`);

// --- 2. The icon cluster ------------------------------------------------------
console.log('\n2. Attachment cluster');

const iconButtons = [...footer.matchAll(/title="(Photo|Video|GIF|Voice note|Song)"/g)].map((m) => m[1]);
iconButtons.length === 5
  ? ok('five attachment buttons', iconButtons.join(', '))
  : bad('five attachment buttons', `found ${iconButtons.length}: ${iconButtons.join(', ')}`);

// Icon-only: no visible text label may remain beside the glyphs.
/hidden sm:inline/.test(footer)
  ? bad('buttons are icon-only', 'a text label is still rendered')
  : ok('buttons are icon-only', 'labels moved to title + aria-label');

// Every one still has to be reachable and describable.
for (const label of iconButtons) {
  const block = footer.slice(footer.indexOf(`title="${label}"`) - 400, footer.indexOf(`title="${label}"`) + 200);
  /aria-label="/.test(block)
    ? ok(`${label} has an accessible name`)
    : bad(`${label} has an accessible name`, 'title alone is not announced reliably');
}

const btnSizeMatch = footer.match(/flex h-(\d+) w-(\d+) shrink-0 items-center justify-center rounded-lg/);
if (!btnSizeMatch) { bad('icon buttons have a fixed square size'); }
const btn = sp(Number(btnSizeMatch?.[1] ?? 9));
ok('icon button size', `h-${btnSizeMatch?.[1]} = ${btn}px square`);
btn < 44
  ? console.log(`        note: ${btn}px is under the 44px touch target the app's .tap uses.`)
  : undefined;

// --- 3. Visibility control ----------------------------------------------------
console.log('\n3. Visibility control');
/Visible to: \$\{activeVisibility\.label\}/.test(footer)
  ? ok('visibility is in the row, labelled via title/aria')
  : bad('visibility is in the row');
/w-full items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2\.5/.test(footer)
  ? bad('visibility is no longer a full-width bar', 'the old full-width trigger is still there')
  : ok('visibility is no longer a full-width bar');

const visMatch = footer.match(/flex h-9 items-center gap-0\.5 rounded-lg pl-(\d+) pr-(\d+)/);
const visIcon = 17, visChevron = 13, visInnerGap = 2;
const visWidth = visMatch
  ? sp(Number(visMatch[1])) + sp(Number(visMatch[2])) + visIcon + visInnerGap + visChevron
  : NaN;
Number.isFinite(visWidth)
  ? ok('visibility pill measured', `${visWidth}px`)
  : bad('visibility pill measured', 'class shape changed');

// --- 4. Post ------------------------------------------------------------------
console.log('\n4. Post button');
const postMatch = footer.match(/btn-primary ml-auto flex h-(\d+) shrink-0 items-center justify-center gap-[\d.]+ px-(\d+)/);
if (!postMatch) { bad('Post keeps its bottom-right position'); }
else ok('Post keeps ml-auto (bottom-right)', `h-${postMatch[1]}, px-${postMatch[2]}`);
/min-w-\[110px\]/.test(footer)
  ? bad('Post is no longer padded to 110px', 'the old min-width is still there')
  : ok('Post is no longer padded to 110px');
// "Post" at text-sm semibold ≈ 34px, measured generously.
const postWidth = postMatch ? sp(Number(postMatch[2])) * 2 + 34 : NaN;

// --- 5. Does it fit? ----------------------------------------------------------
console.log('\n5. Fits on one line');
const CHILDREN = 1 /* visibility */ + 5 /* icons */ + 1 /* Post */;
const total = visWidth + btn * 5 + postWidth + rowGap * (CHILDREN - 1);
console.log(`     row = ${visWidth} (visibility) + ${btn}x5 (${btn * 5} icons) + ${postWidth} (Post) + ${rowGap * (CHILDREN - 1)} (gaps) = ${total}px\n`);

// Phone widths, and the desktop modal. sm:max-w-lg = 32rem with px-6 padding.
const CASES: Array<[string, number, number]> = [
  ['iPhone SE / 12 mini  375px', 375, footerPad],
  ['iPhone 12/13/14      390px', 390, footerPad],
  ['iPhone Plus/Pro Max  414px', 414, footerPad],
  ['desktop modal        512px', 512, sp(6)],
];

for (const [label, viewport, pad] of CASES) {
  const usable = viewport - pad * 2;
  const slack = usable - total;
  slack >= 0
    ? ok(label, `usable ${usable}px, row ${total}px, ${slack}px slack`)
    : bad(label, `usable ${usable}px, row ${total}px — OVERFLOWS by ${-slack}px`);
}

// A wrap would be a silent regression: the row must not need flex-wrap to fit.
/flex-wrap/.test(footer)
  ? bad('no flex-wrap needed', 'the row still relies on wrapping to avoid overflow')
  : ok('no flex-wrap needed', 'it fits without wrapping at every width above');

console.log('\n' + '─'.repeat(60));
console.log(failures === 0 ? 'COMPOSER FOOTER OK' : `${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
