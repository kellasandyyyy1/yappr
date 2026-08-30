/**
 * Toast placement geometry.
 *
 *   npx tsx scripts/migrate/test-toast-placement.ts
 *
 * The requirement is specific: top-right on desktop WITHOUT covering the right
 * rail's profile/username card, and bottom on mobile WITHOUT covering the nav.
 * Both are arithmetic, so they are checked as arithmetic rather than by eye.
 *
 * The layout constants are asserted against the source first. If someone
 * changes the shell — the container width, the sidebar, the gap, the rail — the
 * assertions fail and the numbers below have to be re-derived, instead of the
 * toast quietly drifting back on top of the rail.
 */

import fs from 'node:fs';

let failures = 0;
const ok = (l: string, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l: string, d = '') => { console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures++; };

const read = (f: string) => fs.readFileSync(f, 'utf8');
const app = read('src/App.tsx');
const rail = read('src/components/RightRail.tsx');
const toast = read('src/components/ToastContext.tsx');
const navbar = read('src/components/Navbar.tsx');
const css = read('src/index.css');

// --- 1. The constants this test does arithmetic with -------------------------
console.log('Toast placement\n');
console.log('1. Shell constants (change one and the maths below must change)');

const constant = (label: string, src: string, needle: string) =>
  src.includes(needle) ? ok(label, needle) : bad(label, `"${needle}" not found`);

constant('content container is max-w-[1120px]', app, 'max-w-[1120px]');
constant('sidebar offset is sm:pl-20 lg:pl-64', app, 'sm:pl-20 lg:pl-64');
constant('shell padding is px-4 sm:px-6 lg:px-8', app, 'px-4 sm:px-6 lg:px-8');
constant('main and rail are separated by gap-8', app, 'gap-8');
constant('right rail is w-80 and lg-only', rail, 'hidden w-80 shrink-0 lg:block');
constant('rail is sticky at the very top', rail, 'sticky top-0');
constant('nav height is declared as --nav-h', css, '--nav-h: 3.5rem;');
constant('nav enforces that height', navbar, 'min-h-[var(--nav-h)]');
constant('toast mirrors the sidebar offset', toast, 'sm:pl-20 lg:pl-64');
constant('toast clears the rail on lg', toast, 'lg:pl-8 lg:pr-96');
constant('toast sits above the nav on mobile', toast,
  'bottom-[calc(var(--nav-h)+env(safe-area-inset-bottom)+0.75rem)]');

const PX = { base: 16, sm: 24, lg: 32 };        // px-4 / px-6 / px-8
const SIDEBAR = { base: 0, sm: 80, lg: 256 };   // pl-20 / pl-64
const CONTAINER_MAX = 1120;
const RAIL_W = 320;                              // w-80
const GAP = 32;                                  // gap-8
/**
 * The toast's own right padding on lg, read out of the component rather than
 * hardcoded — so shrinking it back to pr-8 makes the geometry below fail with
 * real numbers, not just the constants check above.
 * Tailwind spacing: pr-N = N * 0.25rem = N * 4px.
 */
const TOAST_PR_LG = (() => {
  const m = toast.match(/lg:pr-(\d+)/);
  if (!m) throw new Error('could not read lg:pr-* from ToastContext.tsx');
  return Number(m[1]) * 4;
})();                                            // pr-96 = 2rem padding + 20rem rail + 2rem gap
const NAV_H = 56;                                // --nav-h: 3.5rem
const NAV_CLEARANCE = 12;                        // 0.75rem

const tierFor = (w: number) => (w >= 1024 ? 'lg' : w >= 640 ? 'sm' : 'base') as 'lg' | 'sm' | 'base';

/** Reproduces the shell's box model for a viewport width. */
const geometry = (viewport: number) => {
  const tier = tierFor(viewport);
  const sidebar = SIDEBAR[tier];
  const pad = PX[tier];
  const avail = viewport - sidebar;
  const container = Math.min(avail, CONTAINER_MAX);
  const containerLeft = sidebar + (avail - container) / 2;
  const contentLeft = containerLeft + pad;
  const contentRight = containerLeft + container - pad;

  const railLeft = tier === 'lg' ? contentRight - RAIL_W : null;
  const mainRight = railLeft === null ? contentRight : railLeft - GAP;

  // The toast container repeats the same box, with a larger right padding on lg.
  const toastRight =
    containerLeft + container - (tier === 'lg' ? TOAST_PR_LG : pad);

  return { tier, contentLeft, contentRight, railLeft, mainRight, toastRight };
};

// --- 2. Desktop: never over the rail -----------------------------------------
console.log('\n2. Desktop — the toast must stop before the right rail');
for (const w of [1024, 1152, 1280, 1440, 1600, 1920, 2560]) {
  const g = geometry(w);
  if (g.railLeft === null) { bad(`${w}px has a rail`, 'expected lg tier'); continue; }
  const clearance = g.railLeft - g.toastRight;
  clearance >= 0
    ? ok(`${w}px`, `toast right ${Math.round(g.toastRight)} | rail starts ${Math.round(g.railLeft)} | clear by ${Math.round(clearance)}px`)
    : bad(`${w}px`, `toast right ${Math.round(g.toastRight)} OVERLAPS rail starting ${Math.round(g.railLeft)} by ${Math.round(-clearance)}px`);
}

// It should also land exactly on the reading column's edge — flush right of the
// content, not floating in the middle of it.
console.log('\n   and it should sit flush with the main column');
for (const w of [1280, 1920]) {
  const g = geometry(w);
  Math.abs(g.toastRight - g.mainRight) < 0.5
    ? ok(`${w}px flush with main`, `both at ${Math.round(g.mainRight)}`)
    : bad(`${w}px flush with main`, `toast ${Math.round(g.toastRight)} vs main ${Math.round(g.mainRight)}`);
}

// --- 3. Tablet: no rail exists, so the toast goes to the content edge ---------
console.log('\n3. Tablet (sm, no rail) — toast at the content edge');
for (const w of [640, 768, 900]) {
  const g = geometry(w);
  g.railLeft === null && Math.abs(g.toastRight - g.contentRight) < 0.5
    ? ok(`${w}px`, `toast right ${Math.round(g.toastRight)} = content right`)
    : bad(`${w}px`, `toast ${Math.round(g.toastRight)} vs content ${Math.round(g.contentRight)}`);
}

// --- 4. Mobile: above the nav ------------------------------------------------
console.log('\n4. Mobile — the toast must clear the fixed nav bar');
for (const inset of [0, 34]) { // 34px is the iPhone home-indicator inset
  const navTop = NAV_H + inset;                       // nav occupies 0..navTop
  const toastBottom = NAV_H + inset + NAV_CLEARANCE;  // the calc() in the class
  toastBottom > navTop
    ? ok(`safe-area ${inset}px`, `nav top ${navTop}px | toast bottom ${toastBottom}px | clear by ${toastBottom - navTop}px`)
    : bad(`safe-area ${inset}px`, `toast bottom ${toastBottom}px sits on a nav ${navTop}px tall`);
}

// The nav is sm:hidden, so bottom placement and the nav must share a breakpoint:
// a toast still pinned to the bottom at sm would have nothing to clear, and one
// pinned to the top below sm would be fine but inconsistent with the brief.
navbar.includes('sm:hidden') && toast.includes('sm:bottom-auto sm:top-4')
  ? ok('bottom placement and the nav share the sm breakpoint')
  : bad('bottom placement and the nav share the sm breakpoint');

console.log('\n' + '─'.repeat(60));
console.log(failures === 0 ? 'TOAST PLACEMENT OK' : `${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
