import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { searchMusic, YouTubeSearchError } from './_youtube';

/**
 * GET /api/youtube-search?q=… — proxied music search.
 *
 * Exists so YOUTUBE_API_KEY never reaches the browser. The key is a billable
 * credential: exposed client-side, anyone can drain the project's daily quota
 * and the app's song search simply stops working for everyone.
 *
 * Authenticated, because an open proxy is the same problem wearing a different
 * hat — it would let anyone spend our quota without even needing the key.
 */

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

const admin =
  SUPABASE_URL && SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null;

/**
 * Per-user rate limit.
 *
 * HONEST SCOPE: this Map lives in one warm lambda instance, and Vercel runs
 * many. It bounds a runaway client against a single instance; it is not a
 * global control. The real ceiling here is YouTube's own daily quota, which
 * this cannot raise — see api/_youtube.ts. A shared counter (Vercel KV, or a
 * table in Postgres) is what a real limit would need.
 */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 20;
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
  if (!YOUTUBE_API_KEY) {
    // Named explicitly: "search does nothing" is otherwise indistinguishable
    // from "no results", and this project has already lost time to exactly
    // that ambiguity with VAPID.
    console.error('YOUTUBE_API_KEY is not set — song search is disabled');
    return res.status(503).json({ error: 'Song search is not configured' });
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
  if (q.trim().length < 2) return res.status(200).json({ tracks: [] });

  try {
    const tracks = await searchMusic(q, YOUTUBE_API_KEY);
    // Short cache at the edge too: identical queries from different users
    // within the window never reach YouTube at all.
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.status(200).json({ tracks });
  } catch (err) {
    if (err instanceof YouTubeSearchError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('youtube-search failed:', err);
    return res.status(502).json({ error: 'Song search failed' });
  }
}
