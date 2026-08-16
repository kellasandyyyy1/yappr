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
