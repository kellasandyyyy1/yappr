/**
 * The chat send button always has a place to be.
 *
 *   npx tsx scripts/migrate/test-chat-composer.ts
 *
 * Send went off screen at mobile widths, and it was found by using the app
 * rather than by any check. The bar is now [+] [message] [mic|send], with the
 * right slot reserved and single-occupancy, so the primary action cannot be
 * displaced by attachment controls no matter how many are added.
 *
 * This measures the row from the component's own class names, so widening a
 * control or adding a sixth attachment type moves these numbers instead of
 * silently pushing the primary action out of reach again.
 */

import fs from 'node:fs';

let failures = 0;
const ok = (l: string, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l: string, d = '') => { console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures++; };

const src = fs.readFileSync('src/components/ChatView.tsx', 'utf8').replace(/\r\n/g, '\n');
const sp = (n: number) => n * 4;

// Bounded by the marker that follows the composer, not by a character count —
// a fixed window once truncated this and hid half the menu from the test.
const rowStart = src.indexOf('<div className="relative flex items-center gap-2">');
const rowEnd = src.indexOf('{/* Action Confirmation */}', rowStart);
const row = rowStart === -1 ? '' : src.slice(rowStart, rowEnd === -1 ? undefined : rowEnd);

console.log('Chat composer — [+] [message] [mic|send]\n');

// --- 1. The reserved slot -----------------------------------------------------
console.log('1. The right slot is reserved and single-occupancy');

rowStart !== -1 ? ok('composer row found') : bad('composer row found');

// The three states must be branches of one conditional, so exactly one can
// render. Two sibling buttons would let a mic and a send appear together.
const slot = row.match(/\{isRecording \? \([\s\S]*?\) : hasMessageText \? \([\s\S]*?\) : \([\s\S]*?\)\}/);
slot
  ? ok('one slot, three exclusive states', 'recording → stop, text → send, else → mic')
  : bad('one slot, three exclusive states', 'the states are not branches of a single conditional');

const slotText = slot?.[0] ?? '';
for (const [label, needle] of [
  ['stop while recording', 'aria-label="Stop recording"'],
  ['send once there is text', 'aria-label="Send message"'],
  ['microphone when empty', 'aria-label="Record a voice message"'],
] as const) {
  slotText.includes(needle) ? ok(label) : bad(label, `${needle} missing`);
}

// Exactly one of each, and never a second copy elsewhere in the bar.
for (const [label, needle] of [
  ['only one send control', 'aria-label="Send message"'],
  ['only one microphone', 'aria-label="Record a voice message"'],
  ['only one stop control', 'aria-label="Stop recording"'],
] as const) {
  const n = row.split(needle).length - 1;
  n === 1 ? ok(label) : bad(label, `${n} found`);
}

// A second stop in the recording card would put two primary actions on screen.
(src.match(/onClick=\{stopRecording\}/g) || []).length === 1
  ? ok('the recording card no longer carries its own stop')
  : bad('the recording card no longer carries its own stop', 'two stop buttons can show at once');

/hasMessageText = newMessage\.trim\(\)\.length > 0/.test(src)
  ? ok('the morph is driven by the trimmed input')
  : bad('the morph is driven by the trimmed input');

// --- 2. Structure that makes overflow impossible -----------------------------
console.log('\n2. Structure');

/className="min-w-0 flex-1 bg-transparent/.test(row)
  ? ok('text input has min-w-0', "a flex item's min-width otherwise resolves to its intrinsic size")
  : bad('text input has min-w-0', 'the pill cannot shrink and the row will overflow');

/flex min-w-0 flex-1 items-center rounded-3xl/.test(row)
  ? ok('the pill is the only flexible element')
  : bad('the pill is the only flexible element');

const shrinkZero = (row.match(/h-11 w-11 shrink-0/g) || []).length;
shrinkZero >= 4
  ? ok('[+] and every slot state are shrink-0', `${shrinkZero} fixed 44px controls`)
  : bad('[+] and every slot state are shrink-0', `only ${shrinkZero}`);

// [+] must come before the pill; the slot after it.
const plusIdx = row.indexOf('aria-label="Add an attachment"');
const pillIdx = row.indexOf('flex min-w-0 flex-1 items-center rounded-3xl');
const slotIdx = row.indexOf('{isRecording ? (');
plusIdx !== -1 && plusIdx < pillIdx && pillIdx < slotIdx
  ? ok('order is [+] then input then slot')
  : bad('order is [+] then input then slot');

// --- 3. The attachment menu ---------------------------------------------------
console.log('\n3. Attachment menu');

const menuActions = [...row.matchAll(/setShowAttachMenu\(false\); ([a-zA-Z.?()]+)/g)].map((m) => m[1]);
menuActions.length === 3
  ? ok('menu holds Photo, Video and GIF', '3 actions')
  : bad('menu holds Photo, Video and GIF', `found ${menuActions.length}`);

!/setShowAttachMenu\(false\); startRecording/.test(row)
  ? ok('Voice is NOT in the menu', 'it is the microphone in the right slot')
  : bad('Voice is NOT in the menu', 'it is duplicated');

const conditional = row.indexOf('{isRecording ? (');
const photoInput = row.indexOf('ref={fileInputRef}');
const videoInput = row.indexOf('ref={videoInputRef}');
photoInput !== -1 && videoInput !== -1 && photoInput < conditional && videoInput < conditional
  ? ok('both file inputs stay mounted', 'the menu triggers their refs')
  : bad('both file inputs stay mounted');

/hidden items-center gap-1 sm:flex|hidden sm:flex/.test(row)
  ? bad('one layout at every width', 'a breakpoint-specific icon row is still here')
  : ok('one layout at every width', 'no sm: divergence in the bar');

// --- 4. Widths ----------------------------------------------------------------
console.log('\n4. Widths');

const shell = src.match(/className="fixed inset-0 flex flex-col bg-bg p-(\d+) pb-\d+ sm:left-(\d+) sm:p-(\d+)/);
if (!shell) bad('chat shell padding is readable');
else ok('chat shell padding', `p-${shell[1]} mobile, sm:p-${shell[3]} with sm:left-${shell[2]}`);

const padMobile = sp(Number(shell?.[1] ?? 4));
const CTRL = 44;          // h-11 w-11, and a real 44px touch target
const GAP = sp(2);        // gap-2
const PILL_PAD = sp(4) * 2; // px-4

/** Below this the field stops being usable. A judgement, stated so it can be
 *  argued with rather than discovered later. */
const MIN_FIELD = 120;

const CASES: Array<[string, number, number]> = [
  ['iPhone SE / 12 mini  375px', 375, padMobile],
  ['iPhone 12/13/14      390px', 390, padMobile],
  ['iPhone Plus/Max      414px', 414, padMobile],
  ['tablet               768px', 768 - 80, sp(6)],
  ['desktop             1280px', 1280 - 256, sp(6)],
];

for (const [label, viewport, pad] of CASES) {
  const usable = viewport - pad * 2;
  // [+] gap pill gap slot
  const pill = usable - CTRL * 2 - GAP * 2;
  const field = pill - PILL_PAD;
  pill > 0 && field >= MIN_FIELD
    ? ok(label, `[+] 44 · field ${field}px · slot 44 reserved · ${usable - CTRL * 2 - GAP * 2 - field - PILL_PAD}px unused`)
    : bad(label, `field ${field}px (want >= ${MIN_FIELD})`);
}

console.log('\n     the slot is a fixed 44px at every width above — it is not');
console.log('     part of the flexible area, so nothing can displace it.');

console.log('\n' + '─'.repeat(60));
console.log(failures === 0 ? 'CHAT COMPOSER OK' : `${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
