/**
 * Service worker registration, update handling, and the install prompt.
 *
 * Registration is done here rather than by vite-plugin-pwa's auto-injected
 * snippet (`injectRegister: null`) so the update and install flows can drive
 * real UI instead of a browser default.
 *
 * ── ONE WORKER, TWO JOBS ─────────────────────────────────────────────────────
 * `src/lib/pushNotifications.ts` used to call `navigator.serviceWorker
 * .register('/sw.js')` itself. Both call sites now go through
 * `ensureServiceWorker()`, which registers once and hands back the same
 * promise. Registering the same scope twice is not fatal, but it races: whoever
 * calls second can get a registration whose `pushManager` is not ready, and the
 * push subscription silently fails to attach.
 */

import { registerSW } from 'virtual:pwa-register';

// --- Registration ------------------------------------------------------------

let registrationPromise: Promise<ServiceWorkerRegistration | undefined> | null = null;
let updateServiceWorker: ((reload?: boolean) => Promise<void>) | null = null;

/** Fires when a new worker is waiting. Wire to whatever prompts the user. */
type UpdateListener = () => void;
const updateListeners = new Set<UpdateListener>();

export function isServiceWorkerSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

/**
 * Registers the worker once per page load and resolves with its registration.
 * Safe to call from anywhere; later callers reuse the first promise.
 */
/**
 * Removes any service worker and cache left behind by a production build.
 *
 * WHY THIS IS NECESSARY
 * Running the production server once registers a worker that precaches the
 * built app shell. Switching back to `npm run dev` does NOT undo that: the
 * worker is still registered for the origin, it keeps serving the precached
 * `index.html`, and that HTML points at hashed `/assets/index-*.js` files which
 * are precached too. The dev server is running and being completely bypassed.
 *
 * The symptom is brutal to diagnose — source edits have no effect, the console
 * shows a hashed bundle name instead of `/src/main.tsx`, and values compiled
 * into the old build (an API key, for instance) keep being sent long after the
 * source was fixed. That is exactly what happened here.
 *
 * In dev we therefore tear down any existing worker and delete its caches
 * before registering anything. Costs one pass over the cache list on startup.
 */
async function clearStaleWorkers(): Promise<void> {
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const registration of registrations) {
      await registration.unregister();
      console.warn('[pwa] dev: unregistered a stale service worker', registration.scope);
    }
    const names = await caches.keys();
    await Promise.all(names.map((name) => caches.delete(name)));
    if (names.length > 0) console.warn('[pwa] dev: cleared caches', names);
  } catch (err) {
    console.warn('[pwa] dev: could not clear stale workers', err);
  }
}

export function ensureServiceWorker(): Promise<ServiceWorkerRegistration | undefined> {
  if (registrationPromise) return registrationPromise;

  if (!isServiceWorkerSupported()) {
    // Not an error: Firefox private windows and some embedded webviews have no
    // service worker at all. The app must stay fully functional without one.
    console.info('[pwa] service workers are not supported here — skipping');
    registrationPromise = Promise.resolve(undefined);
    return registrationPromise;
  }

  // In dev, never let a worker from a previous production build stay in
  // control. The service worker is not what you are debugging in dev, and a
  // stale one silently serves an old bundle in place of your source.
  if (import.meta.env.DEV) {
    registrationPromise = clearStaleWorkers().then(() => undefined);
    return registrationPromise;
  }

  registrationPromise = new Promise((resolve) => {
    updateServiceWorker = registerSW({
      immediate: true,
      onNeedRefresh() {
        // A new build is waiting. It will not take over until every tab is
        // closed, so ask rather than leaving the user on stale code.
        for (const listener of updateListeners) listener();
      },
      onOfflineReady() {
        console.info('[pwa] app shell cached — offline load is available');
      },
      onRegisteredSW(url, registration) {
        console.info('[pwa] service worker registered', url);
        resolve(registration);
      },
      onRegisterError(error) {
        console.error('[pwa] service worker registration failed', error);
        resolve(undefined);
      },
    });
  });

  return registrationPromise;
}

export function onUpdateAvailable(listener: UpdateListener): () => void {
  updateListeners.add(listener);
  return () => updateListeners.delete(listener);
}

/** Activates the waiting worker and reloads onto the new build. */
export async function applyUpdate(): Promise<void> {
  if (updateServiceWorker) await updateServiceWorker(true);
}

// --- Install prompt ----------------------------------------------------------

/**
 * The event Chromium fires when the app meets the installability bar.
 *
 * Not in TypeScript's DOM lib, because it is not a standard — which is also why
 * the install button cannot be the only route to installing. See below.
 */
export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
type InstallListener = (available: boolean) => void;
const installListeners = new Set<InstallListener>();

function notifyInstall(available: boolean) {
  for (const listener of installListeners) listener(available);
}

/**
 * True when the app is already running as an installed PWA, in which case no
 * install affordance should be shown. `standalone` on navigator is the iOS
 * Safari spelling; the media query covers everyone else.
 */
export function isRunningStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/**
 * iOS Safari never fires `beforeinstallprompt` and has no programmatic install.
 * Add to Home Screen is a manual Share-sheet action, so the only thing we can
 * offer there is instructions — detected so the UI can say the right thing
 * rather than showing a button that could never work.
 */
export function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ reports as a Mac; the touch point count gives it away.
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const webkit = /WebKit/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  return iOS && webkit;
}

export function initInstallPrompt(): () => void {
  if (typeof window === 'undefined') return () => {};

  const onBeforeInstallPrompt = (event: Event) => {
    // Suppress Chromium's own mini-infobar so the custom banner is the only
    // prompt the user sees.
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    notifyInstall(true);
  };

  const onAppInstalled = () => {
    // The prompt is single-use and is not valid after installation.
    deferredPrompt = null;
    notifyInstall(false);
    console.info('[pwa] app installed');
  };

  window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
  window.addEventListener('appinstalled', onAppInstalled);

  return () => {
    window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.removeEventListener('appinstalled', onAppInstalled);
  };
}

export function onInstallAvailabilityChange(listener: InstallListener): () => void {
  installListeners.add(listener);
  // Report the current state immediately — the event may already have fired
  // before this component mounted.
  listener(deferredPrompt !== null);
  return () => installListeners.delete(listener);
}

/** Shows the native install dialog. Returns true if the user accepted. */
export async function promptInstall(): Promise<boolean> {
  if (!deferredPrompt) return false;
  const prompt = deferredPrompt;
  // Cleared up front: the event cannot be reused, and leaving it set would let
  // a second click call prompt() again, which throws.
  deferredPrompt = null;
  notifyInstall(false);

  try {
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    return outcome === 'accepted';
  } catch (err) {
    console.warn('[pwa] install prompt failed', err);
    return false;
  }
}
