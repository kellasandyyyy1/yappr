/**
 * YouTube Data API v3 search, server side only.
 *
 * Underscore-prefixed so Vercel does not expose it as an endpoint — it is
 * shared by api/youtube-search.ts (production) and the Express route in
 * server.ts (local dev), so the two cannot drift apart.
 *
 * ── WHY THIS IS PROXIED RATHER THAN CALLED FROM THE BROWSER ─────────────────
 * A YouTube Data API key sent to the client is readable by anyone who opens
 * devtools, and quota is billed to the project that owns it. An HTTP-referrer
 * restriction in Google Cloud Console helps but is trivially forged — it is a
 * second layer, not the control. Keeping the key on the server is the control.
 *
 * ── QUOTA IS THE REAL CONSTRAINT ────────────────────────────────────────────
 * search.list costs 100 units per call against a default 10,000/day project
 * quota: 100 searches per day for the entire app, not per user. That is why
 * this module caches aggressively and why the client debounces and enforces a
 * minimum query length. Raising it means requesting more quota from Google.
 */

export interface YouTubeTrack {
  youtubeId: string;
  title: string;
  artist: string;
  coverUrl: string;
}

export class YouTubeSearchError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'YouTubeSearchError';
  }
}

const ENDPOINT = 'https://www.googleapis.com/youtube/v3/search';

/**
 * Snippet text arrives HTML-escaped ("Tom &amp; Jerry", "don&#39;t"). It is
 * rendered as text by React, so without decoding the entities show literally.
 */
const decodeEntities = (s: string): string =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&'); // last, so "&amp;lt;" does not become "<"

/**
 * Short-lived response cache.
 *
 * A debounced type-ahead still re-issues the same query constantly — going
 * back a character and forward again, or two people searching the same artist.
 * At 100 quota units a call, serving those from memory is the difference
 * between the feature working all day and dying by lunchtime.
 *
 * Per-instance and therefore partial: Vercel runs many lambdas. It reduces
 * quota burn, it does not bound it.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;
const cache = new Map<string, { at: number; tracks: YouTubeTrack[] }>();

const cacheGet = (key: string): YouTubeTrack[] | null => {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  // Refresh recency for the LRU eviction below.
  cache.delete(key);
  cache.set(key, hit);
  return hit.tracks;
};

const cacheSet = (key: string, tracks: YouTubeTrack[]) => {
  cache.set(key, { at: Date.now(), tracks });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
};

const mapItems = (items: any[]): YouTubeTrack[] =>
  (items ?? [])
    .filter((it) => it?.id?.videoId && it?.snippet)
    .map((it) => ({
      youtubeId: it.id.videoId as string,
      title: decodeEntities(String(it.snippet.title ?? '')),
      artist: decodeEntities(String(it.snippet.channelTitle ?? '')),
      // medium (320x180) is the smallest that still looks right scaled up into
      // the 36px cover on a high-DPI screen.
      coverUrl:
        it.snippet.thumbnails?.medium?.url ??
        it.snippet.thumbnails?.default?.url ??
        `https://i.ytimg.com/vi/${it.id.videoId}/mqdefault.jpg`,
    }));

async function callSearch(params: URLSearchParams): Promise<any[]> {
  const res = await fetch(`${ENDPOINT}?${params}`);
  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const reason = body?.error?.errors?.[0]?.reason ?? '';
    const detail = body?.error?.message ?? `HTTP ${res.status}`;

    // Quota exhaustion is the failure this feature will actually hit, and it
    // needs to say so rather than reading as a generic outage.
    if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
      throw new YouTubeSearchError('Song search has hit its daily limit. Try again tomorrow.', 429);
    }
    if (reason === 'keyInvalid' || res.status === 400) {
      throw new YouTubeSearchError('Song search is misconfigured.', 502);
    }
    if (res.status === 403) {
      throw new YouTubeSearchError('Song search was refused by YouTube.', 502);
    }
    throw new YouTubeSearchError(`Song search failed: ${detail}`, 502);
  }

  return body?.items ?? [];
}

/**
 * Searches YouTube for music.
 *
 * `videoEmbeddable=true` is not an optimisation — it is what stops someone
 * picking a track that cannot play in our embed. Videos whose owner disabled
 * off-site playback return error 101/150 from the IFrame API, which this app
 * previously surfaced as a card stuck loading forever.
 */
export async function searchMusic(
  rawQuery: string,
  apiKey: string,
  maxResults = 12
): Promise<YouTubeTrack[]> {
  const query = rawQuery.trim().slice(0, 100);
  if (query.length < 2) return [];

  const cacheKey = `${query.toLowerCase()}|${maxResults}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const base = {
    part: 'snippet',
    type: 'video',
    videoEmbeddable: 'true',
    videoSyndicated: 'true',
    safeSearch: 'moderate',
    maxResults: String(Math.min(Math.max(maxResults, 1), 25)),
    key: apiKey,
    q: query,
  };

  // Category 10 is Music. It is a strong filter and occasionally excludes a
  // track that is genuinely there, so a miss falls back to an unfiltered
  // search biased toward music by the query itself. The fallback costs a
  // second 100 units, hence only on an empty result.
  let items = await callSearch(new URLSearchParams({ ...base, videoCategoryId: '10' }));
  if (items.length === 0) {
    items = await callSearch(new URLSearchParams({ ...base, q: `${query} music` }));
  }

  const tracks = mapItems(items);
  cacheSet(cacheKey, tracks);
  return tracks;
}
