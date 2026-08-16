/**
 * Security event recording and new-device alerting.
 *
 * Records sign-ins, password changes and 2FA changes to the `security_events`
 * table, and alerts the account owner when a sign-in arrives from a device we
 * haven't seen before.
 *
 * APPEND-ONLY: the table has SELECT and INSERT policies and deliberately no
 * UPDATE or DELETE policy, so a stolen session cannot erase the record of its
 * own sign-in. Under Firestore this was a subcollection whose rules could only
 * approximate that.
 *
 * DELIVERY: alerts go out over the app's existing Web Push channel and are
 * written to the user's event log, which is what this codebase can actually
 * deliver today. Email alerts need an outbound mail transport (SES, Postmark,
 * Resend) wired into server.ts — `notifyByEmail` below is the seam for that
 * and currently no-ops with a warning rather than pretending to send.
 */

import { supabase } from './supabase';
import { sendPushNotification } from './sendPush';
import { migrateStorageKey } from './brand';

export type SecurityEventType =
  | 'sign_in'
  | 'sign_in_new_device'
  | 'password_changed'
  | 'password_reset_requested'
  | 'mfa_enrolled'
  | 'mfa_removed';

const DEVICE_ID_KEY = 'yappr:device-id';
// Carry the existing id across, otherwise every browser looks brand new and
// every user gets a spurious "new device" security alert on next sign-in.
migrateStorageKey('privy:device-id', DEVICE_ID_KEY);

/**
 * A stable, non-identifying id for this browser profile.
 *
 * Deliberately random rather than a fingerprint: fingerprinting is both a
 * privacy problem and unreliable. This only needs to answer "have I signed in
 * from this browser before?", and a random id in localStorage does that.
 */
export function getDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    return 'unknown-device';
  }
}

/** Coarse, human-readable device label. No fingerprinting entropy retained. */
export function describeDevice(): string {
  const ua = navigator.userAgent;
  const browser =
    /Edg\//.test(ua) ? 'Edge' :
    /OPR\//.test(ua) ? 'Opera' :
    /Chrome\//.test(ua) ? 'Chrome' :
    /Safari\//.test(ua) && !/Chrome/.test(ua) ? 'Safari' :
    /Firefox\//.test(ua) ? 'Firefox' : 'Unknown browser';

  const os =
    /Windows/.test(ua) ? 'Windows' :
    /Android/.test(ua) ? 'Android' :
    /iPhone|iPad|iPod/.test(ua) ? 'iOS' :
    /Mac OS X/.test(ua) ? 'macOS' :
    /Linux/.test(ua) ? 'Linux' : 'Unknown OS';

  return `${browser} on ${os}`;
}

export interface SecurityEvent {
  type: SecurityEventType;
  userId: string;
  deviceId: string;
  deviceLabel: string;
  createdAt: unknown;
}

/** Appends to the user's tamper-evident event log. Never throws. */
export async function recordSecurityEvent(
  userId: string,
  type: SecurityEventType
): Promise<void> {
  try {
    await supabase.from('security_events').insert({
      user_id: userId,
      type,
      device_id: getDeviceId(),
      device_label: describeDevice(),
    });
  } catch (err) {
    // Logging failure must never block sign-in.
    console.warn('[security] could not record event', { type });
  }
}

/**
 * Seam for outbound email alerts.
 *
 * Intentionally not implemented: this app has no mail transport, and a
 * function that silently drops mail is worse than one that says so. Wire this
 * to a `/api/security-alert` route in server.ts once a provider is chosen.
 */
async function notifyByEmail(userId: string, subject: string): Promise<void> {
  console.warn(
    `[security] email alert not sent ("${subject}") — no mail transport configured. ` +
    'See SECURITY.md ("Email alerts").'
  );
  void userId;
}

/**
 * Called after a successful sign-in. Detects whether this browser has been
 * used for the account before and alerts the owner if not.
 *
 * NOTE ON IP/LOCATION: the browser cannot read its own public IP, and
 * geolocating from the client is both unreliable and prompts the user. The
 * table carries an `ip_address` column for exactly this, but only something
 * server-side can fill it — a Supabase Auth Hook, which does receive the
 * request IP. See SECURITY.md.
 */
export async function handlePostSignIn(userId: string): Promise<void> {
  const deviceId = getDeviceId();

  try {
    const { count, error } = await supabase
      .from('security_events')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('device_id', deviceId);
    if (error) throw error;

    const isNewDevice = (count ?? 0) === 0;
    await recordSecurityEvent(userId, isNewDevice ? 'sign_in_new_device' : 'sign_in');

    if (isNewDevice) {
      const label = describeDevice();
      sendPushNotification(
        userId,
        'New sign-in to your account',
        `Someone signed in from ${label}. If this wasn't you, change your password now.`,
        '/profile'
      );
      await notifyByEmail(userId, `New sign-in from ${label}`);
    }
  } catch (err) {
    console.warn('[security] new-device check failed');
  }
}

/** Called after a successful password change. */
export async function handlePasswordChanged(userId: string): Promise<void> {
  await recordSecurityEvent(userId, 'password_changed');
  sendPushNotification(
    userId,
    'Your password was changed',
    "If you didn't do this, reset your password immediately.",
    '/profile'
  );
  await notifyByEmail(userId, 'Your Yappr password was changed');
}
