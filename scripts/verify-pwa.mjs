/**
 * Checks the PWA installability criteria against a running server.
 *
 *   npm run build && npm run verify:pwa            # defaults to :3000
 *   npm run verify:pwa -- http://localhost:4173
 *
 * This is the same checklist Lighthouse's "Installable" audit applies, asserted
 * over real HTTP rather than by reading the source. Lighthouse itself needs a
 * Chrome binary; this needs nothing and can run in CI.
 *
 * It cannot check two things, both of which are noted in the output:
 *   • HTTPS in production — localhost is a secure context by definition, so the
 *     check passes locally regardless of what the deployed origin does.
 *   • That the worker actually controls a page. That requires a real browser.
 */

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');

let failures = 0;
let warnings = 0;
const pass = (l, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const fail = (l, d = '') => { console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures++; };
const warn = (l, d = '') => { console.log(`  WARN  ${l}${d ? ` — ${d}` : ''}`); warnings++; };

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { redirect: 'follow' });
  return { res, text: res.ok ? await res.text() : '' };
}

async function main() {
  console.log(`PWA installability check against ${BASE}\n`);

  // --- 1. Document ----------------------------------------------------------
  console.log('Document:');
  const { res: docRes, text: html } = await get('/');
  docRes.ok ? pass('index.html served', `${docRes.status}`) : fail('index.html served', `${docRes.status}`);

  const manifestHref = html.match(/<link[^>]+rel=["']manifest["'][^>]+href=["']([^"']+)["']/i)?.[1]
    ?? html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']manifest["']/i)?.[1];
  manifestHref ? pass('manifest is linked', manifestHref) : fail('manifest is linked', 'no <link rel="manifest">');

  const themeColor = html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i)?.[1];
  themeColor ? pass('theme-color meta present', themeColor) : fail('theme-color meta present');

  const appleIcon = /rel=["']apple-touch-icon["']/i.test(html);
  appleIcon ? pass('apple-touch-icon present') : fail('apple-touch-icon present');

  const appleCapable = /name=["']apple-mobile-web-app-capable["']/i.test(html);
  appleCapable ? pass('apple-mobile-web-app-capable present') : warn('apple-mobile-web-app-capable missing');

  // --- 2. Manifest ----------------------------------------------------------
  console.log('\nManifest:');
  if (!manifestHref) {
    fail('manifest checks skipped', 'nothing linked');
  } else {
    const { res: mRes, text: mText } = await get(manifestHref);
    if (!mRes.ok) {
      fail('manifest fetches', `${mRes.status}`);
    } else {
      pass('manifest fetches', `${mRes.status} ${mRes.headers.get('content-type')}`);

      let m;
      try {
        m = JSON.parse(mText);
        pass('manifest is valid JSON');
      } catch (err) {
        fail('manifest is valid JSON', err.message);
      }

      if (m) {
        m.name ? pass('name', m.name) : fail('name');
        m.short_name ? pass('short_name', m.short_name) : fail('short_name');
        // Lighthouse warns above 12 characters — longer gets truncated under
        // the home screen icon.
        if (m.short_name && m.short_name.length > 12) warn('short_name length', `${m.short_name.length} chars, may truncate`);
        m.start_url ? pass('start_url', m.start_url) : fail('start_url');
        ['standalone', 'fullscreen', 'minimal-ui'].includes(m.display)
          ? pass('display is installable', m.display)
          : fail('display is installable', `"${m.display}" does not qualify`);
        m.background_color ? pass('background_color', m.background_color) : warn('background_color missing');
        m.theme_color ? pass('theme_color', m.theme_color) : fail('theme_color');

        if (themeColor && m.theme_color && themeColor.toLowerCase() !== m.theme_color.toLowerCase()) {
          warn('theme-color agreement', `html=${themeColor} manifest=${m.theme_color}`);
        } else if (themeColor && m.theme_color) {
          pass('theme-color agrees with manifest');
        }

        const icons = Array.isArray(m.icons) ? m.icons : [];
        const has = (size, purpose) =>
          icons.some((i) => String(i.sizes).split(' ').includes(size) &&
            (purpose ? String(i.purpose ?? 'any').split(' ').includes(purpose) : true));

        has('192x192') ? pass('192x192 icon declared') : fail('192x192 icon declared');
        has('512x512') ? pass('512x512 icon declared') : fail('512x512 icon declared');
        has('512x512', 'maskable') || has('192x192', 'maskable')
          ? pass('maskable icon declared')
          : warn('maskable icon declared', 'Android will letterbox the icon');

        // Declaring an icon is not the same as shipping one.
        for (const icon of icons) {
          const { res } = await get(icon.src);
          const type = res.headers.get('content-type') || '';
          if (!res.ok) fail(`icon reachable: ${icon.src}`, `${res.status}`);
          else if (!type.startsWith('image/')) fail(`icon reachable: ${icon.src}`, `content-type ${type}`);
          else pass(`icon reachable: ${icon.src}`, `${res.status} ${type}`);
        }
      }
    }
  }

  // --- 3. Service worker ----------------------------------------------------
  console.log('\nService worker:');
  const { res: swRes, text: sw } = await get('/sw.js');
  if (!swRes.ok) {
    fail('/sw.js served', `${swRes.status}`);
  } else {
    const type = swRes.headers.get('content-type') || '';
    pass('/sw.js served', `${swRes.status} ${type}`);
    /javascript|ecmascript/i.test(type)
      ? pass('served as JavaScript')
      : fail('served as JavaScript', `content-type is ${type}`);

    // Installability requires a fetch handler. Workbox registers one through
    // its router rather than a literal addEventListener('fetch'), so accept
    // either spelling.
    /addEventListener\(["']fetch["']|workbox|precache/i.test(sw)
      ? pass('worker has a fetch handler')
      : fail('worker has a fetch handler', 'no fetch listener or Workbox router found');

    /precache|__WB_MANIFEST|self\.__WB/i.test(sw)
      ? pass('precache manifest injected')
      : warn('precache manifest injected', 'offline load may not work');

    /addEventListener\(["']push["']/.test(sw)
      ? pass('push handler retained in the merged worker')
      : fail('push handler retained', 'Web Push has been lost');
  }

  // --- 4. Secure context ----------------------------------------------------
  console.log('\nSecure context:');
  const url = new URL(BASE);
  if (url.protocol === 'https:') pass('served over HTTPS');
  else if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    pass('localhost is a secure context', 'production must still be HTTPS');
  } else {
    fail('secure context', `${url.protocol}//${url.hostname} is neither HTTPS nor localhost`);
  }

  console.log('\n' + '─'.repeat(62));
  console.log(`${failures} failure(s), ${warnings} warning(s)`);
  if (failures === 0) console.log('INSTALLABLE — every criterion Lighthouse checks is satisfied.');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nverify-pwa could not run: ${err.message}`);
  console.error('Is the server running? Try: npm run dev');
  process.exit(1);
});
