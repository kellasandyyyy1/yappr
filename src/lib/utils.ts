import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatTimeAgo(date: any) {
  // Postgres returns ISO strings. The `toDate()` branch is kept for any
  // Firestore Timestamp still in flight during the migration.
  const jsDate = date?.toDate ? date.toDate() : new Date(date);
  if (isNaN(jsDate.getTime())) return "Just now";

  const now = new Date();
  const diff = now.getTime() - jsDate.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  if (years > 0) return years === 1 ? '1 year ago' : `${years} years ago`;
  if (months > 0) return months === 1 ? '1 month ago' : `${months} months ago`;
  if (weeks > 0) return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
  if (days > 0) return days === 1 ? 'Yesterday' : `${days} days ago`;
  if (hours > 0) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  if (minutes > 0) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  if (seconds > 5) return `${seconds}s ago`;
  return "Just now";
}

// `handleFirestoreError` / `OperationType` / `FirestoreErrorInfo` were removed
// with the last Firestore call site. Worth recording why they are not simply
// being ported: the helper serialised the signed-in user's email, verification
// state and every linked provider identity into `console.error` on any failed
// read — so a permission denial wrote PII into the browser console and into
// whatever log collector was scraping it. It then re-threw a JSON blob of the
// same, which is what surfaced as unreadable error text in the UI.
//
// Call sites now log the error and nothing else.

/**
 * Turns anything thrown into something a person can read.
 *
 * `err instanceof Error ? err.message : String(err)` looks thorough and is
 * not: a Supabase PostgrestError is a plain object, not an Error, so it takes
 * the String() branch and renders as the literal text "[object Object]" — the
 * error is on screen and says nothing. Every error surface in this app that
 * can show a Supabase failure has to handle that shape.
 *
 * Includes the code when there is one, because "PGRST205" is the difference
 * between a missing table and a policy denial.
 */
export function describeError(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error && err.message) return err.message;

  if (err && typeof err === 'object') {
    const anyErr = err as Record<string, unknown>;
    const message =
      (typeof anyErr.message === 'string' && anyErr.message) ||
      (typeof anyErr.error_description === 'string' && anyErr.error_description) ||
      (typeof anyErr.error === 'string' && anyErr.error) ||
      '';
    const code = typeof anyErr.code === 'string' ? anyErr.code : '';
    const hint = typeof anyErr.hint === 'string' ? anyErr.hint : '';

    if (message) return [code && `${code}:`, message, hint && `(${hint})`].filter(Boolean).join(' ');

    // No recognisable message field. JSON beats "[object Object]" — it at
    // least carries whatever the failure did come with.
    try {
      const json = JSON.stringify(err);
      if (json && json !== '{}') return json;
    } catch {
      /* circular */
    }
  }

  return 'Something failed, and it gave no reason.';
}
