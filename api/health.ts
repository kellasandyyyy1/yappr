import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * GET /api/health — liveness probe.
 *
 * Reports whether the two server-side secrets the push endpoint needs are
 * actually present in this environment. It reports presence only, never values,
 * so it is safe to leave public — and it turns "push silently does nothing"
 * into a single request that says which variable is missing. That is the exact
 * failure this project already hit once, when server.ts read process.env
 * without loading .env.local.
 */
export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    config: {
      vapidPublicKey: Boolean(process.env.VITE_VAPID_PUBLIC_KEY),
      vapidPrivateKey: Boolean(process.env.VAPID_PRIVATE_KEY),
      supabaseUrl: Boolean(process.env.VITE_SUPABASE_URL),
      supabaseServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    },
  });
}
