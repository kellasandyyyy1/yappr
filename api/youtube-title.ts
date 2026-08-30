import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
// The .js extension is REQUIRED — package.json sets "type": "module" and
// Node's ESM loader does no extension guessing. See api/youtube-search.ts.
import { lookupTitle } from './_youtube.js';

/**
 * GET /api/youtube-title?id=… — the name of one video.
 *
 * For songs attached to a pin before 0021, which stored only a video id. New
 * pins carry their own title and never reach this.
 *
 * ── WHY THIS DOES NOT USE THE DATA API ──────────────────────────────────────
 * videos.list would cost quota against the same 10,000/day the song search
 * spends 100 units a call on, and filling in old titles is not worth competing
 * with the feature people actually use. YouTube's oEmbed endpoint returns the
 * title and channel for free, needs no key, and has no quota — it is a public
 * endpoint meant for exactly this.
 *
 * Authenticated anyway: an open proxy on our domain is someone else's
 * bandwidth budget, whatever it happens to be fetching.
 */

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const admin =
  SUPABASE_URL && SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null;

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

  const id = typeof req.query.id === 'string' ? req.query.id : '';
  // YouTube ids are 11 characters of [A-Za-z0-9_-]. Checking the shape keeps
  // arbitrary strings out of an outbound URL.
  if (!/^[\w-]{11}$/.test(id)) return res.status(400).json({ error: 'Bad video id' });

  try {
    const track = await lookupTitle(id);
    if (!track) return res.status(404).json({ error: 'No such video' });
    // A video's title effectively never changes, and a wrong-but-cached title
    // is a far smaller problem than a lookup on every pin open.
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return res.status(200).json(track);
  } catch (err) {
    console.error('youtube-title failed:', err);
    return res.status(502).json({ error: 'Lookup failed' });
  }
}
