import { users as usersApi } from './db';
import type { User } from '../types';

/**
 * Legal document loading and consent tracking.
 *
 * Documents and their version live in `public/legal/` as static assets, so
 * editing the text, the date, or the version does not require a rebuild or a
 * redeploy — replace the files and the running app picks them up. Bumping
 * `version` in `manifest.json` is what triggers the re-acceptance prompt for
 * every signed-in user.
 */

export interface LegalDocumentMeta {
  title: string;
  file: string;
}

export interface LegalManifest {
  version: string;
  lastUpdated: string;
  contactEmail: string;
  documents: Record<string, LegalDocumentMeta>;
}

export const LEGAL_BASE = '/legal';

/**
 * Fallback used when the manifest can't be fetched.
 *
 * Deliberately conservative: an unknown version must never trigger a consent
 * wall, because a transient network failure would then lock every user out of
 * an app they already agreed to use.
 */
export const UNKNOWN_VERSION = '';

let manifestCache: LegalManifest | null = null;

export async function fetchLegalManifest(): Promise<LegalManifest | null> {
  if (manifestCache) return manifestCache;
  try {
    const response = await fetch(`${LEGAL_BASE}/manifest.json`, { cache: 'no-cache' });
    if (!response.ok) return null;
    const data = (await response.json()) as LegalManifest;
    if (!data?.version || !data?.documents) return null;
    manifestCache = data;
    return data;
  } catch {
    return null;
  }
}

const documentCache = new Map<string, string>();

/** Fetches the raw Markdown for a slug. Returns null if the slug is unknown. */
export async function fetchLegalDocument(slug: string): Promise<string | null> {
  const cached = documentCache.get(slug);
  if (cached) return cached;

  const manifest = await fetchLegalManifest();
  const meta = manifest?.documents?.[slug];
  if (!meta) return null;

  try {
    const response = await fetch(`${LEGAL_BASE}/${meta.file}`, { cache: 'no-cache' });
    if (!response.ok) return null;
    const text = await response.text();
    documentCache.set(slug, text);
    return text;
  } catch {
    return null;
  }
}

/** Formats an ISO date for display, falling back to the raw string. */
export function formatLegalDate(iso: string | undefined): string {
  if (!iso) return 'Unknown';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Whether this user must re-accept before continuing.
 *
 * Fails open on every uncertain case — no manifest, no version, user not
 * loaded — so an outage never becomes a lockout.
 */
export function needsReconsent(user: User | null, currentVersion: string): boolean {
  if (!user) return false;
  if (!currentVersion || currentVersion === UNKNOWN_VERSION) return false;
  return user.termsVersion !== currentVersion;
}

/**
 * Writes the compliance record: which version was accepted.
 *
 * Only the version is sent. `terms_accepted_at` is stamped by the
 * `users_stamp_consent_time` trigger from the server clock and is not granted
 * to this role at all, so the record cannot be back-dated by a tampered device
 * — a stronger guarantee than `serverTimestamp()`, which still relied on the
 * client asking for it.
 */
export async function recordConsent(uid: string, version: string): Promise<void> {
  await usersApi.update(uid, { termsVersion: version });
}
