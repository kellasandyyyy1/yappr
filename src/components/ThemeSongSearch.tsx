import React, { useState, useEffect, useRef } from 'react';
import YouTube, { YouTubeProps } from 'react-youtube';
import { Search, X, Music, Check, Loader2, Link as LinkIcon, Clock, History, Play, Square } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { ThemeSong, MusicHistory } from '../types';
import { auth as authApi, songs as songsApi } from '../lib/db';
import { cn } from '../lib/utils';
import { RowSkeleton } from './Skeleton';

interface ThemeSongSearchProps {
  onSelect: (song: ThemeSong) => void;
  onClose: () => void;
  initialSong?: ThemeSong;
}

export function ThemeSongSearch({ onSelect, onClose, initialSong }: ThemeSongSearchProps) {
  const [url, setUrl] = useState('');
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
    event.target.seekTo(startTime, true);
    event.target.pauseVideo();
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

  const extractYoutubeId = (url: string) => {
    const regExp = /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;
    const match = url.match(regExp);
    return (match && match[7].length === 11) ? match[7] : null;
  };

  const handleUrlChange = (newUrl: string) => {
    setUrl(newUrl);
    const id = extractYoutubeId(newUrl);
    if (id) {
      setTempId(id);
      setLoading(true);
      setError('');
    } else if (newUrl.trim() !== '') {
      setError('Please enter a valid YouTube link');
    }
  };

  const onPlayerReady: YouTubeProps['onReady'] = (event) => {
    const player = event.target;
    try {
      const videoData = player.getVideoData();
      if (videoData && videoData.title) {
        setPreview({
          youtubeId: tempId!,
          title: videoData.title,
          artist: videoData.author,
          coverUrl: `https://img.youtube.com/vi/${tempId}/mqdefault.jpg`,
          startTime: startTime
        });
        setError('');
      } else {
        setError('Could not fetch video details. Please try another link.');
      }
    } catch (err) {
      console.error(err);
      setError('Error fetching video details');
    } finally {
      setLoading(false);
      setTempId(null);
    }
  };

  const onPlayerError: YouTubeProps['onError'] = () => {
    setError('Video not found or unavailable');
    setLoading(false);
    setTempId(null);
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
      {tempId && (
        <div className="absolute opacity-[0.01] pointer-events-none h-[200px] w-[200px] overflow-hidden -z-10 bg-transparent" style={{ top: -100, left: -100 }}>
          <YouTube
            videoId={tempId}
            onReady={onPlayerReady}
            onError={onPlayerError}
            opts={{
              height: '200',
              width: '200',
              playerVars: {
                autoplay: 0,
                origin: window.location.origin,
                enablejsapi: 1,
                playsinline: 1
              }
            }}
          />
        </div>
      )}

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
              <label className="text-xs font-black uppercase tracking-widest text-muted ml-1 flex items-center gap-2">
                <LinkIcon size={12} />
                YouTube Link
              </label>
              <div className="relative">
                <input
                  autoFocus
                  value={url}
                  onChange={(e) => handleUrlChange(e.target.value)}
                  placeholder="Paste YouTube link here..."
                  className="w-full bg-surface-3 border border-line rounded-[20px] p-5 pl-12 text-sm focus:outline-none focus:border-accent transition-colors font-medium placeholder:text-subtle"
                />
                <Search className="absolute left-5 top-1/2 -translate-y-1/2 text-subtle" size={18} />
                {loading && <Loader2 className="absolute right-5 top-1/2 -translate-y-1/2 text-accent animate-spin" size={18} />}
              </div>
              {error && <p className="text-xs text-danger font-bold ml-1">{error}</p>}
            </div>

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
                        <h3 className="font-bold text-lg truncate leading-tight uppercase tracking-tight">{preview.title}</h3>
                        <p className="text-muted text-xs font-black uppercase tracking-widest mt-1">{preview.artist}</p>
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
                  <p className="text-sm font-medium text-subtle">Paste link to preview</p>
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

