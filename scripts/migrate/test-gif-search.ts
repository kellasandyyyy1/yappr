/**
 * GIF search, against the real GIPHY API.
 *
 *   npx tsx scripts/migrate/test-gif-search.ts
 *
 * Exercises api/_giphy.ts — the module both the Vercel function and the dev
 * server call — plus the wiring that decides whether a GIF actually renders
 * once attached: which rendition is stored, which is shown in the grid, and
 * whether our CSP allows the host they come from.
 *
 * Costs 2-3 calls against a beta key's 100/hour, so re-run it sparingly.
 */

import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { searchGifs, GifSearchError } from '../../api/_giphy';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config();

let failures = 0;
let skipped = 0;
const ok = (l: string, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l: string, d = '') => { console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures++; };
const skip = (l: string, d = '') => { console.log(`  SKIP  ${l}${d ? ` — ${d}` : ''}`); skipped++; };

const key = (process.env.GIPHY_API_KEY ?? '').trim();
const host = (u: string) => { try { return new URL(u).host; } catch { return 'invalid'; } };

(async () => {
  console.log('GIF search (GIPHY)\n');

  // --- 1. Wiring that needs no network ---------------------------------------
  console.log('1. Wiring');

  const vercelCsp = fs.readFileSync('vercel.json', 'utf8');
  const serverCsp = fs.readFileSync('server.ts', 'utf8');
  const composer = fs.readFileSync('src/components/CreatePostModal.tsx', 'utf8');
  const chat = fs.readFileSync('src/components/ChatView.tsx', 'utf8');
  const client = fs.readFileSync('src/lib/giphy.ts', 'utf8');
  const picker = fs.readFileSync('src/components/GifPicker.tsx', 'utf8');

  // A GIF renders from GIPHY's CDN. This is the one thing that would let every
  // other check pass and still show a broken image.
  vercelCsp.includes('https://*.giphy.com')
    ? ok('vercel.json img-src allows *.giphy.com')
    : bad('vercel.json img-src allows *.giphy.com', 'GIFs would be blocked in production');
  serverCsp.includes('https://*.giphy.com')
    ? ok('server.ts img-src allows *.giphy.com')
    : bad('server.ts img-src allows *.giphy.com', 'GIFs would be blocked in dev');

  // Nothing Tenor may survive the swap.
  const anyTenor = [vercelCsp, serverCsp, composer, chat, client, picker]
    .some((f) => /tenor/i.test(f));
  anyTenor
    ? bad('no Tenor references remain', 'a dead integration is still referenced')
    : ok('no Tenor references remain');

  // The key must never be reachable from the browser. Comments stripped first:
  // the client file explains in prose that it does NOT call GIPHY directly.
  const clientCode = client.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  !clientCode.includes('GIPHY_API_KEY') && !clientCode.includes('api.giphy.com')
    ? ok('client never sees the key or calls GIPHY directly')
    : bad('client never sees the key or calls GIPHY directly');

  composer.includes('selectedGif.url')
    ? ok('post stores the attachable rendition')
    : bad('post stores the attachable rendition');
  composer.includes('selectedGif.previewUrl')
    ? ok('composer thumbnail uses the PREVIEW rendition')
    : bad('composer thumbnail uses the PREVIEW rendition');
  picker.includes('gif.previewUrl')
    ? ok('picker grid uses the PREVIEW rendition')
    : bad('picker grid uses the PREVIEW rendition', 'a grid of originals is tens of MB');
  chat.includes('imageUrl: gif.url')
    ? ok('chat message stores the attachable rendition')
    : bad('chat message stores the attachable rendition');
  chat.includes('sendGif')
    ? ok('chat sends it as an image, so the existing bubble renders it')
    : bad('chat sends it as an image');

  // GIPHY requires a visible attribution mark wherever their content is shown.
  picker.includes('Powered by') && picker.includes('GIPHY')
    ? ok('picker shows the required "Powered by GIPHY" mark')
    : bad('picker shows the required "Powered by GIPHY" mark', 'this is a terms requirement');

  // --- 2. Credential ---------------------------------------------------------
  console.log('\n2. Credential');
  if (!key) {
    skip('GIPHY_API_KEY is set',
      'absent — /api/gif-search returns 503 and the picker shows "GIF search is not set up yet."');
  } else {
    ok('GIPHY_API_KEY is set', `len=${key.length}`);
    /^[A-Za-z0-9]{32}$/.test(key)
      ? ok('key has the GIPHY shape', '32 alphanumeric characters')
      : bad('key has the GIPHY shape', 'expected 32 alphanumeric — check for stray quotes or whitespace');

    // --- 3. Live search ------------------------------------------------------
    console.log('\n3. Live search');
    let gifs: Awaited<ReturnType<typeof searchGifs>> = [];
    try {
      gifs = await searchGifs('happy cat', key, 8);
      gifs.length > 0
        ? ok('returns results', `${gifs.length} gif(s)`)
        : bad('returns results', '0 — reached GIPHY but matched nothing');
    } catch (err) {
      bad('returns results',
        err instanceof GifSearchError ? `${err.status} ${err.message}` : String(err));
    }

    if (gifs.length) {
      const g = gifs[0];
      console.log(`\n     first result: "${g.description}"`);

      /\.giphy\.com$/.test(host(g.url))
        ? ok('attachable url is on a CSP-allowed host', host(g.url))
        : bad('attachable url is on a CSP-allowed host', `${host(g.url)} — img-src would block it`);
      /\.giphy\.com$/.test(host(g.previewUrl))
        ? ok('preview url is on a CSP-allowed host', host(g.previewUrl))
        : bad('preview url is on a CSP-allowed host', host(g.previewUrl));

      g.url !== g.previewUrl
        ? ok('attachable and preview are different renditions')
        : bad('attachable and preview are different renditions');

      g.description ? ok('has alt text', g.description.slice(0, 40)) : bad('has alt text');
      g.width > 0 && g.height > 0
        ? ok('carries dimensions for the grid', `${g.width}x${g.height}`)
        : bad('carries dimensions for the grid');

      // The stored URL must really be an animated GIF: GIPHY also serves mp4
      // and webp renditions, and <img> cannot animate an mp4.
      for (const [label, url] of [['attachable', g.url], ['preview', g.previewUrl]] as const) {
        try {
          const res = await fetch(url, { method: 'HEAD' });
          const type = res.headers.get('content-type') ?? '';
          const bytes = Number(res.headers.get('content-length') ?? 0);
          res.ok && type.includes('gif')
            ? ok(`${label} really is an image/gif`,
                 `${type}${bytes ? `, ${(bytes / 1024).toFixed(0)}KB` : ''}`)
            : bad(`${label} really is an image/gif`, `${res.status} ${type} — <img> cannot animate this`);
        } catch (err) {
          bad(`${label} really is an image/gif`, (err as Error).message);
        }
      }
    }

    // --- 4. Guards -----------------------------------------------------------
    console.log('\n4. Guards');
    try {
      const trending = await searchGifs('', key, 6);
      trending.length > 0
        ? ok('empty query returns trending', `${trending.length} gif(s) — the picker opens with content`)
        : bad('empty query returns trending', '0 — the picker would open empty');
    } catch (err) {
      bad('empty query returns trending', String(err));
    }

    const t0 = Date.now();
    await searchGifs('happy cat', key, 8);
    const elapsed = Date.now() - t0;
    elapsed < 50
      ? ok('repeat query served from cache', `${elapsed}ms — no call spent`)
      : bad('repeat query served from cache',
            `${elapsed}ms — with 100 calls/hour on a beta key the cache is load-bearing`);
  }

  console.log('\n' + '─'.repeat(60));
  if (failures > 0) console.log(`${failures} failure(s).`);
  else if (skipped > 0) console.log(`GIF WIRING OK — ${skipped} check(s) skipped, no GIPHY_API_KEY`);
  else console.log('GIF SEARCH OK');
  process.exit(failures === 0 ? 0 : 1);
})();
