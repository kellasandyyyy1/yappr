import { supabase } from './supabase';
import { ensureServiceWorker, isServiceWorkerSupported } from './pwa';

/**
 * Web Push subscription lifecycle.
 *
 * The subscription itself is a browser object and is entirely unaffected by the
 * Firebase → Supabase move; only where it is stored changed. Firestore held a
 * `subscriptions` collection with a nested `keys` map and no uniqueness, so the
 * same endpoint could accumulate duplicate documents and get pushed to twice.
 * `push_subscriptions.endpoint` is `unique`, so an upsert is the whole story.
 *
 * The keypair that used to be hardcoded here is in git history and must be
 * treated as compromised — see the matching note in server.ts. No fallback is
 * provided: a stale default would silently mint subscriptions the server can no
 * longer sign for, which looks like working push right up until nothing
 * arrives.
 */

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export async function registerPushNotifications() {
  if (!isServiceWorkerSupported() || !('PushManager' in window)) {
    console.warn('Push messaging is not supported');
    return;
  }
  if (!VAPID_PUBLIC_KEY) {
    console.warn('Push notifications disabled: VITE_VAPID_PUBLIC_KEY is not set.');
    return;
  }

  try {
    // Was `navigator.serviceWorker.register('/sw.js')`. Registering the same
    // scope from two places races: whichever call lands second can receive a
    // registration whose pushManager is not ready yet, and the subscription
    // silently fails to attach. ensureServiceWorker() registers once and hands
    // every caller the same registration.
    const registration = await ensureServiceWorker();
    if (!registration) {
      console.warn('Push notifications disabled: no service worker registration');
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      console.warn('Notification permission denied');
      return;
    }

    let subscription = await registration.pushManager.getSubscription();

    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    await saveSubscription(subscription);
  } catch (error) {
    console.error('Error registering push notifications:', error);
  }
}

async function saveSubscription(subscription: PushSubscription) {
  const { data } = await supabase.auth.getUser();
  const userId = data.user?.id;
  if (!userId) return;

  // toJSON() rather than the structuredClone-via-JSON dance the old code did;
  // PushSubscription defines it and it is what the keys actually live behind.
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    console.warn('[push] subscription is missing endpoint or keys');
    return;
  }

  // Upsert on the unique endpoint. Replaces the read-then-conditionally-insert
  // that raced with itself across tabs.
  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      user_id: userId,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
    },
    { onConflict: 'endpoint' }
  );
  if (error) console.warn('[push] could not save subscription', error.message);
}

export async function unregisterPushNotifications() {
  if (!('serviceWorker' in navigator)) return;

  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return;

  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;

  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();

  // `push_subscriptions_own` scopes the delete to this user, so the endpoint
  // filter alone is safe — another account's row cannot be reached.
  const { error } = await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
  if (error) console.warn('[push] could not remove subscription', error.message);
}
