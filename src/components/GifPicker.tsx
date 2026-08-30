import React, { useState, useEffect } from 'react';
import { Search, X, Loader2, AlertCircle, ImageOff } from 'lucide-react';
import { Modal, ModalHeader } from './Modal';
import { searchGifs, GifSearchError, Gif } from '../lib/giphy';
import { cn } from '../lib/utils';

interface GifPickerProps {
  onSelect: (gif: Gif) => void;
  onClose: () => void;
  /** True when opened from inside another modal, e.g. the post composer. */
  nested?: boolean;
}

export function GifPicker({ onSelect, onClose, nested }: GifPickerProps) {
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState<Gif[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Debounced search. Runs once on open with an empty query, which the endpoint
   * answers with GIPHY's trending set — so the grid has content before the
   * first keystroke rather than an empty panel.
   *
   * The AbortController is not an optimisation: without it a slow request for
   * "ca" can land after a fast one for "cat" and replace the results the reader
   * is already looking at.
   */
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);

    const timer = setTimeout(async () => {
      try {
        const results = await searchGifs(query, controller.signal);
        if (controller.signal.aborted) return;
        setGifs(results);
        setError(null);
      } catch (err) {
        if (controller.signal.aborted || (err as Error)?.name === 'AbortError') return;
        // Not configured, refused, rate limited — each carries its own message
        // from the endpoint. Showing it is the difference between "no GIFs
        // match that" and "this feature is broken".
        console.error('GIF search failed:', err);
        setGifs([]);
        setError(err instanceof GifSearchError ? err.message : 'GIF search failed. Try again.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, query.trim() ? 400 : 0);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  return (
    <Modal onClose={onClose} size="lg" nested={nested} labelledBy="gif-title" className="sm:h-[80vh]">
      <ModalHeader title="Add a GIF" onClose={onClose} id="gif-title" />

      <div className="shrink-0 px-4 pb-3 pt-3 sm:px-5">
        <div className="relative">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search GIPHY…"
            className="h-11 w-full rounded-full border border-line bg-surface-2 pl-10 pr-10 text-sm transition-colors placeholder:text-subtle focus:border-accent focus:outline-none"
          />
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-subtle" size={16} />
          {loading && (
            <Loader2 className="absolute right-3.5 top-1/2 -translate-y-1/2 animate-spin text-accent" size={16} />
          )}
          {!loading && query && (
            <button
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="absolute right-3.5 top-1/2 -translate-y-1/2 text-subtle transition-colors hover:text-fg"
            >
              <X size={15} />
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 scrollbar-thin sm:px-5">
        {error ? (
          <div className="mx-auto max-w-sm rounded-xl border border-danger/30 bg-danger/10 px-4 py-4 text-center">
            <p className="flex items-center justify-center gap-1.5 text-sm font-semibold text-danger">
              <AlertCircle size={14} />
              Couldn't load GIFs
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-danger/90">{error}</p>
          </div>
        ) : loading && gifs.length === 0 ? (
          /* Placeholder tiles at the grid's own shape, so the panel does not
             jump when the first results land. */
          <div className="columns-2 gap-2 sm:columns-3">
            {Array.from({ length: 9 }).map((_, i) => (
              <div
                key={i}
                className="mb-2 animate-pulse rounded-lg bg-surface-2"
                style={{ height: 90 + ((i * 37) % 70) }}
              />
            ))}
          </div>
        ) : gifs.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-2 text-subtle">
              <ImageOff size={20} />
            </div>
            <p className="text-sm text-muted">
              {query.trim() ? `No GIFs for "${query.trim()}"` : 'No GIFs to show'}
            </p>
            {query.trim() && <p className="text-xs text-subtle">Try a different search.</p>}
          </div>
        ) : (
          /* A masonry column layout rather than a grid: GIFs have wildly
             different aspect ratios, and a fixed grid either crops them or
             leaves ragged gaps. */
          <div className="columns-2 gap-2 sm:columns-3">
            {gifs.map((gif) => (
              <button
                key={gif.id}
                onClick={() => onSelect(gif)}
                className={cn(
                  'mb-2 block w-full overflow-hidden rounded-lg border border-line bg-surface-2',
                  'transition-colors hover:border-accent focus-visible:border-accent focus-visible:outline-none'
                )}
              >
                {/* The PREVIEW rendition renders here (GIPHY fixed_height);
                    gif.url — downsized, or original as a fallback — is what
                    gets attached. A grid of 25 originals would be tens of
                    megabytes. */}
                <img
                  src={gif.previewUrl}
                  alt={gif.description}
                  loading="lazy"
                  decoding="async"
                  referrerPolicy="no-referrer"
                  className="w-full"
                  style={gif.width && gif.height ? { aspectRatio: `${gif.width} / ${gif.height}` } : undefined}
                />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* MANDATORY, not decorative: GIPHY's terms require a visible
          "Powered by GIPHY" mark wherever their content is displayed, which
          is why this sits in the modal chrome rather than scrolling away with
          the results. Rendered as a text mark — GIPHY's official PNG/SVG
          assets are not publicly fetchable, so rather than approximate their
          logo, drop the real asset from their brand page into /public and
          swap the <span> below for an <img>. */}
      <div className="flex shrink-0 items-center justify-center gap-1.5 border-t border-line px-4 py-2.5 sm:px-5">
        <a
          href="https://giphy.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-muted transition-colors hover:text-fg"
        >
          <span className="text-[11px] font-medium">Powered by</span>
          <span className="text-[13px] font-extrabold tracking-tight text-fg">GIPHY</span>
        </a>
      </div>
    </Modal>
  );
}
