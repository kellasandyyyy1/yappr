import type { VercelRequest, VercelResponse } from '@vercel/node';
import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';
import { sweepDueReminders } from './_reminders';

/**
 * GET /api/reminders-due — notifies every accepted member of a space when one
 * of its reminders falls due.
 *
 * Driven by the Vercel cron entry in vercel.json, not by a user. It is the one
 * route in this app with no signed-in caller, which changes two things:
 *
 *   1. AUTHORISATION is a shared secret, not a session. Vercel sends
 *      `Authorization: Bearer $CRON_SECRET` on scheduled invocations. Without
 *      that check this is a public endpoint that anyone could hammer to fan
 *      out notifications early.
 *   2. RLS IS BYPASSED, deliberately. It reads notes across every space and
 *      writes notifications addressed to people the caller is not — no policy
 *      would ever permit that, and none should. Hence the service-role key,
 *      which must stay server-side.
 *
 * The sweep itself lives in ./_reminders so that this and the dev-server twin
 * in server.ts run the same code. Everything below is configuration and
 * authorisation; the behaviour is there.
 */

const VAPID_PUBLIC_KEY = process.env.VITE_VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:support@yappr.app';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

let pushEnabled = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (pushEnabled) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY!, VAPID_PRIVATE_KEY!);
  } catch (err) {
    // A malformed key throws here. Push degrades; the in-app notification rows
    // are the primary delivery and still get written.
    pushEnabled = false;
    console.error('Invalid VAPID keys — reminder push disabled:', err instanceof Error ? err.message : err);
  }
}

const admin =
  SUPABASE_URL && SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!admin) {
    console.error('Supabase service role client is not configured');
    return res.status(503).json({ error: 'Server is not configured' });
  }
  if (!CRON_SECRET) {
    // Refusing is the safe default. Running unauthenticated because the secret
    // is missing would turn a misconfiguration into an open endpoint.
    console.error('CRON_SECRET is not set — refusing to run');
    return res.status(503).json({ error: 'Server is not configured' });
  }
  if ((req.headers.authorization || '') !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await sweepDueReminders({ admin, push: pushEnabled ? webpush : null });
    if (result.warning) console.error('Reminder sweep:', result.warning);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('Reminder sweep failed:', err);
    return res.status(500).json({ error: 'Reminder sweep failed' });
  }
}
