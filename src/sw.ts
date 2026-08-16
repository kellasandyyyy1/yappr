/// <reference lib="webworker" />

/**
 * Yappr service worker.
 *
 * ── WHY THIS FILE EXISTS RATHER THAN A GENERATED ONE ─────────────────────────
 * vite-plugin-pwa's default `generateSW` strategy writes the whole worker for
 * you. That was not usable here: this app already had a hand-written
 * `public/sw.js` handling Web Push (`push` and `notificationclick`), and a
 * generated worker would have replaced it. Only one service worker can control
 * a scope, so the two cannot coexist — push notifications would simply have
 * stopped working, silently, with nothing failing at build time.
 *
 * `injectManifest` keeps this file as the source of truth and has Workbox
 * inject the precache manifest into `self.__WB_MANIFEST` at build time. Push
 * and caching therefore live in the same worker, which is the only arrangement
 * that actually works.
 */

import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst, StaleWhileRevalidate } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

// =============================================================================
// Versioning and cache invalidation
// =============================================================================
// The precache manifest is content-hashed at build time, so a changed bundle
// gets a new revision and is refetched automatically — that is the mechanism
// that stops updates getting stuck on stale files. `cleanupOutdatedCaches`
// deletes precaches from previous Workbox versions so storage does not grow
// without bound across deploys.
//
// The runtime caches below are versioned by name instead. Bumping CACHE_VERSION
// orphans every one of them, and the activate handler deletes anything that is
// not on the current list — the escape hatch for "a cached response is wrong
// and I need every client to drop it".
const CACHE_VERSION = 'v1';
const CACHE = {
  images: `yappr-images-${CACHE_VERSION}`,
  static: `yappr-static-${CACHE_VERSION}`,
  supabase: `yappr-supabase-${CACHE_VERSION}`,
  fonts: `yappr-fonts-${CACHE_VERSION}`,
};

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

self.addEventListener('activate', (event) => {
  const keep = new Set(Object.values(CACHE));
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          // Only touch our own runtime caches. Workbox manages its precache
          // under a different prefix and cleans up after itself; deleting that
          // here would force a full refetch of the app shell on every activate.
          .filter((name) => name.startsWith('yappr-') && !keep.has(name))
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

// =============================================================================
// Update flow
// =============================================================================
// A waiting worker activates only when every tab is closed, which for a social
// app people leave open can be days. The client sends SKIP_WAITING when the
// user accepts the update prompt; see src/lib/pwa.ts.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

// =============================================================================
// Routing
// =============================================================================

// --- Navigations: served from the precache -----------------------------------
// NOTE: this is cache-first, not network-first. `createHandlerBoundToURL`
// returns the *precached* index.html, and Workbox's precache is cache-first by
// construction — it only refetches when the build hash changes. That is the
// right behaviour for an app shell (instant loads, works offline), but it does
// mean a client keeps the old shell until a new worker activates, which is what
// the update prompt exists to resolve.
//
// An earlier version of this comment claimed network-first. It was wrong, and
// the difference matters: it is why a stale shell can persist across deploys.
//
// Denylisted paths bypass it entirely: /api/* is real server work, and the
// legal documents are fetched as files rather than routed by React.
const navigationHandler = createHandlerBoundToURL('/index.html');
registerRoute(
  new NavigationRoute(navigationHandler, {
    denylist: [/^\/api\//, /^\/legal\//, /^\/sw\.js$/, /^\/manifest\.json$/],
  })
);

// --- Supabase: network-first, never cache-first ------------------------------
// Posts, messages and presence are the app. Serving them cache-first would show
// stale content as if it were live, which is worse than showing nothing.
// Network-first means a cached copy is only ever a fallback for a failed
// request, so offline degrades to "slightly old" rather than "broken".
//
// Auth and Realtime are deliberately excluded below — see the exclusions block.
registerRoute(
  ({ url, request }) =>
    url.hostname.endsWith('.supabase.co') &&
    url.pathname.startsWith('/rest/') &&
    request.method === 'GET',
  new NetworkFirst({
    cacheName: CACHE.supabase,
    networkTimeoutSeconds: 5,
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 }),
    ],
  })
);

// --- Supabase Storage objects: cache-first -----------------------------------
// Avatars, post images and voice notes are immutable at their URL — uploads are
// written to a new timestamped path rather than overwriting — so they are safe
// to serve from cache indefinitely. Signed URLs carry a query string and expire,
// hence the short-ish expiry and the entry cap.
registerRoute(
  ({ url }) => url.hostname.endsWith('.supabase.co') && url.pathname.startsWith('/storage/'),
  new CacheFirst({
    cacheName: CACHE.images,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30, purgeOnQuotaError: true }),
    ],
  })
);

// --- Same-origin images and icons: cache-first -------------------------------
registerRoute(
  ({ request, url }) => url.origin === self.location.origin && request.destination === 'image',
  new CacheFirst({
    cacheName: CACHE.static,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 30, purgeOnQuotaError: true }),
    ],
  })
);

// --- Google Fonts ------------------------------------------------------------
registerRoute(
  ({ url }) => url.origin === 'https://fonts.googleapis.com',
  new StaleWhileRevalidate({ cacheName: `${CACHE.fonts}-css` })
);
registerRoute(
  ({ url }) => url.origin === 'https://fonts.gstatic.com',
  new CacheFirst({
    cacheName: CACHE.fonts,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 }),
    ],
  })
);

// --- Deliberately NOT cached -------------------------------------------------
// Nothing below is registered, so these fall through to the network untouched:
//
//   • /auth/v1/*  — tokens and sessions. A cached auth response is a stale
//     session at best and a leaked one on a shared device at worst.
//   • /realtime/* — websockets, which a service worker cannot cache anyway.
//   • Anything non-GET — Workbox will not cache mutations, and an offline
//     "success" for a post or a message would be a lie. Background Sync is the
//     right tool if that is ever wanted; it is not wired up.
//   • /api/*      — our own endpoints, currently only push dispatch.

// =============================================================================
// Web Push — carried over verbatim from the previous public/sw.js
// =============================================================================

self.addEventListener('push', (event) => {
  const data = event.data
    ? event.data.json()
    : { title: 'Notification', body: 'New update!' };

  const options: NotificationOptions & { vibrate?: number[]; actions?: unknown[] } = {
    body: data.body,
    icon: '/favicon/icon-192.png',
    badge: '/favicon/favicon-48x48.png',
    data: data.url,
    vibrate: [100, 50, 100],
    actions: [{ action: 'open', title: 'View Details' }],
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const urlToOpen: string = event.notification.data || '/';

  event.waitUntil(
    (async () => {
      const windowClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      // Match on pathname rather than the full href. The original compared
      // `client.url === urlToOpen`, which never matched, because urlToOpen is a
      // path like "/post/123" and client.url is absolute — so every click
      // opened a duplicate tab instead of focusing the one already open.
      const target = new URL(urlToOpen, self.location.origin);
      for (const client of windowClients) {
        if (new URL(client.url).pathname === target.pathname && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target.href);
    })()
  );
});
