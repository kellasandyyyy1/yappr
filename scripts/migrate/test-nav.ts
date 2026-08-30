/**
 * The bottom navigation.
 *
 *   npx tsx scripts/migrate/test-nav.ts
 *
 * Icon-only on mobile, labelled on desktop. The two are separate components
 * that share one NAV_ITEMS list, which is the thing most likely to go wrong:
 * a change meant for one silently applies to both.
 */

import fs from 'node:fs';

let failures = 0;
const ok = (l: string, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l: string, d = '') => { console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures++; };

const navbar = fs.readFileSync('src/components/Navbar.tsx', 'utf8').replace(/\r\n/g, '\n');
const sidebar = fs.readFileSync('src/components/Sidebar.tsx', 'utf8').replace(/\r\n/g, '\n');
const css = fs.readFileSync('src/index.css', 'utf8').replace(/\r\n/g, '\n');

console.log('Bottom navigation\n');

// --- 1. Icon only --------------------------------------------------------------
console.log('1. Mobile is icon-only');

// Six labels at 10px in a ~49px cell: "Notifications" is unreadable at that
// width, so it was noise that also squeezed the icon.
!/<span className="text-\[10px\][^>]*>\{item\.label\}<\/span>/.test(navbar)
  ? ok('no text label under the icons')
  : bad('no text label under the icons');

// Any visible rendering of the label, not just the exact old markup.
!/>\s*\{item\.label\}\s*</.test(navbar)
  ? ok('the label is not rendered as content anywhere')
  : bad('the label is not rendered as content anywhere');

// Removing text from a button removes its accessible name unless something
// else carries it. aria-label is what a screen reader was already announcing.
navbar.includes('aria-label={item.label}')
  ? ok('each button keeps its accessible name', 'aria-label carries what the text said')
  : bad('each button keeps its accessible name', 'the buttons would be unnamed');

navbar.includes('sm:hidden')
  ? ok('this bar is mobile-only', 'below 640px')
  : bad('this bar is mobile-only');

// --- 2. Desktop is untouched ---------------------------------------------------
console.log('\n2. Desktop still reads');

/\{item\.label\}/.test(sidebar)
  ? ok('the sidebar still shows labels', 'icon-only was a mobile fix, not a global one')
  : bad('the sidebar still shows labels');

// One list, two renderers. Worth stating, because the next person editing
// NAV_ITEMS is editing both screens at once.
navbar.includes("import { NAV_ITEMS } from './Sidebar'")
  ? ok('both read one NAV_ITEMS list', 'the items cannot drift apart')
  : bad('both read one NAV_ITEMS list');

// --- 3. The target ------------------------------------------------------------
console.log('\n3. Tap target and size');

/<Icon size=\{24\}/.test(navbar)
  ? ok('the icon grew to 24px', 'compensating for the removed label')
  : bad('the icon grew to 24px');

// The icon is 24 but the target must stay a thumb. .tap is where that lives.
/\.tap\s*\{[^}]*min-w-\[44px\][^}]*min-h-\[44px\]/.test(css)
  ? ok('.tap guarantees 44x44', 'the icon is smaller than its target, deliberately')
  : bad('.tap guarantees 44x44');

/className=\{cn\(\s*'tap relative flex-1/.test(navbar)
  ? ok('every nav button uses .tap', 'so every one is at least 44x44')
  : bad('every nav button uses .tap');

// flex-1 on each button IS the even distribution: equal shares of whatever
// the compose button leaves.
navbar.includes('flex-1') && navbar.includes('justify-around')
  ? ok('icons distribute across the bar', 'flex-1 within justify-around')
  : bad('icons distribute across the bar');

// The stacking direction was for icon-over-label. With no label it would
// leave the icon fighting .tap's centring.
!/'tap relative flex-1 flex-col/.test(navbar)
  ? ok('the column layout is gone with the label')
  : bad('the column layout is gone with the label');

// --- 4. What had to survive ----------------------------------------------------
console.log('\n4. Kept');

navbar.includes("id === 'notifications' ? unreadNotifications : 0")
  ? ok('the unread count still reaches the bell')
  : bad('the unread count still reaches the bell');

/\{count > 99 \? '99\+' : count\}/.test(navbar)
  ? ok('the badge still renders on the icon', 'the only unread signal left without labels')
  : bad('the badge still renders on the icon');

navbar.includes("isActive ? 'text-accent' : 'text-muted active:text-fg'")
  ? ok('the active state is kept', 'accent colour')
  : bad('the active state is kept');

/strokeWidth=\{isActive \? 2\.4 : 2\}/.test(navbar)
  ? ok('and its heavier stroke', 'two signals, which matters more without a label')
  : bad('and its heavier stroke');

navbar.includes('aria-current={isActive ? \'page\' : undefined}')
  ? ok('active is exposed to assistive tech too', 'not colour alone')
  : bad('active is exposed to assistive tech too');

// The brief called this a separate floating button. It is not — it is the last
// child of this same row. Left exactly as it was, which is what was asked;
// noted here so the next reader is not looking for a floating element.
navbar.includes('aria-label="New post"') && navbar.includes('<PenSquare size={20} />')
  ? ok('the compose button is unchanged', 'still the last item in this row, not floating')
  : bad('the compose button is unchanged');

console.log('\n' + '─'.repeat(60));
console.log(failures === 0 ? 'NAV OK' : `${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
