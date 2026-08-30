import { supabase } from './supabase';

/**
 * Client for the proxied music search at /api/youtube-search.
 *
 * There is deliberately no API key here and no direct call to googleapis.com:
 * the key stays server-side (see api/_youtube.ts). The browser only ever talks
 * to our own origin, which is also why no CSP change was needed — connect-src
 * already allows 'self'.
 */

export interface YouTubeTrack {
  youtubeId: string;
  title: string;
  artist: string;
  coverUrl: string;
}

export class SongSearchError extends Error {}

/** Below this, results are noise and each call still costs 100 quota units. */
export const MIN_QUERY_LENGTH = 2;

/**
 * Searches for a track.
 *
 * Takes an AbortSignal because a type-ahead fires overlapping requests and the
 * slowest one must not be allowed to land last and overwrite fresher results.
 * An aborted call rejects with a DOMException named 'AbortError'; callers are
 * expected to ignore that rather than surface it.
 */
export async function searchSongs(
  query: string,
  signal?: AbortSignal
): Promise<YouTubeTrack[]> {
  const q = query.trim();
  if (q.length < MIN_QUERY_LENGTH) return [];

  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) throw new SongSearchError('Sign in to search for music.');

  const res = await fetch(`/api/youtube-search?q=${encodeURIComponent(q)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal,
  });

  if (!res.ok) {
    // The endpoint returns a human-readable reason for the cases worth
    // distinguishing — quota exhausted, not configured, rate limited — and
    // showing it is the difference between "no results" and "it is broken".
    const body = await res.json().catch(() => ({}));
    throw new SongSearchError(
      body?.error ||
        (res.status === 503
          ? 'Song search is not set up yet.'
          : `Song search failed (${res.status}).`)
    );
  }

  const body = await res.json();
  return Array.isArray(body?.tracks) ? (body.tracks as YouTubeTrack[]) : [];
}
