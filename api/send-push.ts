import type { VercelRequest, VercelResponse } from '@vercel/node';
import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';

/**
 * POST /api/send-push — dispatches a Web Push notification to one user.
 *
 * Ported from the Express route in server.ts, which Vercel never runs: it
 * auto-detects Vite, builds `dist/`, and serves it statically, so every route
 * defined in that file 404s in production.
 *
 * ── THE PORT FIXED TWO PRE-EXISTING BREAKS ───────────────────────────────────
 * The Express version was already dead before Vercel entered the picture:
 *
 *   1. It verified a FIREBASE ID token via `admin.auth().verifyIdToken()`. The
 *      client stopped sending one during the Supabase migration —
 *      `src/lib/sendPush.ts` now sends a Supabase access token — so every call
 *      would have 401'd.
 *   2. It read subscriptions from the FIRESTORE `subscriptions` collection,
 *      with a nested `keys` map. Subscriptions now live in Supabase
 *      `push_subscriptions`, as flat `p256dh` / `auth` columns.
 *
 * Fixing both removes `firebase-admin` from this path entirely, which is why
 * no Firebase service-account credentials are needed in the Vercel project.
 */

// --- Configuration -----------------------------------------------------------
// Read at module scope so a misconfiguration fails on the first invocation
// rather than intermittently.

const VAPID_PUBLIC_KEY = process.env.VITE_VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:support@yappr.app';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let pushEnabled = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (pushEnabled) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY!, VAPID_PRIVATE_KEY!);
  } catch (err) {
    // A malformed key throws here. Left unguarded it would take down the whole
    // function; push should degrade, not 500 every request.
    pushEnabled = false;
    console.error('Invalid VAPID keys — push disabled:', err instanceof Error ? err.message : err);
  }
}

/**
 * Service-role client. Bypasses RLS, which is required and intentional: this
 * endpoint reads the *recipient's* push subscriptions, and no RLS policy would
 * ever let the sender do that. It is why the key must stay server-side and must
 * never be exposed to the browser.
 */
const admin =
  SUPABASE_URL && SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null;

/**
 * Per-sender rate limit.
 *
 * HONEST SCOPE: this Map lives in one warm lambda instance. Vercel runs many
 * concurrently and recycles them freely, so a determined caller spreading
 * requests across instances is not bounded by it. It stops accidental loops and
 * a single client hammering one warm instance — nothing more.
 *
 * A real control needs shared state: Vercel KV, Upstash, or a counter table in
 * Postgres. Deliberately not added here rather than left looking effective.
 */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const senderHits = new Map<string, { count: number; resetAt: number }>();

function rateLimit(key: string): { allowed: boolean; retryAfter: number } {
  const now = Date.now();
  const entry = senderHits.get(key);
  if (!entry || now > entry.resetAt) {
    senderHits.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { allowed: true, retryAfter: 0 };
  }
  entry.count += 1;
  if (entry.count > RATE_MAX) {
    return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { allowed: true, retryAfter: 0 };
}

/** Bounded, non-empty string. These end up rendered on someone else's device. */
const isSafeString = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!pushEnabled) {
    return res.status(503).json({ error: 'Push notifications are not configured' });
  }
  if (!admin) {
    console.error('Supabase service role client is not configured');
    return res.status(503).json({ error: 'Server is not configured' });
  }

  // --- Authenticate the sender ----------------------------------------------
  // Without this the endpoint is an open relay: anyone could push arbitrary
  // notification text to any user by supplying their id.
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData?.user) {
    // No detail in the response — the caller learns only that it failed.
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const senderId = authData.user.id;

  const limit = rateLimit(`uid:${senderId}`);
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfter));
    return res.status(429).json({ error: 'Too many requests' });
  }

  // --- Validate ---------------------------------------------------------------
  const { toUserId, title, body, url } = (req.body ?? {}) as Record<string, unknown>;

  if (!isSafeString(toUserId, 128) || !isSafeString(title, 100) || !isSafeString(body, 500)) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  if (url !== undefined && (typeof url !== 'string' || url.length > 300 || !url.startsWith('/'))) {
    // Same-origin paths only. An absolute URL would let a caller redirect a
    // recipient anywhere from a notification they have reason to trust.
    return res.status(400).json({ error: 'Invalid request' });
  }

  // --- Dispatch ----------------------------------------------------------------
  try {
    const { data: subs, error: subsError } = await admin
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .eq('user_id', toUserId);

    if (subsError) {
      console.error('Could not read push subscriptions:', subsError.message);
      return res.status(500).json({ error: 'Failed to send push notification' });
    }
    if (!subs || subs.length === 0) {
      return res.status(200).json({ success: true, delivered: 0 });
    }

    const payload = JSON.stringify({ title, body, url: url || '/' });
    const expired: string[] = [];

    const results = await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload
          );
          return true;
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          // 404/410 mean the browser dropped the subscription. Collect and
          // delete in one statement rather than a round trip per failure.
          if (status === 404 || status === 410) expired.push(sub.id);
          else console.error('Push failed:', status, (err as Error).message);
          return false;
        }
      })
    );

    if (expired.length > 0) {
      const { error } = await admin.from('push_subscriptions').delete().in('id', expired);
      if (error) console.error('Could not prune expired subscriptions:', error.message);
    }

    return res.status(200).json({
      success: true,
      delivered: results.filter(Boolean).length,
      pruned: expired.length,
    });
  } catch (err) {
    console.error('Server push error:', err);
    return res.status(500).json({ error: 'Failed to send push notification' });
  }
}
