/**
 * Checks reachability and CORS for the auth endpoint from a browser origin.
 *
 *   npx tsx scripts/migrate/diagnose-origin.ts [origin]
 *
 * Answers two questions that "Failed to fetch" cannot distinguish on its own:
 *   • Is the URL exactly right and the host reachable?
 *   • Does GoTrue accept cross-origin calls from this dev origin?
 *
 * On the second: Supabase's Site URL / Redirect URLs setting does NOT control
 * CORS. It constrains where a magic link, OAuth callback or password-reset link
 * may redirect *to*. The REST and auth endpoints answer any origin. This script
 * prints the actual Access-Control-Allow-Origin header so that is a measurement
 * rather than a claim.
 */

import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config();

const strip = (v?: string) => (v ?? '').trim().replace(/^['"]|['"]$/g, '');

const rawUrl = strip(process.env.VITE_SUPABASE_URL);
const key = strip(process.env.VITE_SUPABASE_ANON_KEY);
const ORIGIN = process.argv[2] || 'http://localhost:3000';

(async () => {
  console.log('Origin / reachability check\n');

  // --- 3. Exactness of the URL ----------------------------------------------
  console.log('URL shape:');
  console.log(`  raw value        : ${JSON.stringify(rawUrl)}`);
  console.log(`  trailing slash   : ${rawUrl.endsWith('/') ? 'YES — strip it' : 'no'}`);
  console.log(`  scheme           : ${rawUrl.startsWith('https://') ? 'https' : 'NOT https'}`);
  console.log(`  whitespace       : ${/\s/.test(rawUrl) ? 'PRESENT — problem' : 'none'}`);
  const expected = 'https://llgsamvklytdtgxumpzm.supabase.co';
  console.log(`  matches expected : ${rawUrl === expected ? 'exact match' : `MISMATCH (expected ${expected})`}`);
  console.log(`  key present      : ${key ? `yes (${key.length} chars)` : 'NO'}`);

  // --- DNS + TLS + HTTP ------------------------------------------------------
  console.log('\nReachability:');
  const started = Date.now();
  try {
    const res = await fetch(`${rawUrl}/auth/v1/health`, { headers: { apikey: key } });
    console.log(`  GET /auth/v1/health -> ${res.status} in ${Date.now() - started}ms`);
    console.log(`  body: ${(await res.text()).slice(0, 200)}`);
  } catch (err: any) {
    console.log(`  GET /auth/v1/health -> FAILED: ${err.message}`);
    if (err.cause) console.log(`     cause: ${err.cause?.code ?? err.cause}`);
  }

  // --- 4. CORS, from the dev origin -----------------------------------------
  console.log(`\nCORS as seen from Origin: ${ORIGIN}`);

  // Preflight, exactly as the browser would send it before a POST with JSON.
  try {
    const pre = await fetch(`${rawUrl}/auth/v1/token?grant_type=password`, {
      method: 'OPTIONS',
      headers: {
        Origin: ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, apikey, content-type',
      },
    });
    console.log(`  OPTIONS preflight -> ${pre.status}`);
    console.log(`     access-control-allow-origin  : ${pre.headers.get('access-control-allow-origin') ?? '(absent)'}`);
    console.log(`     access-control-allow-headers : ${pre.headers.get('access-control-allow-headers') ?? '(absent)'}`);
    console.log(`     access-control-allow-methods : ${pre.headers.get('access-control-allow-methods') ?? '(absent)'}`);
  } catch (err: any) {
    console.log(`  OPTIONS preflight -> FAILED: ${err.message}`);
  }

  // The real POST, with an Origin header attached.
  try {
    const res = await fetch(`${rawUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { Origin: ORIGIN, apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'cors-probe@nonexistent.invalid', password: 'x' }),
    });
    console.log(`  POST /auth/v1/token -> ${res.status}`);
    console.log(`     access-control-allow-origin : ${res.headers.get('access-control-allow-origin') ?? '(absent)'}`);
    const body: any = await res.json().catch(() => ({}));
    console.log(`     error_code : ${body.error_code ?? body.code ?? '(none)'}`);
    console.log(`     msg        : ${body.msg ?? body.message ?? body.error_description ?? '(none)'}`);
    console.log(
      `\n  Reading: a ${res.status} with an error_code means the request was ACCEPTED and\n` +
      `  processed cross-origin. CORS is not the problem. A genuine CORS rejection\n` +
      `  never reaches this point — the browser discards the response and throws\n` +
      `  "Failed to fetch", which is also what a CSP block looks like from JS.`
    );
  } catch (err: any) {
    console.log(`  POST /auth/v1/token -> FAILED: ${err.message}`);
  }
})();
