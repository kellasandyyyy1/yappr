import React, { useState, useEffect, useRef } from 'react';
import YouTube, { YouTubeProps } from 'react-youtube';
import { Search, X, Music, Check, Loader2, Clock, History, Play, Square, AlertCircle } from 'lucide-react';
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

  return (
    <div className="flex flex-col h-full">
      {/* Hidden Player for metadata */}

      <div className="flex items-center justify-between mb-8 mt-2">
        <div className="flex items-center gap-4">
          <h2 className="text-xl font-bold uppercase tracking-tight text-fg">Music</h2>
          <div className="flex bg-black/40 rounded-full p-1 border border-line">
            <button
              onClick={() => setActiveTab('search')}
              className={cn(
                "px-5 py-2 rounded-full text-xs font-black uppercase tracking-widest transition-colors",
                activeTab === 'search' ? "bg-white text-black shadow-[0_4px_12px_rgba(255,255,255,0.2)]" : "text-muted hover:text-fg"
              )}
            >
              Search
            </button>
            <button
              onClick={() => setActiveTab('history')}
              className={cn(
                "px-5 py-2 rounded-full text-xs font-black uppercase tracking-widest transition-colors",
                activeTab === 'history' ? "bg-white text-black shadow-[0_4px_12px_rgba(255,255,255,0.2)]" : "text-muted hover:text-fg"
              )}
            >
              History
            </button>
          </div>
        </div>
        <button
          onClick={onClose}
          className="w-10 h-10 rounded-full bg-surface-2 flex items-center justify-center border border-line hover:bg-surface-3 transition-colors"
        >
          <X size={20} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-hide space-y-6">
        {activeTab === 'search' ? (
          <div className="space-y-6">
            <div className="space-y-3">
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
                  className="space-y-6 pb-20"
                >
                  <div className="p-6 rounded-3xl bg-surface-2 border border-line overflow-hidden relative group shadow-2xl">
                    <div className="flex items-center gap-5">
                      <div className="w-16 h-16 rounded-2xl overflow-hidden shadow-2xl border border-line bg-black/40 relative group/player">
                        <img
                          src={preview.coverUrl}
                          alt={preview.title}
                          className={cn(
                            "w-full h-full object-cover transition-transform duration-150",
                            isPreviewPlaying ? "scale-110" : "scale-100"
                          )}
                          referrerPolicy="no-referrer" loading="lazy" decoding="async" />
                        <button
                          onClick={togglePreviewPlay}
                          className="absolute inset-0 flex items-center justify-center bg-black/40 hover:bg-black/60 transition-colors"
                        >
                          {isPreviewPlaying ? (
                            <Square size={24} className="text-white fill-white" />
                          ) : (
                            <Play size={24} className="text-white fill-white ml-1" />
                          )}
                        </button>
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="truncate text-base font-bold leading-tight">{preview.title}</h3>
                        <p className="mt-0.5 truncate text-xs text-muted">{preview.artist}</p>
                        {results.length > 0 && (
                          <button
                            onClick={() => { setPreview(null); setIsPreviewPlaying(false); }}
                            className="mt-1.5 text-xs font-medium text-accent transition-colors hover:underline"
                          >
                            Choose another
                          </button>
                        )}
                      </div>

                      {/* Hidden actual preview player - always rendered for mobile gesture compliance */}
                      <div className="absolute opacity-0 pointer-events-none w-1 h-1 overflow-hidden" style={{ top: -10, left: -10 }}>
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
                  </div>

                  <div className="p-8 rounded-3xl bg-surface-2 border border-line space-y-5">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-black uppercase tracking-widest text-muted ml-1 flex items-center gap-2">
                        <Clock size={12} />
                        Start Timestamp
                      </label>
                      <div className="px-4 py-1.5 rounded-full bg-accent/10 border border-accent/20 text-accent text-xs font-black tracking-widest shadow-inner">
                        {formatTime(startTime)}
                      </div>
                    </div>

                    <div className="relative px-2 py-4">
                      <input
                        type="range"
                        min="0"
                        max="300"
                        step="1"
                        value={startTime}
                        onChange={(e) => {
                          setStartTime(Number(e.target.value));
                          setIsPreviewPlaying(false); // Reset preview when switching time
                        }}
                        className="w-full h-2 bg-surface-2 rounded-lg appearance-none cursor-pointer accent-[#3b82f6]"
                      />
                    </div>

                    <p className="text-xs text-subtle ml-1 leading-relaxed text-center italic">Drag the slider and press play on the cover to test the start point.</p>
                  </div>

                  <div className="pt-4">
                    <button
                      onClick={handleSave}
                      className="w-full py-5 bg-accent text-white text-xs font-black rounded-full tracking-widest uppercase shadow-[0_20px_40px_rgba(37,99,235,0.3)] active:scale-95 transition-colors flex items-center justify-center gap-3 border border-line"
                    >
                      <Check size={16} />
                      Confirm Selection
                    </button>
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex flex-col items-center justify-center py-24 border-2 border-dashed border-line rounded-3xl bg-surface-2"
                >
                  <div className="w-16 h-16 rounded-full bg-surface-2 flex items-center justify-center mb-6 text-subtle">
                    <Music size={32} />
                  </div>
                  <p className="text-sm font-medium text-subtle">Search for a song to get started</p>
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
              <div className="grid grid-cols-1 gap-3">
                {history.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => {
                      setPreview(item);
                      setStartTime(item.startTime);
                      setActiveTab('search');
                    }}
                    className="flex items-center gap-4 p-4 rounded-3xl bg-surface-2 border border-line hover:bg-surface-2 transition-colors text-left group active:scale-98"
                  >
                    <div className="w-14 h-14 rounded-2xl overflow-hidden shrink-0 border border-line shadow-lg bg-black/40">
                      <img
                        src={item.coverUrl}
                        alt=""
                        className="w-full h-full object-cover"
                        referrerPolicy="no-referrer" loading="lazy" decoding="async" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="text-sm font-bold truncate group-hover:text-accent transition-colors uppercase tracking-tight">{item.title}</h4>
                      <div className="flex items-center gap-2 mt-1">
                        <p className="text-xs text-muted truncate uppercase tracking-widest font-black">{item.artist}</p>
                        <span className="w-1 h-1 rounded-full bg-surface-3" />
                        <p className="text-xs text-accent font-black tracking-widest uppercase">{formatTime(item.startTime)}</p>
                      </div>
                    </div>
                    <div className="w-10 h-10 rounded-full bg-surface-2 flex items-center justify-center text-subtle group-hover:text-accent group-hover:bg-accent/10 transition-colors">
                      <Play size={16} fill="currentColor" />
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-24 border-2 border-dashed border-line rounded-3xl bg-surface-2">
                <div className="w-16 h-16 rounded-full bg-surface-2 flex items-center justify-center mb-6 text-subtle">
                  <History size={32} />
                </div>
                <p className="text-sm font-medium text-subtle">No history yet</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

