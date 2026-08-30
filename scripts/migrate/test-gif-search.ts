/**
 * GIF search, against the real Tenor API.
 *
 *   npx tsx scripts/migrate/test-gif-search.ts
 *
 * Exercises api/_tenor.ts — the module both the Vercel function and the dev
 * server call — plus the wiring that decides whether a GIF actually renders
 * once attached: the stored URL's shape, and whether our CSP allows the host
 * it comes from.
 *
 * Without TENOR_API_KEY it still checks everything that does not need the
 * network, and reports the key as the one missing piece rather than failing
 * vaguely.
 */

import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { searchGifs, TenorSearchError } from '../../api/_tenor';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config();

let failures = 0;
let skipped = 0;
const ok = (l: string, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l: string, d = '') => { console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures++; };
const skip = (l: string, d = '') => { console.log(`  SKIP  ${l}${d ? ` — ${d}` : ''}`); skipped++; };

const key = (process.env.TENOR_API_KEY ?? '').trim();

(async () => {
  console.log('GIF search (Tenor)\n');

  // --- 1. Wiring that does not need the network ------------------------------
  console.log('1. Wiring');

  const vercelCsp = fs.readFileSync('vercel.json', 'utf8');
  const serverCsp = fs.readFileSync('server.ts', 'utf8');
  const composer = fs.readFileSync('src/components/CreatePostModal.tsx', 'utf8');
  const chat = fs.readFileSync('src/components/ChatView.tsx', 'utf8');
  const client = fs.readFileSync('src/lib/tenor.ts', 'utf8');
  const picker = fs.readFileSync('src/components/GifPicker.tsx', 'utf8');

  // A GIF renders from Tenor's CDN, so img-src must allow it. This is the one
  // thing that would let everything else pass and still show a broken image.
  vercelCsp.includes('https://*.tenor.com')
    ? ok('vercel.json img-src allows *.tenor.com')
    : bad('vercel.json img-src allows *.tenor.com', 'GIFs would be blocked in production');
  serverCsp.includes('https://*.tenor.com')
    ? ok('server.ts img-src allows *.tenor.com')
    : bad('server.ts img-src allows *.tenor.com', 'GIFs would be blocked in dev');

  // The key must never be reachable from the browser. Comments are stripped
  // first — the client file explains in prose that it does NOT call Tenor
  // directly, and matching that sentence is not a finding.
  const clientCode = client.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  !clientCode.includes('TENOR_API_KEY') && !clientCode.includes('tenor.googleapis.com')
    ? ok('client never sees the key or calls Tenor directly')
    : bad('client never sees the key or calls Tenor directly');

  composer.includes('selectedGif.url')
    ? ok('post stores the FULL gif url')
    : bad('post stores the FULL gif url');
  composer.includes('selectedGif.previewUrl')
    ? ok('post composer thumbnail uses the PREVIEW url')
    : bad('post composer thumbnail uses the PREVIEW url');
  picker.includes('gif.previewUrl')
    ? ok('picker grid uses the PREVIEW url')
    : bad('picker grid uses the PREVIEW url', 'a grid of full-size GIFs is tens of MB');
  chat.includes('imageUrl: gif.url')
    ? ok('chat message stores the FULL gif url')
    : bad('chat message stores the FULL gif url');
  chat.includes("type: 'image'") && chat.includes('sendGif')
    ? ok('chat sends it as an image, so the existing bubble renders it')
    : bad('chat sends it as an image');

  // --- 2. The credential -----------------------------------------------------
  console.log('\n2. Credential');
  if (!key) {
    skip('TENOR_API_KEY is set',
      'absent — /api/gif-search returns 503 and the picker shows "GIF search is not set up yet."');
    console.log('\n     Add TENOR_API_KEY to .env.local (and to the Vercel project)');
    console.log('     from https://developers.google.com/tenor/guides/quickstart,');
    console.log('     then re-run this to exercise the live API.');
  } else {
    ok('TENOR_API_KEY is set', `len=${key.length}, prefix=${key.slice(0, 6)}…`);

    // --- 3. Live search ------------------------------------------------------
    console.log('\n3. Live search');
    let gifs: Awaited<ReturnType<typeof searchGifs>> = [];
    try {
      gifs = await searchGifs('happy cat', key, 8);
      gifs.length > 0
        ? ok('returns results', `${gifs.length} gif(s)`)
        : bad('returns results', '0 — reached Tenor but matched nothing');
    } catch (err) {
      bad('returns results',
        err instanceof TenorSearchError ? `${err.status} ${err.message}` : String(err));
    }

    if (gifs.length) {
      const g = gifs[0];
      console.log(`\n     first result: "${g.description}"`);

      const host = (u: string) => { try { return new URL(u).host; } catch { return 'invalid'; } };
      /\.tenor\.com$/.test(host(g.url))
        ? ok('full url is on a CSP-allowed host', host(g.url))
        : bad('full url is on a CSP-allowed host', `${host(g.url)} — img-src would block it`);
      /\.tenor\.com$/.test(host(g.previewUrl))
        ? ok('preview url is on a CSP-allowed host', host(g.previewUrl))
        : bad('preview url is on a CSP-allowed host', host(g.previewUrl));

      g.url !== g.previewUrl
        ? ok('full and preview are different assets')
        : bad('full and preview are different assets', 'the preview is the full-size file');

      g.description ? ok('has alt text', g.description.slice(0, 40)) : bad('has alt text');
      g.width > 0 && g.height > 0
        ? ok('carries dimensions for the grid', `${g.width}x${g.height}`)
        : bad('carries dimensions for the grid');

      // The stored URL must actually be an animated GIF — Tenor also serves
      // mp4/webm, and an <img> cannot play those.
      try {
        const res = await fetch(g.url, { method: 'HEAD' });
        const type = res.headers.get('content-type') ?? '';
        res.ok && type.includes('gif')
          ? ok('stored url really is an image/gif', `${res.status} ${type}`)
          : bad('stored url really is an image/gif', `${res.status} ${type} — <img> cannot animate this`);
      } catch (err) {
        bad('stored url really is an image/gif', (err as Error).message);
      }
    }

    // --- 4. Guards -----------------------------------------------------------
    console.log('\n4. Guards');
    try {
      const featured = await searchGifs('', key, 6);
      featured.length > 0
        ? ok('empty query returns the featured set', `${featured.length} gif(s) — the picker opens with content`)
        : bad('empty query returns the featured set', '0 — the picker would open empty');
    } catch (err) {
      bad('empty query returns the featured set', String(err));
    }

    const t0 = Date.now();
    await searchGifs('happy cat', key, 8);
    const elapsed = Date.now() - t0;
    elapsed < 50
      ? ok('repeat query served from cache', `${elapsed}ms`)
      : bad('repeat query served from cache', `${elapsed}ms — every keystroke would hit Tenor`);
  }

  console.log('\n' + '─'.repeat(60));
  if (failures > 0) console.log(`${failures} failure(s).`);
  else if (skipped > 0) console.log(`GIF WIRING OK — ${skipped} check(s) skipped, no TENOR_API_KEY`);
  else console.log('GIF SEARCH OK');
  process.exit(failures === 0 ? 0 : 1);
})();
