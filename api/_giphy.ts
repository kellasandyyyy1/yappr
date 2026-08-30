/**
 * GIPHY search, server side only.
 *
 * Underscore-prefixed so Vercel does not expose it as an endpoint — it is
 * shared by api/gif-search.ts (production) and the Express route in server.ts
 * (local dev), so the two cannot drift apart. Same shape as api/_youtube.ts.
 *
 * Replaces the Tenor integration, which was shut down.
 *
 * ── RATE LIMIT IS THE REAL CONSTRAINT ───────────────────────────────────────
 * A new GIPHY app gets a BETA key: 100 calls per HOUR and 50 objects per
 * request — and that 100/hour is for the whole app, not per user. Two people
 * typing in the picker can exhaust it in a couple of minutes without the cache
 * below. A production key has to be requested from GIPHY before real traffic.
 * That is why the cache TTL here is 30 minutes rather than the 10 used for
 * YouTube, and why an empty query is answered from /trending, which is one
 * cacheable call shared by everyone.
 */

export interface Gif {
  id: string;
  /** The rendition that gets attached to a post or message. */
  url: string;
  /** Small animated rendition, for the picker grid and thumbnails. */
  previewUrl: string;
  /** Alt text: GIPHY's alt_text when present, else the title. */
  description: string;
  width: number;
  height: number;
}

export class GifSearchError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'GifSearchError';
  }
}

const BASE = 'https://api.giphy.com/v1/gifs';

/** Beta keys cap a request at 50 objects; 25 is what the picker grid shows. */
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;

/**
 * 30 minutes, deliberately long. With a beta key allowing 100 calls an hour
 * across every user of the app, the cache is not an optimisation — it is what
 * keeps the feature usable at all.
 *
 * Per-instance and therefore partial: Vercel runs many lambdas, so this reduces
 * call volume rather than bounding it. Only a shared store (Vercel KV, or a
 * table) could actually bound it.
 */
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 300;
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

/** First rendition that exists and has a url. GIPHY omits renditions freely. */
const pick = (images: any, ...names: string[]) => {
  for (const name of names) {
    const r = images?.[name];
    if (r?.url) return r;
  }
  return null;
};

/**
 * Maps GIPHY's `images` bag down to the two URLs the app needs.
 *
 * A result missing either is dropped rather than passed through with a blank
 * src: one is what gets stored on the post, the other is what the grid renders,
 * and a card with neither is not a usable choice.
 */
const mapResults = (data: any[]): Gif[] =>
  (data ?? [])
    .map((g) => {
      // downsized before original: these are embedded in posts and chat and
      // then loaded by every viewer, and `original` is routinely 5-10MB.
      // downsized targets ~2MB for visually the same thing.
      const full = pick(g?.images, 'downsized', 'original');
      // fixed_height is an animated 200px-tall rendition — the right size for
      // the grid. preview_gif is much smaller but heavily degraded, so it is a
      // fallback rather than the default.
      const preview = pick(g?.images, 'fixed_height', 'fixed_height_downsampled', 'preview_gif');
      if (!full || !preview) return null;

      return {
        id: String(g.id ?? full.url),
        url: String(full.url),
        previewUrl: String(preview.url),
        description: String(g.alt_text || g.title || 'GIF'),
        width: Number(full.width) || 0,
        height: Number(full.height) || 0,
      } satisfies Gif;
    })
    .filter((g): g is Gif => g !== null);

async function call(path: string, params: URLSearchParams): Promise<any[]> {
  const res = await fetch(`${BASE}/${path}?${params}`);
  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const detail = body?.meta?.msg ?? body?.message ?? `HTTP ${res.status}`;

    // The two failures this will actually hit, both worth naming rather than
    // reporting as a generic outage.
    if (res.status === 429) {
      throw new GifSearchError(
        'GIF search has hit its hourly limit. A beta GIPHY key allows 100 calls an hour.',
        429
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new GifSearchError('GIF search was refused — check GIPHY_API_KEY.', 502);
    }
    throw new GifSearchError(`GIF search failed: ${detail}`, 502);
  }

  return body?.data ?? [];
}

/**
 * Searches for GIFs. An empty query returns GIPHY's trending set, so the picker
 * opens with content rather than an empty grid — and, being one query string
 * shared by everyone, it is nearly always served from cache.
 */
export async function searchGifs(
  rawQuery: string,
  apiKey: string,
  limit = DEFAULT_LIMIT
): Promise<Gif[]> {
  const query = rawQuery.trim().slice(0, 100);
  const bounded = String(Math.min(Math.max(limit, 1), MAX_LIMIT));
  const cacheKey = `${query.toLowerCase()}|${bounded}`;

  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({
    api_key: apiKey,
    limit: bounded,
    rating: 'pg-13',
    lang: 'en',
  });
  if (query) params.set('q', query);

  const data = await call(query ? 'search' : 'trending', params);
  const gifs = mapResults(data);
  cacheSet(cacheKey, gifs);
  return gifs;
}
