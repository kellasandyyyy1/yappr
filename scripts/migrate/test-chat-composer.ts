/**
 * The chat send button is always visible, on a phone.
 *
 *   npx tsx scripts/migrate/test-chat-composer.ts
 *
 * Send went off-screen at mobile widths and it was found by using the app, not
 * by any check. This measures the row instead, from the component's own class
 * names, so adding a sixth attachment button or widening the pill moves these
 * numbers rather than silently pushing the primary action out of reach again.
 *
 * The failure had two causes and both are asserted here:
 *   1. the text input was flex-1 with no min-w-0, so the pill could not shrink
 *      below the input's intrinsic width (~180px) and the row overflowed;
 *   2. four 40px attachment buttons do not leave a usable text field at 375px
 *      even once the pill can shrink.
 */

import fs from 'node:fs';

let failures = 0;
const ok = (l: string, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l: string, d = '') => { console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures++; };

const src = fs.readFileSync('src/components/ChatView.tsx', 'utf8').replace(/\r\n/g, '\n');

const sp = (n: number) => n * 4;

// The composer row, isolated.
const rowStart = src.indexOf('<div className="relative flex items-center gap-3">');
// Bounded by the marker that follows the composer, not by a character count:
// a fixed window silently truncated the row and made two of the four menu
// items invisible to this test.
const rowEnd = src.indexOf('{/* Action Confirmation */}', rowStart);
const row = rowStart === -1 ? '' : src.slice(rowStart, rowEnd === -1 ? undefined : rowEnd);

console.log('Chat composer — send button reachability\n');

// --- 1. The structural guarantees --------------------------------------------
console.log('1. Structure');

rowStart !== -1
  ? ok('composer row found')
  : bad('composer row found', 'the expected wrapper class is gone');

/className="min-w-0 flex-1 bg-transparent/.test(row)
  ? ok('text input has min-w-0', "without it a flex item's min-width is its intrinsic size")
  : bad('text input has min-w-0', 'the pill cannot shrink and the row will overflow');

/flex min-w-0 flex-1 items-center gap-2 rounded-3xl/.test(row)
  ? ok('the input pill itself can shrink', 'min-w-0 flex-1')
  : bad('the input pill itself can shrink');

// Send has to be outside the shrinkable pill AND non-shrinking.
const sendIdx = row.indexOf('aria-label="Send message"');
const pillEnd = row.indexOf('</div>\n\n            {/* shrink-0 and outside the pill');
sendIdx > pillEnd && pillEnd !== -1
  ? ok('Send sits outside the shrinkable pill')
  : bad('Send sits outside the shrinkable pill', 'it can be squeezed with the input');

/btn-primary flex h-12 w-12 shrink-0/.test(row)
  ? ok('Send is shrink-0', '48px, fixed')
  : bad('Send is shrink-0');

// --- 2. Mobile collapses the icon row ----------------------------------------
console.log('\n2. Mobile collapse');

/aria-label="Add an attachment"[\s\S]{0,400}sm:hidden/.test(row)
  ? ok('a single "+" button below sm')
  : bad('a single "+" button below sm');

/className="hidden items-center gap-1 sm:flex"/.test(row)
  ? ok('the four icons are desktop-only', 'hidden ... sm:flex')
  : bad('the four icons are desktop-only', 'they still render on mobile');

const menuActions = [...row.matchAll(/setShowAttachMenu\(false\); ([a-zA-Z.?()]+)/g)].map((m) => m[1]);
menuActions.length === 4
  ? ok('the menu offers all four attachment types', `${menuActions.length} actions`)
  : bad('the menu offers all four attachment types', `found ${menuActions.length}`);

// Both file inputs must be outside the conditional, or the menu's refs are null.
const conditional = row.indexOf('{!isRecording && !pendingAttachment && (');
const photoInput = row.indexOf('ref={fileInputRef}');
const videoInput = row.indexOf('ref={videoInputRef}');
photoInput < conditional && videoInput < conditional && photoInput !== -1 && videoInput !== -1
  ? ok('both file inputs stay mounted', 'the menu triggers their refs')
  : bad('both file inputs stay mounted', 'a ref inside the conditional is null when the menu fires');

// --- 3. Widths ----------------------------------------------------------------
console.log('\n3. Widths');

// The chat detail pane: fixed inset-0 with p-4 on mobile, sm:p-6 and a sidebar
// offset from sm up.
const shell = src.match(/className="fixed inset-0 flex flex-col bg-bg p-(\d+) pb-\d+ sm:left-(\d+) sm:p-(\d+)/);
if (!shell) bad('chat shell padding is readable');
else ok('chat shell padding', `p-${shell[1]} mobile, sm:p-${shell[3]} with sm:left-${shell[2]}`);

const padMobile = sp(Number(shell?.[1] ?? 4));
const SEND = 48;
const OUTER_GAP = sp(3);
const PILL_PAD = sp(5) + sp(2); // pl-5 + p-2 right
const PILL_GAP = sp(2);
const ICON = 40;
const ICON_GAP = sp(1);

/**
 * The smallest the text field is allowed to get before the composer stops
 * being usable. Not a browser constant — a judgement, stated so it can be
 * argued with rather than discovered.
 */
const MIN_FIELD = 120;

const layouts = {
  mobile: { attach: ICON, label: 'one "+" button' },
  desktop: { attach: ICON * 4 + ICON_GAP * 3, label: 'four icons' },
};

const CASES: Array<[string, number, number, keyof typeof layouts]> = [
  ['iPhone SE / 12 mini  375px', 375, padMobile, 'mobile'],
  ['iPhone 12/13/14      390px', 390, padMobile, 'mobile'],
  ['iPhone Plus/Max      414px', 414, padMobile, 'mobile'],
  // From sm up the pane is inset by the 80px sidebar and padded p-6.
  ['tablet               768px', 768 - 80, sp(6), 'desktop'],
];

for (const [label, viewport, pad, which] of CASES) {
  const usable = viewport - pad * 2;
  const pill = usable - SEND - OUTER_GAP;
  const field = pill - PILL_PAD - PILL_GAP - layouts[which].attach;

  const sendFits = pill > 0;
  const fieldOk = field >= MIN_FIELD;

  sendFits && fieldOk
    ? ok(label, `${layouts[which].label} · pill ${pill}px · field ${field}px · Send ${SEND}px always visible`)
    : bad(label, sendFits
        ? `field only ${field}px (want >= ${MIN_FIELD})`
        : `no room for the pill — Send would be pushed off`);
}

// The old layout, for the record: four icons on a phone.
{
  const usable = 375 - padMobile * 2;
  const field = usable - SEND - OUTER_GAP - PILL_PAD - PILL_GAP - layouts.desktop.attach;
  console.log(`\n     for comparison, four icons at 375px would leave a ${field}px text field`);
  field < MIN_FIELD
    ? ok('collapsing on mobile is necessary', `${field}px < ${MIN_FIELD}px minimum`)
    : bad('collapsing on mobile is necessary', 'four icons would have fitted after all');
}

console.log('\n' + '─'.repeat(60));
console.log(failures === 0 ? 'CHAT COMPOSER OK' : `${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
