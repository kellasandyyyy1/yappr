/**
 * Brand constants and the compatibility shims the Privy → Yappr rename needs.
 *
 * Three kinds of "privy" string existed in this codebase and only one of them
 * was safe to find-and-replace:
 *
 *   1. Display copy — "Welcome to Privy". Renamed outright; nothing depends on
 *      the old value.
 *   2. Identifiers that outlive a deploy — localStorage keys and the QR payload
 *      prefix. Renaming these does not break the build, it discards state that
 *      already exists in the wild. They are handled here, with the old value
 *      still honoured on read.
 *   3. Values owned by something outside this repo — the Supabase project name,
 *      the `@privy.app` contact addresses, the `privy123` entry in the password
 *      blocklist. Untouched; see the rebrand notes.
 */

export const BRAND_NAME = 'Yappr';

// --- QR profile codes --------------------------------------------------------

/**
 * Payload prefix for profile QR codes.
 *
 * Codes already generated — screenshotted, printed, saved to someone's camera
 * roll — encode the old prefix permanently. New codes use the new prefix and
 * the scanner accepts both, so nothing that already exists stops working.
 *
 * The legacy prefix can be dropped once no old code plausibly remains in
 * circulation; there is no deadline that forces it.
 */
export const QR_PROFILE_PREFIX = 'yappr:profile:';
const QR_LEGACY_PREFIXES = ['privy:profile:'];

export function buildProfileQr(userId: string): string {
  return `${QR_PROFILE_PREFIX}${userId}`;
}

/** Returns the user id from a scanned payload, or null if it is not ours. */
export function parseProfileQr(payload: string): string | null {
  for (const prefix of [QR_PROFILE_PREFIX, ...QR_LEGACY_PREFIXES]) {
    if (payload.startsWith(prefix)) {
      const id = payload.slice(prefix.length).trim();
      return id.length > 0 ? id : null;
    }
  }
  return null;
}

// --- localStorage ------------------------------------------------------------

/**
 * Reads a renamed localStorage key, adopting any value left under the old name.
 *
 * Renaming these silently would have had real consequences, none of which the
 * build or the tests would have caught:
 *
 *   • `privy:device-id` — every existing browser would look brand new, so every
 *     user gets a "new sign-in from an unrecognised device" security alert the
 *     next time they log in. Alarming, and it trains people to ignore the one
 *     alert that matters.
 *   • `privy:login-attempts` — anyone part-way through a lockout gets a clean
 *     slate, which quietly resets a brute-force control.
 *   • `privy:recent-searches` — cosmetic, but it is still the user's data.
 *
 * Call once at module load, before the key is used.
 */
export function migrateStorageKey(oldKey: string, newKey: string): void {
  try {
    if (localStorage.getItem(newKey) !== null) return; // already migrated
    const legacy = localStorage.getItem(oldKey);
    if (legacy === null) return;
    localStorage.setItem(newKey, legacy);
    localStorage.removeItem(oldKey);
  } catch {
    /* private mode or storage disabled — the caller's own fallbacks apply */
  }
}
