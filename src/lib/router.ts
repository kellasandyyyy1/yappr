import { useState, useEffect } from 'react';

/**
 * Minimal path router.
 *
 * The app navigates by `currentView` state, which is fine for the logged-in
 * shell but gives the legal pages no real URL — and a privacy policy has to
 * be linkable from outside the app, shareable, and reachable while signed
 * out. Rather than pull in react-router and restructure every view for the
 * sake of two static documents, this maps `window.location.pathname` to a
 * value the shell can branch on.
 *
 * Deep links already work: Vite serves index.html for unknown paths in dev
 * (`appType: 'spa'`) and the Express catch-all does the same in production.
 */

/**
 * Paths that render outside the authenticated shell.
 *
 * `/reset-password` must be here. A recovery link establishes a session, so
 * without an explicit public route the app would treat the visitor as signed
 * in and drop them on the feed — with no way to set the new password they came
 * to set. It was missing entirely: reset emails pointed at a path nothing
 * served.
 */
export const PUBLIC_ROUTES = ['/privacy-policy', '/terms-of-conditions', '/reset-password'] as const;
export type PublicRoute = (typeof PUBLIC_ROUTES)[number];

export function isPublicRoute(pathname: string): pathname is PublicRoute {
  return (PUBLIC_ROUTES as readonly string[]).includes(normalizePath(pathname));
}

/** Strips a trailing slash so `/privacy-policy/` matches `/privacy-policy`. */
export function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname;
}

/** Re-renders on back/forward and on `navigate()`. */
export function usePathname(): string {
  const [pathname, setPathname] = useState(() => normalizePath(window.location.pathname));

  useEffect(() => {
    const sync = () => setPathname(normalizePath(window.location.pathname));
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  return pathname;
}

/** Client-side navigation. Same-tab, no reload, keeps history working. */
export function navigate(path: string): void {
  if (normalizePath(window.location.pathname) === normalizePath(path)) return;
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo(0, 0);
}

/** Returns to the previous page, or falls back to the app root. */
export function goBack(fallback = '/'): void {
  if (window.history.length > 1) {
    window.history.back();
  } else {
    navigate(fallback);
  }
}
