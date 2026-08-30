import { supabase } from './supabase';

/**
 * Client for the proxied geocoder at /api/geocode, and the user's own search
 * history.
 *
 * The search never calls Nominatim directly. Their policy requires a
 * descriptive User-Agent — a header browsers are forbidden from setting — and
 * caps the whole application at 1 request/second, which cannot be enforced
 * from inside individual browsers. See api/_nominatim.ts.
 */

export interface GeocodeResult {
  id: string;
  name: string;
  context: string;
  label: string;
  latitude: number;
  longitude: number;
}

export interface HistoryEntry {
  id: string;
  queryText: string;
  label?: string;
  latitude: number;
  longitude: number;
  searchedAt: string;
}

export class GeocodeError extends Error {}

/** The floor below which a query is noise and not worth a request. */
export const MIN_QUERY_LENGTH = 3;

/**
 * Searches for a place.
 *
 * Takes an AbortSignal because a type-ahead fires overlapping requests, and
 * the slowest must not land last and replace fresher results. An aborted call
 * rejects with a DOMException named 'AbortError'; callers ignore that.
 */
export async function searchPlaces(query: string, signal?: AbortSignal): Promise<GeocodeResult[]> {
  const q = query.trim();
  if (q.length < MIN_QUERY_LENGTH) return [];

  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) throw new GeocodeError('Sign in to search for places.');

  const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // 429 carries the throttle wording from the endpoint. Showing it rather
    // than a generic failure is the difference between "wait a moment" and
    // "this is broken".
    throw new GeocodeError(
      body?.error ||
        (res.status === 429
          ? 'Search temporarily unavailable, try again shortly.'
          : `Location search failed (${res.status}).`)
    );
  }

  const body = await res.json();
  return Array.isArray(body?.results) ? (body.results as GeocodeResult[]) : [];
}

const mapEntry = (row: any): HistoryEntry => ({
  id: row.id,
  queryText: row.query_text,
  label: row.label ?? undefined,
  // numeric arrives as a string over PostgREST; Leaflet needs numbers.
  latitude: Number(row.latitude),
  longitude: Number(row.longitude),
  searchedAt: row.searched_at,
});

export const searchHistory = {
  /** Most recent first. RLS limits this to the caller's own rows. */
  async recent(userId: string, limit = 8): Promise<HistoryEntry[]> {
    const { data, error } = await supabase
      .from('location_search_history')
      .select('id, query_text, label, latitude, longitude, searched_at')
      .eq('user_id', userId)
      .order('searched_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []).map(mapEntry);
  },

  /**
   * Records a chosen place.
   *
   * An upsert on (user_id, query_text), so searching the same thing twice
   * refreshes the timestamp instead of adding a row. Read-then-write would
   * race with itself across two tabs; the unique index makes the database
   * settle it.
   *
   * query_text is normalised here because the unique index dedupes on the
   * stored value — "London" and " london " have to collide.
   */
  async record(
    userId: string,
    query: string,
    place: { latitude: number; longitude: number; label?: string }
  ): Promise<void> {
    const queryText = query.trim().toLowerCase().slice(0, 200);
    if (!queryText) return;

    const { error } = await supabase
      .from('location_search_history')
      .upsert(
        {
          user_id: userId,
          query_text: queryText,
          latitude: place.latitude,
          longitude: place.longitude,
          label: place.label ?? null,
          searched_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,query_text' }
      );
    if (error) throw error;
  },

  async remove(id: string): Promise<void> {
    const { error } = await supabase.from('location_search_history').delete().eq('id', id);
    if (error) throw error;
  },
};
