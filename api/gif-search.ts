import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { searchGifs, TenorSearchError } from './_tenor';

/**
 * GET /api/gif-search?q=… — proxied Tenor search.
 *
 * Same shape as /api/youtube-search, for the same two reasons: TENOR_API_KEY
 * must never reach the browser, and an unauthenticated proxy would let anyone
 * spend our rate limit without needing the key at all.
 *
 * An empty q returns Tenor's featured set, so the picker opens with content.
 */

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TENOR_API_KEY = process.env.TENOR_API_KEY;

const admin =
  SUPABASE_URL && SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null;

/**
 * Per-user rate limit.
 *
 * HONEST SCOPE: this Map lives in one warm lambda instance and Vercel runs
 * many, so it bounds a runaway client against a single instance and nothing
 * more. A global limit needs shared state (Vercel KV, or a counter table).
 * Deliberately not added here rather than left looking effective.
 */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 40;
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
  if (!TENOR_API_KEY) {
    // Named explicitly. "GIF search returns nothing" is otherwise
    // indistinguishable from "no results", and this project has already lost
    // time to exactly that ambiguity with VAPID.
    console.error('TENOR_API_KEY is not set — GIF search is disabled');
    return res.status(503).json({ error: 'GIF search is not configured' });
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
    return res.status(429).json({ error: 'Too many searches. Slow down a moment.' });
  }

  const q = typeof req.query.q === 'string' ? req.query.q : '';

  try {
    const gifs = await searchGifs(q, TENOR_API_KEY);
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.status(200).json({ gifs });
  } catch (err) {
    if (err instanceof TenorSearchError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('gif-search failed:', err);
    return res.status(502).json({ error: 'GIF search failed' });
  }
}
