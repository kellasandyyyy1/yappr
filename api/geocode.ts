import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
// The .js extension is REQUIRED and must not be removed. package.json sets
// "type": "module", so Vercel runs these functions as ESM, and Node's ESM
// loader does no extension guessing: an extensionless specifier throws
// ERR_MODULE_NOT_FOUND at runtime. It resolves fine locally because dev goes
// through server.ts under tsx, which does guess — so this only ever fails in
// production. TypeScript maps the .js back to the .ts source at build time.
import { geocode, reverseGeocode, GeocodeError } from './_nominatim.js';

/**
 * GET /api/geocode?q=… — proxied Nominatim search.
 *
 * There is no key to hide here. It is proxied because Nominatim's usage policy
 * requires a descriptive User-Agent — a header a browser is not allowed to set
 * — and caps the whole application at 1 request/second, which cannot be
 * enforced from inside individual browsers. See api/_nominatim.ts.
 *
 * Authenticated so the rate limit and the upstream courtesy are spent on this
 * app's users rather than on anyone who finds the URL.
 */

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const admin =
  SUPABASE_URL && SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null;

/**
 * Per-user limit, on top of the outbound throttle in _nominatim.ts.
 *
 * HONEST SCOPE: one warm lambda instance, and Vercel runs many, so this bounds
 * a runaway client against a single instance rather than globally. The
 * response cache upstream is what actually keeps request volume down.
 */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimit(key: string): { allowed: boolean; retryAfter: number } {
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || now > entry.resetAt) {
    hits.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { allowed: true, retryAfter: 0 };
  }
  entry.count += 1;
  if (entry.count > RATE_MAX) {
    return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { allowed: true, retryAfter: 0 };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!admin) {
    console.error('Supabase service role client is not configured');
    return res.status(503).json({ error: 'Server is not configured' });
  }

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData?.user) return res.status(401).json({ error: 'Unauthorized' });

  const limit = rateLimit(`uid:${authData.user.id}`);
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfter));
    return res.status(429).json({ error: 'Search temporarily unavailable, try again shortly.' });
  }

  // Same endpoint serves both directions: ?q= searches, ?lat=&lon= names a
  // point. One route keeps the auth, the rate limit and the outbound
  // throttle in a single place rather than duplicated across two.
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const isReverse = Number.isFinite(lat) && Number.isFinite(lon);

  try {
    if (isReverse) {
      const place = await reverseGeocode(lat, lon);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      return res.status(200).json({ place });
    }
    const results = await geocode(q);
    // Place names are stable; letting the browser reuse a result for a few
    // minutes takes further load off Nominatim.
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.status(200).json({ results });
  } catch (err) {
    if (err instanceof GeocodeError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('geocode failed:', err);
    return res.status(502).json({ error: 'Location search failed.' });
  }
}
