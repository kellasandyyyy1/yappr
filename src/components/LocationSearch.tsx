import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Search, X, Loader2, AlertCircle, MapPin as MapPinIcon, Clock } from './icons';
import {
  searchPlaces,
  searchHistory,
  GeocodeError,
  MIN_QUERY_LENGTH,
  GeocodeResult,
  HistoryEntry,
} from '../lib/geocode';
import { describeError, cn } from '../lib/utils';

export interface PickedPlace {
  latitude: number;
  longitude: number;
  label?: string;
}

interface LocationSearchProps {
  userId: string;
  onPick: (place: PickedPlace) => void;
  placeholder?: string;
  className?: string;
}

/**
 * Predictive place search with the user's recent picks.
 *
 * Focused and empty, it shows history — the same pattern the music picker uses
 * for its History tab, and the reason the search box is useful before a single
 * keystroke. Typing replaces it with live results.
 */
export function LocationSearch({ userId, onPick, placeholder, className }: LocationSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const loadHistory = useCallback(async () => {
    try {
      setHistory(await searchHistory.recent(userId));
    } catch (err) {
      // History is a convenience. A failure here must not take the search box
      // with it, so it is logged and swallowed rather than surfaced.
      console.error('Error loading search history:', err);
    }
  }, [userId]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  /**
   * Debounced search.
   *
   * 500ms, at the slow end of the usual range, because every keystroke that
   * gets through is a request against a free service capped at one per second
   * for the whole app. The AbortController is not an optimisation either:
   * without it a slow request for "lon" can land after a fast one for "london"
   * and replace the results being read.
   */
  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    setLoading(true);

    const timer = setTimeout(async () => {
      try {
        const found = await searchPlaces(q, controller.signal);
        if (controller.signal.aborted) return;
        setResults(found);
                // "No matches YET", not "no such place". Nominatim is a geocoder,
        // not an autocomplete engine: a partial word often returns nothing
        // where the full word returns plenty — "edinbur" gives 0 results and
        // "edinburgh" gives 2. Telling someone their half-typed word does
        // not exist would be wrong most of the time.
        setError(found.length === 0 ? 'No matches yet — try a fuller place name.' : null);
      } catch (err) {
        if (controller.signal.aborted || (err as Error)?.name === 'AbortError') return;
        console.error('Place search failed:', err);
        setResults([]);
        setError(err instanceof GeocodeError ? err.message : describeError(err));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 500);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  // Clicking away closes the dropdown; without this it stays over the map.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const choose = async (place: PickedPlace, queryForHistory: string) => {
    onPick(place);
    setOpen(false);
    setQuery('');
    setResults([]);
    try {
      await searchHistory.record(userId, queryForHistory, place);
      await loadHistory();
    } catch (err) {
      // The map has already moved; failing to remember it is not worth
      // interrupting anyone over.
      console.error('Error saving search history:', err);
    }
  };

  const showHistory = query.trim().length < MIN_QUERY_LENGTH && history.length > 0;
  const showDropdown = open && (showHistory || loading || !!error || results.length > 0);

  return (
    <div ref={boxRef} className={cn('relative', className)}>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setOpen(true)}
        placeholder={placeholder ?? 'Search for a place…'}
        aria-label="Search for a place"
        className="h-11 w-full rounded-xl border border-line bg-surface-2 pl-10 pr-9 text-sm transition-colors placeholder:text-subtle focus:border-accent focus:outline-none"
      />
      <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-subtle" />
      {loading && (
        <Loader2 size={15} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-accent" />
      )}
      {!loading && query && (
        <button
          type="button"
          onClick={() => { setQuery(''); setResults([]); setError(null); }}
          aria-label="Clear search"
          className="absolute right-3 top-1/2 -translate-y-1/2 text-subtle transition-colors hover:text-fg"
        >
          <X size={15} />
        </button>
      )}

      {showDropdown && (
        <div
          style={{ zIndex: 'var(--z-popover)' }}
          className="absolute inset-x-0 top-full mt-1.5 max-h-64 overflow-y-auto rounded-xl border border-line bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.5)] scrollbar-thin"
        >
          {error ? (
            <p className="flex items-start gap-2 px-3 py-3 text-xs leading-relaxed text-danger">
              <AlertCircle size={13} className="mt-px shrink-0" />
              {error}
            </p>
          ) : showHistory ? (
            <>
              <p className="px-3 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-subtle">
                Recent
              </p>
              {history.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  onClick={() =>
                    choose({ latitude: h.latitude, longitude: h.longitude, label: h.label }, h.queryText)
                  }
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
                >
                  <Clock size={14} className="shrink-0 text-subtle" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-fg">{h.queryText}</span>
                    {h.label && <span className="block truncate text-xs text-muted">{h.label}</span>}
                  </span>
                </button>
              ))}
            </>
          ) : loading && results.length === 0 ? (
            <p className="px-3 py-3 text-xs text-subtle">Searching…</p>
          ) : (
            results.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() =>
                  choose({ latitude: r.latitude, longitude: r.longitude, label: r.label }, r.name)
                }
                className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
              >
                <MapPinIcon size={14} className="shrink-0 text-accent" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-fg">{r.name}</span>
                  {r.context && <span className="block truncate text-xs text-muted">{r.context}</span>}
                </span>
              </button>
            ))
          )}

          {/* Nominatim's licence requires attribution wherever its data is shown. */}
          <p className="border-t border-line px-3 py-1.5 text-[10px] text-subtle">
            Search by OpenStreetMap / Nominatim
          </p>
        </div>
      )}
    </div>
  );
}
