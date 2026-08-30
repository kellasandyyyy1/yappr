/**
 * Nominatim geocoding, server side only.
 *
 * Underscore-prefixed so Vercel does not expose it as an endpoint — shared by
 * api/geocode.ts (production) and the Express route in server.ts (dev), so the
 * two cannot drift.
 *
 * ── WHY THIS IS PROXIED, WHEN THERE IS NO KEY TO HIDE ───────────────────────
 * Nominatim is free and unauthenticated, so the usual reason (a secret) does
 * not apply. Two others do:
 *
 *   1. Their usage policy REQUIRES a descriptive User-Agent identifying the
 *      application, and blocks generic or missing ones. A browser cannot set
 *      User-Agent on a fetch — it is a forbidden header — so a client-side
 *      call physically cannot comply.
 *
 *   2. The policy allows at most 1 request/second for the whole application.
 *      Enforcing that per-browser is not enforcing it at all: ten people
 *      typing is ten requests a second. It has to be central.
 */

export interface GeocodeResult {
  /** Nominatim's place_id, stable enough to key a list by. */
  id: string;
  /** Short name: "London", "Eiffel Tower". */
  name: string;
  /** The rest of the address, for the second line. */
  context: string;
  /** The full display_name, stored on a history row. */
  label: string;
  latitude: number;
  longitude: number;
}

export class GeocodeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'GeocodeError';
  }
}

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';

/**
 * Identifies this app, as the usage policy requires. A contact address is part
 * of what makes it "descriptive" — it is how they reach someone if this starts
 * misbehaving, and a User-Agent without one is the kind they block.
 */
const USER_AGENT = 'Yappr/1.0 (social map pins; +https://yapprr.kelas.site; support@yappr.app)';

/**
 * Results barely change, and a type-ahead re-issues the same prefixes
 * constantly. A day is conservative for place names and takes most of the load
 * off Nominatim entirely, which matters far more here than the milliseconds.
 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map<string, { at: number; results: GeocodeResult[] }>();

const cacheGet = (key: string): GeocodeResult[] | null => {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit.results;
};

const cacheSet = (key: string, results: GeocodeResult[]) => {
  cache.set(key, { at: Date.now(), results });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
};

/**
 * Serialises outbound calls at most one per second.
 *
 * HONEST SCOPE: this is per lambda instance, and Vercel runs many. It bounds a
 * single warm instance and reduces the total rate; it does not guarantee the
 * global 1/sec the policy asks for. A real guarantee needs shared state — a
 * Redis token bucket, or a single always-on worker. What keeps this defensible
 * in the meantime is the cache above: on a type-ahead the overwhelming
 * majority of requests never leave the process.
 *
 * The chain is a promise queue rather than a timestamp check so that
 * concurrent callers wait their turn instead of all seeing "last call was 2s
 * ago" and firing together.
 */
const MIN_INTERVAL_MS = 1000;
let queue: Promise<void> = Promise.resolve();
let lastCallAt = 0;

function scheduled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = Math.max(0, lastCallAt + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
  });
  // The queue must not stop advancing when one call fails.
  queue = run.catch(() => {});
  return run.then(fn);
}

const mapResults = (rows: any[]): GeocodeResult[] =>
  (rows ?? [])
    .filter((r) => r?.lat && r?.lon)
    .map((r) => {
      const display = String(r.display_name ?? '');
      const parts = display.split(',').map((s: string) => s.trim());
      // Nominatim's `name` is absent on some result types, so the first
      // segment of display_name is the fallback rather than the whole string.
      const name = String(r.name || parts[0] || display);
      return {
        id: String(r.place_id ?? `${r.lat},${r.lon}`),
        name,
        context: parts.slice(1).join(', '),
        label: display,
        latitude: Number(r.lat),
        longitude: Number(r.lon),
      };
    });

/**
 * Searches for a place. Returns [] for a query too short to be meaningful,
 * without spending a request.
 */
export async function geocode(rawQuery: string, limit = 5): Promise<GeocodeResult[]> {
  const query = rawQuery.trim().slice(0, 200);
  if (query.length < 3) return [];

  const bounded = String(Math.min(Math.max(limit, 1), 10));
  const cacheKey = `${query.toLowerCase()}|${bounded}`;

  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({
    q: query,
    format: 'json',
    limit: bounded,
    addressdetails: '0',
  });

  const res = await scheduled(() =>
    fetch(`${ENDPOINT}?${params}`, {
      headers: {
        'User-Agent': USER_AGENT,
        // Sent as well as User-Agent: some deployments read one, some the other.
        Referer: 'https://yapprr.kelas.site',
        'Accept-Language': 'en',
      },
    })
  );

  if (!res.ok) {
    // 429 is the documented throttle; 403 is what a blocked User-Agent gets.
    // Both mean "back off", and both need to say so rather than surfacing as a
    // generic outage the reader cannot act on.
    if (res.status === 429 || res.status === 403) {
      throw new GeocodeError('Search temporarily unavailable, try again shortly.', 429);
    }
    throw new GeocodeError(`Location search failed (${res.status}).`, 502);
  }

  const body = await res.json().catch(() => []);
  if (!Array.isArray(body)) {
    throw new GeocodeError('Location search returned something unexpected.', 502);
  }

  const results = mapResults(body);
  cacheSet(cacheKey, results);
  return results;
}
