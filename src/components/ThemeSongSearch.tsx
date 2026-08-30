import React, { useState, useEffect, useRef } from 'react';
import YouTube, { YouTubeProps } from 'react-youtube';
import { Search, X, Music, Check, Loader2, Clock, History, Play, Square, AlertCircle, RefreshCw } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { ThemeSong, MusicHistory } from '../types';
import { auth as authApi, songs as songsApi } from '../lib/db';
import { cn } from '../lib/utils';
import { searchSongs, SongSearchError, MIN_QUERY_LENGTH, YouTubeTrack } from '../lib/youtube';
import { RowSkeleton } from './Skeleton';

interface ThemeSongSearchProps {
  onSelect: (song: ThemeSong) => void;
  onClose: () => void;
  initialSong?: ThemeSong;
}

export function ThemeSongSearch({ onSelect, onClose, initialSong }: ThemeSongSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<YouTubeTrack[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<ThemeSong | null>(initialSong || null);
  const [startTime, setStartTime] = useState(initialSong?.startTime || 0);
  const [tempId, setTempId] = useState<string | null>(null);
  const [history, setHistory] = useState<MusicHistory[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [activeTab, setActiveTab] = useState<'search' | 'history'>('search');
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const previewPlayerRef = useRef<any>(null);

  const togglePreviewPlay = () => {
    if (!previewPlayerRef.current) return;

    if (isPreviewPlaying) {
      previewPlayerRef.current.pauseVideo();
    } else {
      previewPlayerRef.current.unMute();
      previewPlayerRef.current.setVolume(100);
      previewPlayerRef.current.seekTo(startTime, true);
      previewPlayerRef.current.playVideo();
    }
  };

  const onPreviewReady: YouTubeProps['onReady'] = (event) => {
    previewPlayerRef.current = event.target;
    // No seekTo here. On a freshly-cued player seekTo() starts playback (see
    // the IFrame API reference), which is why this needed an immediate
    // pauseVideo() to undo it — audible as a blip of sound on open. The start
    // offset is already set by the start playerVar. The pause stays as a
    // guard in case the embed comes up playing for any other reason.
    try { event.target.pauseVideo(); } catch { /* ignore */ }
  };

  const onPreviewStateChange: YouTubeProps['onStateChange'] = (event) => {
    if (event.data === 1) setIsPreviewPlaying(true);
    else setIsPreviewPlaying(false);
  };

  useEffect(() => {
    const fetchHistory = async () => {
      const session = await authApi.getSession();
      const userId = session?.user?.id;
      if (!userId) return;

      setLoadingHistory(true);
      try {
        setHistory(await songsApi.history(userId, 20));
      } catch (err) {
        console.error('Error fetching history:', err);
      } finally {
        setLoadingHistory(false);
      }
    };
    fetchHistory();
  }, []);

  const addToHistory = async (song: ThemeSong) => {
    const session = await authApi.getSession();
    const userId = session?.user?.id;
    if (!userId) return;
    try {
      // recordPlay() inserts the shared song row if it is new, then points the
      // history entry at it — no duplicated track metadata per play.
      await songsApi.recordPlay(userId, song, 'used');
    } catch (err) {
      console.error('Error adding to history:', err);
    }
  };

  /**
   * Debounced search.
   *
   * 400ms, with a two-character floor, because every keystroke that reaches
   * the server costs 100 units of a 10,000/day YouTube quota — roughly 100
   * searches a day for the whole app. Typing 'the weeknd' unthrottled would
   * be eleven of them.
   *
   * The AbortController is not an optimisation either: without it a slow
   * request for 'ta' can land after a fast one for 'taylor' and overwrite the
   * results the reader is looking at.
   */
  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setLoading(false);
      setError('');
      return;
    }

    const controller = new AbortController();
    setLoading(true);

    const timer = setTimeout(async () => {
      try {
        const tracks = await searchSongs(q, controller.signal);
        if (controller.signal.aborted) return;
        setResults(tracks);
        setError(tracks.length === 0 ? 'No songs found. Try a different search.' : '');
      } catch (err) {
        if (controller.signal.aborted || (err as Error)?.name === 'AbortError') return;
        // Quota exhausted, not configured, rate limited — each carries its own
        // message from the endpoint, and showing it is the difference between
        // 'no results' and 'this is broken'.
        console.error('Song search failed:', err);
        setResults([]);
        setError(err instanceof SongSearchError ? err.message : 'Song search failed. Try again.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 400);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  /** Search already returns title, channel and thumbnail, so picking a result
   *  needs no extra network call and no hidden metadata-probe player — which
   *  is what the pasted-link flow used the now-deleted onPlayerReady for. */
  const pickTrack = (track: YouTubeTrack) => {
    setPreview({ ...track, startTime: 0 });
    setStartTime(0);
    setIsPreviewPlaying(false);
  };

  const handleSave = () => {
    if (preview) {
      const selectedSong = { ...preview, startTime };
      addToHistory(selectedSong);
      onSelect(selectedSong);
    }
  };

  const formatTime = (seconds: number) => {
    const min = Math.floor(seconds / 60);
    const sec = seconds % 60;
    return `${min}:${sec.toString().padStart(2, '0')}`;
  };

  // The root is a flex item that has to be able to SHRINK. It was
  // `flex flex-col h-full`: a percentage height with no min-h-0. min-height on
  // a flex item defaults to auto, which resolves to the content size, so the
  // root grew to fit its content rather than to the panel — the panel clipped
  // it (overflow: hidden) and the results list never received a bounded height
  // to scroll inside. The same trap already documented for six other
  // containers in this codebase.
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Hidden Player for metadata */}

      <div className="mb-5 mt-1 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-bold text-fg">Music</h2>

          {/* Two tabs of equal weight. The active one used to be a filled
              white pill with a glow and the inactive one bare text, so they
              read as a primary button standing next to a label rather than as
              two choices. Both are pills now; only the fill says which is on. */}
          <div role="tablist" aria-label="Music source" className="flex items-center gap-1 rounded-full border border-line bg-surface-2 p-0.5">
            {(["search", "history"] as const).map((tab) => (
              <button
                key={tab}
                role="tab"
                aria-selected={activeTab === tab}
                onClick={() => setActiveTab(tab)}
                className={cn(
                  "rounded-full px-3.5 py-1.5 text-xs font-semibold capitalize transition-colors duration-100",
                  activeTab === tab
                    ? "bg-accent text-white"
                    : "text-muted hover:bg-surface-3 hover:text-fg"
                )}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={onClose}
          aria-label="Close"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <X size={18} />
        </button>
      </div>

      {/* The search field sits OUTSIDE the scroll area. It used to scroll away
          with the results, so refining a query meant scrolling back up to
          reach the box you were typing in. */}
      {activeTab === 'search' && (
        <div className="mb-3 shrink-0 space-y-2">
          <div className="relative">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search for a song or artist…"
              className="w-full rounded-2xl border border-line bg-surface-3 py-4 pl-12 pr-12 text-sm font-medium transition-colors placeholder:text-subtle focus:border-accent focus:outline-none"
            />
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-subtle" size={18} />
            {loading && <Loader2 className="absolute right-4 top-1/2 -translate-y-1/2 animate-spin text-accent" size={18} />}
            {!loading && query && (
              <button
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="absolute right-4 top-1/2 -translate-y-1/2 text-subtle transition-colors hover:text-fg"
              >
                <X size={16} />
              </button>
            )}
          </div>

          {error && (
            <p className="ml-1 flex items-center gap-1.5 text-xs text-danger">
              <AlertCircle size={12} className="shrink-0" />
              {error}
            </p>
          )}
        </div>
      )}

      {/* scrollbar-thin, not scrollbar-hide: with a dozen results the only cue
          that there are more below is the bar itself. */}
      <div className="min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-thin">
        {activeTab === 'search' ? (
          <div className="space-y-3">

            {/* Results. Hidden once something is picked, so the preview and
                start-time controls get the full panel; "Choose another" below
                brings the list back. */}
            {!preview && results.length > 0 && (
              <ul className="space-y-1">
                {results.map((track) => (
                  <li key={track.youtubeId}>
                    <button
                      onClick={() => pickTrack(track)}
                      className="flex w-full items-center gap-3 rounded-2xl p-2 text-left transition-colors hover:bg-surface-2 active:scale-[0.99]"
                    >
                      <img
                        src={track.coverUrl}
                        alt=""
                        className="h-12 w-12 shrink-0 rounded-xl border border-line object-cover"
                        referrerPolicy="no-referrer" loading="lazy" decoding="async"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-fg">{track.title}</span>
                        <span className="mt-0.5 block truncate text-xs text-muted">{track.artist}</span>
                      </span>
                      <Play size={14} className="shrink-0 fill-current text-subtle" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <AnimatePresence mode="wait">
              {preview ? (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="pb-6"
                >
                  {/* One card, three sections, thin dividers.
                      Each section used to be its own rounded, bordered,
                      shadowed box with its own padding — three stacked cards
                      for what is one continuous task. Now: a single surface,
                      the same 16px padding throughout, and a hairline rule
                      where a box edge used to be. */}
                  <div className="relative overflow-hidden rounded-2xl border border-line bg-surface-2">

                    {/* — Selected track — */}
                    <div className="flex items-center gap-3 p-4">
                      <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-xl border border-line bg-black/40">
                        <img
                          src={preview.coverUrl}
                          alt=""
                          className="h-full w-full object-cover"
                          referrerPolicy="no-referrer" loading="lazy" decoding="async" />
                        <button
                          onClick={togglePreviewPlay}
                          aria-label={isPreviewPlaying ? "Stop preview" : "Preview from the start point"}
                          className="absolute inset-0 flex items-center justify-center bg-black/45 transition-colors hover:bg-black/65"
                        >
                          {isPreviewPlaying
                            ? <Square size={16} className="fill-white text-white" />
                            : <Play size={16} className="fill-white text-white" />}
                        </button>
                      </div>

                      <div className="min-w-0 flex-1">
                        <h3 className="truncate text-sm font-semibold leading-tight text-fg">{preview.title}</h3>
                        <p className="mt-0.5 truncate text-xs text-muted">{preview.artist}</p>

                        <div className="mt-1.5 flex items-center gap-3">
                          {/* A play glyph on cover art is ambiguous — it reads
                              as "this is a video" as easily as "hear it". The
                              word says which. */}
                          <button
                            onClick={togglePreviewPlay}
                            className="flex items-center gap-1 text-[11px] font-medium text-muted transition-colors hover:text-fg"
                          >
                            {isPreviewPlaying
                              ? <Square size={10} className="fill-current" />
                              : <Play size={10} className="fill-current" />}
                            {isPreviewPlaying ? 'Stop' : 'Preview'}
                          </button>

                          {results.length > 0 && (
                            <button
                              onClick={() => { setPreview(null); setIsPreviewPlaying(false); }}
                              className="flex items-center gap-1 text-[11px] font-medium text-muted transition-colors hover:text-fg"
                            >
                              <RefreshCw size={10} />
                              Choose another
                            </button>
                          )}
                        </div>
                      </div>

                      {/* The preview player: rendered, never shown. Same
                          reasoning as the profile card — display:none lets a
                          browser throttle or pause a player, so this is 1x1 and
                          off-canvas instead. */}
                      <div
                        aria-hidden="true"
                        className="pointer-events-none absolute overflow-hidden"
                        style={{ width: 1, height: 1, top: -1, left: -1, opacity: 0.01 }}
                      >
                        <YouTube
                          videoId={preview.youtubeId}
                          opts={{
                            playerVars: {
                              autoplay: 0,
                              start: startTime,
                              controls: 0,
                              modestbranding: 1,
                              playsinline: 1,
                              enablejsapi: 1,
                              origin: window.location.origin
                            },
                          }}
                          onReady={onPreviewReady}
                          onStateChange={onPreviewStateChange}
                          onError={() => setIsPreviewPlaying(false)}
                        />
                      </div>
                    </div>

                    {/* — Start point — */}
                    <div className="border-t border-line p-4">
                      <div className="flex items-center justify-between gap-2">
                        <label htmlFor="start-time" className="flex items-center gap-1.5 text-xs font-medium text-muted">
                          <Clock size={12} />
                          Start at
                        </label>
                        <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-semibold tabular-nums text-accent">
                          {formatTime(startTime)}
                        </span>
                      </div>

                      {/* The slider had py-4 inside a p-8 box: roughly 48px of
                          air around a 2px control, which is what made this
                          section look empty next to the result above it. */}
                      <input
                        id="start-time"
                        type="range"
                        min="0"
                        max="300"
                        step="1"
                        value={startTime}
                        onChange={(e) => {
                          setStartTime(Number(e.target.value));
                          setIsPreviewPlaying(false); // Reset preview when switching time
                        }}
                        style={{ ['--fill' as string]: `${(startTime / 300) * 100}%` }}
                        className="track-slider mt-3 h-1 w-full"
                      />

                      <p className="mt-2 text-[11px] leading-snug text-subtle">
                        Drag to choose where the song starts, then hit Preview to hear it.
                      </p>
                    </div>

                    {/* — Confirm — */}
                    <div className="border-t border-line p-4">
                      <button
                        onClick={handleSave}
                        className="btn-primary flex h-11 w-full items-center justify-center gap-2 text-sm"
                      >
                        <Check size={16} />
                        Confirm selection
                      </button>
                    </div>
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line py-12"
                >
                  <div className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-2 text-subtle">
                    <Music size={20} />
                  </div>
                  <p className="text-sm text-muted">Search for a song to get started</p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ) : (
          <div className="space-y-4 pb-20">
            {loadingHistory ? (
              <div className="space-y-3">
                <RowSkeleton />
                <RowSkeleton />
                <RowSkeleton />
              </div>
            ) : history.length > 0 ? (
              <div className="space-y-1">
                {history.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => {
                      setPreview(item);
                      setStartTime(item.startTime);
                      setActiveTab('search');
                    }}
                    className="group flex w-full items-center gap-3 rounded-2xl p-2 text-left transition-colors hover:bg-surface-2 active:scale-[0.99]"
                  >
                    <div className="h-12 w-12 shrink-0 overflow-hidden rounded-xl border border-line bg-black/40">
                      <img
                        src={item.coverUrl}
                        alt=""
                        className="w-full h-full object-cover"
                        referrerPolicy="no-referrer" loading="lazy" decoding="async" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="truncate text-sm font-semibold text-fg transition-colors group-hover:text-accent">{item.title}</h4>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <p className="truncate text-xs text-muted">{item.artist}</p>
                        <span className="h-1 w-1 shrink-0 rounded-full bg-line-strong" />
                        <p className="shrink-0 text-xs tabular-nums text-subtle">{formatTime(item.startTime)}</p>
                      </div>
                    </div>
                    <Play size={14} className="shrink-0 fill-current text-subtle transition-colors group-hover:text-accent" />
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line py-12">
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-2 text-subtle">
                  <History size={20} />
                </div>
                <p className="text-sm text-muted">No history yet</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

