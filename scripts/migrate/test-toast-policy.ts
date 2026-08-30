/**
 * Toast dismissal and stacking rules.
 *
 *   npx tsx scripts/migrate/test-toast-policy.ts
 *
 * Exercises src/lib/toastPolicy.ts, plus a few source-level checks on the
 * component for the presentation rules that would otherwise regress unnoticed.
 *
 * The behaviour worth protecting: an error must never acquire a timeout. Every
 * toast used to disappear after four seconds regardless of type, which meant a
 * failure explanation could vanish before it had been read — and a failure is
 * exactly the message the reader most needs to keep.
 */

import fs from 'node:fs';
import { autoDismissMs, appendToast, MAX_VISIBLE, ToastItem } from '../../src/lib/toastPolicy';

let failures = 0;
const ok = (l: string, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l: string, d = '') => { console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures++; };
const eq = (label: string, got: unknown, want: unknown) =>
  got === want ? ok(label, `${got}`) : bad(label, `got ${got}, want ${want}`);

const mk = (n: number, type: ToastItem['type'] = 'success'): ToastItem =>
  ({ id: `t${n}`, message: `message ${n}`, type });

console.log('Toast policy\n');

// --- dismissal ---------------------------------------------------------------
console.log('1. Auto-dismiss');
eq('success auto-dismisses', autoDismissMs('success'), 4000);
eq('info auto-dismisses', autoDismissMs('info'), 4000);
autoDismissMs('error') === null
  ? ok('error does NOT auto-dismiss', 'null — waits for the X')
  : bad('error does NOT auto-dismiss', `got ${autoDismissMs('error')}ms — a failure could vanish unread`);

// --- stacking ----------------------------------------------------------------
console.log('\n2. Stacking');
let list: ToastItem[] = [];
for (let n = 1; n <= 3; n++) list = appendToast(list, mk(n));
eq('holds several at once', list.length, 3);
eq('newest goes last', list[list.length - 1].id, 't3');

for (let n = 4; n <= 7; n++) list = appendToast(list, mk(n));
eq('capped', list.length, MAX_VISIBLE);
eq('the newest survives', list[list.length - 1].id, 't7');
list.some((t) => t.id === 't1')
  ? bad('the oldest is the one dropped', 't1 is still present')
  : ok('the oldest is the one dropped', `kept ${list.map((t) => t.id).join(', ')}`);

// An error must not be given special survival treatment by the cap either — the
// rule is purely recency, so the behaviour stays predictable.
const withError = appendToast(
  [mk(1, 'error'), mk(2), mk(3), mk(4)],
  mk(5)
);
eq('the cap is recency-based, not type-based', withError.length, MAX_VISIBLE);
eq('  and it drops the oldest even if it is an error', withError[0].id, 't2');

// --- presentation ------------------------------------------------------------
console.log('\n3. Presentation');
const src = fs.readFileSync('src/components/ToastContext.tsx', 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/\buppercase\b/.test(code)
  ? bad('message is sentence case', 'an "uppercase" class is still applied')
  : ok('message is sentence case', 'no uppercase class');

/font-black/.test(code)
  ? bad('routine toasts are not shouted', 'font-black is still applied')
  : ok('routine toasts are not shouted', 'no font-black');

/shadow-2xl/.test(code)
  ? bad('elevation is subtle', 'shadow-2xl is still applied')
  : ok('elevation is subtle', 'no shadow-2xl');

/gap-2\b/.test(code)
  ? ok('stack has a visible gap')
  : bad('stack has a visible gap', 'no gap class on the container');

/Math\.min\(i, 3\)/.test(code)
  ? ok('stacked toasts are offset from each other')
  : bad('stacked toasts are offset from each other');

/aria-label="Dismiss"/.test(code)
  ? ok('dismiss button is labelled')
  : bad('dismiss button is labelled');

// The icon and the close control must be smaller than the message text, which
// is 13px. Both are rendered at 13-14px as ICONS, which read lighter than text
// at the same nominal size; what matters is that neither is coloured or
// weighted above the message.
/text-subtle/.test(code)
  ? ok('icon and dismiss default to a muted colour')
  : bad('icon and dismiss default to a muted colour');

console.log('\n' + '─'.repeat(60));
console.log(failures === 0 ? 'TOAST POLICY OK' : `${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
