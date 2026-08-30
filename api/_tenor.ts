/**
 * Tenor GIF search, server side only.
 *
 * Underscore-prefixed so Vercel does not expose it as an endpoint — it is
 * shared by api/gif-search.ts (production) and the Express route in server.ts
 * (local dev), so the two cannot drift apart. Same shape as api/_youtube.ts,
 * deliberately.
 *
 * The key stays on the server for the same reason the YouTube one does: it is
 * billed to our project and an HTTP-referrer restriction is a second layer, not
 * the control.
 */

export interface Gif {
  id: string;
  /** Full-size animated GIF — this is what gets stored on the post or message. */
  url: string;
  /** Small animated GIF, for the picker grid and any thumbnail rendering. */
  previewUrl: string;
  /** Alt text. Tenor's content_description, e.g. "cat typing furiously". */
  description: string;
  width: number;
  height: number;
}

export class TenorSearchError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'TenorSearchError';
  }
}

const BASE = 'https://tenor.googleapis.com/v2';

/**
 * Identifies this app to Tenor. Not a secret — it scopes rate limiting and
 * result personalisation per integration, and Tenor asks for it on every call.
 */
const CLIENT_KEY = 'yappr';

/**
 * A type-ahead re-issues the same query constantly: back a character, forward
 * again, or two people searching "cat" a minute apart. Per-instance and
 * therefore partial — Vercel runs many lambdas — so it reduces request volume
 * rather than bounding it.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;
const cache = new Map<string, { at: number; gifs: Gif[] }>();

const cacheGet = (key: string): Gif[] | null => {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, hit); // refresh recency for the LRU eviction below
  return hit.gifs;
};

const cacheSet = (key: string, gifs: Gif[]) => {
  cache.set(key, { at: Date.now(), gifs });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
};

/**
 * Maps Tenor's media_formats into the two URLs the app needs.
 *
 * A result missing either format is dropped rather than passed through with a
 * blank src: `gif` is what gets stored on the post, `tinygif` is what the
 * picker grid renders, and a card with neither is not a usable choice.
 */
const mapResults = (results: any[]): Gif[] =>
  (results ?? [])
    .map((r) => {
      const full = r?.media_formats?.gif;
      const preview = r?.media_formats?.tinygif ?? r?.media_formats?.nanogif;
      if (!full?.url || !preview?.url) return null;
      const [w, h] = Array.isArray(full.dims) ? full.dims : [0, 0];
      return {
        id: String(r.id ?? full.url),
        url: full.url as string,
        previewUrl: preview.url as string,
        description: String(r.content_description ?? 'GIF'),
        width: Number(w) || 0,
        height: Number(h) || 0,
      } satisfies Gif;
    })
    .filter((g): g is Gif => g !== null);

async function call(path: string, params: URLSearchParams): Promise<any[]> {
  const res = await fetch(`${BASE}/${path}?${params}`);
  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const detail = body?.error?.message ?? body?.error ?? `HTTP ${res.status}`;
    // 403 from Tenor is almost always the key: absent, wrong, or with the Tenor
    // API not enabled on the Google Cloud project. Saying so beats "failed".
    if (res.status === 403) {
      throw new TenorSearchError('GIF search was refused — check TENOR_API_KEY.', 502);
    }
    if (res.status === 429) {
      throw new TenorSearchError('GIF search is rate limited. Try again shortly.', 429);
    }
    throw new TenorSearchError(`GIF search failed: ${detail}`, 502);
  }

  return body?.results ?? [];
}

/**
 * Searches for GIFs. An empty query returns Tenor's featured set, so the picker
 * has something to show before the first keystroke rather than an empty grid.
 */
export async function searchGifs(
  rawQuery: string,
  apiKey: string,
  limit = 24
): Promise<Gif[]> {
  const query = rawQuery.trim().slice(0, 100);
  const bounded = String(Math.min(Math.max(limit, 1), 50));
  const cacheKey = `${query.toLowerCase()}|${bounded}`;

  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({
    key: apiKey,
    client_key: CLIENT_KEY,
    limit: bounded,
    // Only the two formats that are actually used. Tenor returns every format
    // it has otherwise, which is a much larger response for no benefit.
    media_filter: 'gif,tinygif,nanogif',
    contentfilter: 'medium',
  });
  if (query) params.set('q', query);

  const results = await call(query ? 'search' : 'featured', params);
  const gifs = mapResults(results);
  cacheSet(cacheKey, gifs);
  return gifs;
}
