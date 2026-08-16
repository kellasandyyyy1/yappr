/**
 * Client-side login throttling.
 *
 * SCOPE — read this before relying on it:
 * Sign-in goes straight from the browser to Supabase's GoTrue endpoint, so our
 * Express server never sees an attempt and cannot block one. Anything enforced
 * here lives in the attacker's own browser and is bypassable by calling the
 * REST endpoint directly. This is a usability guardrail and a speed bump for
 * casual credential stuffing — NOT a security boundary.
 *
 * The actual server-side controls are, in order of importance:
 *   1. Auth → Attack Protection → CAPTCHA (hCaptcha/Turnstile), which GoTrue
 *      verifies itself, so it cannot be skipped by calling the API directly
 *      the way the in-page CaptchaGate can
 *   2. Auth → Rate Limits: the per-IP sign-in cap
 *   3. GoTrue's `over_request_rate_limit` backoff
 * All three are dashboard settings, not code. See SECURITY.md.
 */

import { migrateStorageKey } from './brand';

const STORAGE_KEY = 'yappr:login-attempts';
// Adopt any in-flight lockout recorded under the old key — renaming it blind
// would hand anyone mid-lockout a clean slate.
migrateStorageKey('privy:login-attempts', STORAGE_KEY);

/** Failures allowed before a lockout begins. */
export const MAX_ATTEMPTS = 5;
/** Failures after which a CAPTCHA is demanded on every further attempt. */
export const CAPTCHA_AFTER = 3;
/** Attempt counters older than this are forgotten. */
const WINDOW_MS = 15 * 60 * 1000;
/** Lockout grows 1m → 2m → 4m → 8m → 15m and holds. */
const BACKOFF_MS = [60_000, 120_000, 240_000, 480_000, 900_000];

interface AttemptRecord {
  /** Failures inside the current window. */
  count: number;
  /** Epoch ms of the most recent failure. */
  last: number;
  /** Epoch ms until which sign-in is refused. */
  lockedUntil: number;
}

type Store = Record<string, AttemptRecord>;

function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  try {
    // Drop stale entries so the key can't grow without bound.
    const now = Date.now();
    for (const [key, record] of Object.entries(store)) {
      if (now - record.last > WINDOW_MS && record.lockedUntil < now) delete store[key];
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* storage unavailable — throttling degrades to off, which is fail-open by design */
  }
}

/**
 * Keys the counter by account, plus a shared bucket approximating "this
 * device". Hashing keeps raw addresses out of localStorage.
 */
function keyFor(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = (hash << 5) - hash + email.charCodeAt(i);
    hash |= 0;
  }
  return `a:${Math.abs(hash).toString(36)}`;
}

const DEVICE_KEY = 'd:all';

export interface ThrottleState {
  /** False when the attempt must be refused outright. */
  allowed: boolean;
  /** Seconds remaining on the lockout. */
  retryAfterSeconds: number;
  /** Failures recorded for this account in the window. */
  attempts: number;
  /** True once a CAPTCHA must be solved before submitting. */
  captchaRequired: boolean;
  /** Attempts left before lockout. */
  remaining: number;
}

function evaluate(record: AttemptRecord | undefined, now: number): AttemptRecord {
  if (!record) return { count: 0, last: 0, lockedUntil: 0 };
  // Window expired and no active lock — reset.
  if (now - record.last > WINDOW_MS && record.lockedUntil <= now) {
    return { count: 0, last: 0, lockedUntil: 0 };
  }
  return record;
}

export function getThrottleState(email: string): ThrottleState {
  const now = Date.now();
  const store = readStore();
  const account = evaluate(store[keyFor(email)], now);
  const device = evaluate(store[DEVICE_KEY], now);

  // The stricter of the two buckets wins.
  const lockedUntil = Math.max(account.lockedUntil, device.lockedUntil);
  const attempts = Math.max(account.count, device.count);

  return {
    allowed: lockedUntil <= now,
    retryAfterSeconds: Math.max(0, Math.ceil((lockedUntil - now) / 1000)),
    attempts,
    captchaRequired: attempts >= CAPTCHA_AFTER,
    remaining: Math.max(0, MAX_ATTEMPTS - attempts),
  };
}

/** Records a failed attempt and returns the resulting state. */
export function recordFailure(email: string): ThrottleState {
  const now = Date.now();
  const store = readStore();

  for (const key of [keyFor(email), DEVICE_KEY]) {
    const record = evaluate(store[key], now);
    record.count += 1;
    record.last = now;
    if (record.count >= MAX_ATTEMPTS) {
      const step = Math.min(record.count - MAX_ATTEMPTS, BACKOFF_MS.length - 1);
      record.lockedUntil = now + BACKOFF_MS[step];
    }
    store[key] = record;
  }

  writeStore(store);
  return getThrottleState(email);
}

/** Clears counters for an account after a successful sign-in. */
export function recordSuccess(email: string): void {
  const store = readStore();
  delete store[keyFor(email)];
  delete store[DEVICE_KEY];
  writeStore(store);
}

export function formatRetryAfter(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}
