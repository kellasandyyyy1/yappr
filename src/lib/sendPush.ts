import { supabase } from './supabase';

/**
 * Triggers a Web Push notification to another user.
 *
 * The request carries the caller's Supabase access token. The server verifies
 * it before sending anything — previously this endpoint was unauthenticated, so
 * anyone who found it could push arbitrary notification text to any user of the
 * app. `server.ts` must verify with `supabase.auth.getUser(jwt)` now rather than
 * `firebase-admin`; see MIGRATION.md § Cloud Functions.
 */
export async function sendPushNotification(
  toUserId: string,
  title: string,
  body: string,
  url?: string
) {
  try {
    // getSession() reads the cached token and refreshes it only near expiry —
    // same contract as Firebase's getIdToken().
    const { data } = await supabase.auth.getSession();
    const accessToken = data.session?.access_token;
    if (!accessToken) return { success: false, error: 'not-authenticated' };

    const response = await fetch('/api/send-push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ toUserId, title, body, url }),
    });

    if (!response.ok) {
      // Don't surface server text to the console; status is enough to debug.
      return { success: false, status: response.status };
    }
    return await response.json();
  } catch (error) {
    console.error('Error sending push notification:', error);
    return { success: false };
  }
}
