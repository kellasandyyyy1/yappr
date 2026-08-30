import { supabase } from './supabase';

/**
 * Client for the proxied GIF search at /api/gif-search.
 *
 * No API key here and no direct call to GIPHY — the key stays server-side (see
 * api/_giphy.ts). The browser only talks to our own origin, which is why no
 * connect-src change was needed. The GIF *images* do load from GIPHY's CDN, so
 * img-src allows https://*.giphy.com.
 */

export interface Gif {
  id: string;
  /** The rendition attached to a post or message. */
  url: string;
  /** Small animated rendition, for the picker grid and thumbnails. */
  previewUrl: string;
  description: string;
  width: number;
  height: number;
}

export class GifSearchError extends Error {}

/**
 * Searches for GIFs. An empty query returns GIPHY's trending set, so the picker
 * has something to show before the first keystroke.
 *
 * Takes an AbortSignal because a type-ahead fires overlapping requests and the
 * slowest must not land last and overwrite fresher results. An aborted call
 * rejects with a DOMException named 'AbortError'; callers ignore that rather
 * than surfacing it.
 */
export async function searchGifs(query: string, signal?: AbortSignal): Promise<Gif[]> {
  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) throw new GifSearchError('Sign in to search for GIFs.');

  const res = await fetch(`/api/gif-search?q=${encodeURIComponent(query.trim())}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal,
  });

  if (!res.ok) {
    // The endpoint returns a human-readable reason for the cases worth
    // distinguishing — not configured, refused, hourly limit reached — and
    // showing it is the difference between "no results" and "it is broken".
    const body = await res.json().catch(() => ({}));
    throw new GifSearchError(
      body?.error ||
        (res.status === 503
          ? 'GIF search is not set up yet.'
          : `GIF search failed (${res.status}).`)
    );
  }

  const body = await res.json();
  return Array.isArray(body?.gifs) ? (body.gifs as Gif[]) : [];
}
