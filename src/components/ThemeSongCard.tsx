import React, { useState, useRef, useEffect } from 'react';
import YouTube, { YouTubeProps } from 'react-youtube';
import { Play, Pause, Music, Volume2, VolumeX, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { ThemeSong } from '../types';
import { cn } from '../lib/utils';
import { useToast } from './ToastContext';

interface ThemeSongCardProps {
  song: ThemeSong;
  isOwnProfile?: boolean;
  onPlay?: () => void;
}

export function ThemeSongCard({ song, isOwnProfile, onPlay: onPlayProp }: ThemeSongCardProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPlayerReady, setIsPlayerReady] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const playerRef = useRef<any>(null);
  const { toast } = useToast();
  const playerId = React.useMemo(() => `yt-player-${song.youtubeId}-${Math.random().toString(36).substr(2, 9)}`, [song.youtubeId]);

  const onReady: YouTubeProps['onReady'] = (event) => {
    playerRef.current = event.target;
    setIsPlayerReady(true);
    // Seek to start time
    try {
      event.target.seekTo(song.startTime || 0, true);
    } catch (e) {
      console.warn('Seek failed in onReady:', e);
    }
  };

  const onStateChange: YouTubeProps['onStateChange'] = (event) => {
    // 1 is playing, 2 is paused, 0 is ended, 3 is buffering
    if (event.data === 1) {
      setIsPlaying(true);
      onPlayProp?.();
    } else if (event.data === 2 || event.data === 0) {
      setIsPlaying(false);
    }
  };

  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent bubbling if needed
    const player = playerRef.current;

    if (!player) {
      toast('Warming up the player...', 'info');
      return;
    }

    try {
      if (isPlaying) {
        player.pauseVideo();
      } else {
        // Essential for mobile: unMute and then Play
        // Some mobile browsers block sound-on autoplay, so we ensure it's loud
        player.unMute();
        player.setVolume(100);
        player.seekTo(song.startTime || 0, true);
        player.playVideo();
      }
    } catch (err) {
      console.error('Play Toggle Error:', err);
      toast('Reconnecting melody...', 'info');
    }
  };

  const toggleMute = (e: React.MouseEvent) => {
    e.stopPropagation();
    const player = playerRef.current;
    if (!player || typeof player.mute !== 'function') return;

    if (isMuted) {
      player.unMute();
    } else {
      player.mute();
    }
    setIsMuted(!isMuted);
  };

  // Stop video if component unmounts
  useEffect(() => {
    const player = playerRef.current;
    return () => {
      if (player && typeof player.stopVideo === 'function') {
        try {
          player.stopVideo();
        } catch (e) {
          // ignore
        }
      }
    };
  }, []);

  const onPlay = () => setIsPlaying(true);
  const onPause = () => setIsPlaying(false);

  return (
    <motion.div
      key={song.youtubeId}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="w-full max-w-[320px] relative group px-2"
    >
      {/* Invisible Player Container - slightly larger for mobile visibility checks but hidden */}
      <div className="absolute opacity-0 pointer-events-none overflow-hidden -z-50"
        style={{ width: '200px', height: '200px', top: -100, left: -100 }}>
        <YouTube
          videoId={song.youtubeId}
          id={playerId}
          opts={{
            height: '200',
            width: '200',
            playerVars: {
              autoplay: 0,
              controls: 0,
              showinfo: 0,
              rel: 0,
              iv_load_policy: 3,
              modestbranding: 1,
              start: song.startTime || 0,
              enablejsapi: 1,
              playsinline: 1,
              fs: 0,
              origin: window.location.origin,
              widget_referrer: window.location.href,
              host: 'https://www.youtube.com'
            },
          }}
          onReady={onReady}
          onStateChange={onStateChange}
          onPlay={onPlay}
          onPause={onPause}
          onError={(e) => {
            console.error('YouTube Player Error:', e);
            setIsPlayerReady(false);
          }}
        />
      </div>

      <div
        onClick={togglePlay}
        className={cn(
          "relative p-4 rounded-2xl border transition-colors duration-150 cursor-pointer overflow-hidden",
          isPlaying
            ? "bg-surface-3 border-line-strong scale-[1.02]"
            : "bg-surface-2 border-line hover:bg-surface-3 active:scale-95"
        )}
      >
        {/* Playing Animation Glow */}
        <AnimatePresence>
          {isPlaying && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-x-0 bottom-0 h-1/2 pointer-events-none"
            />
          )}
        </AnimatePresence>

        <div className="flex items-center gap-4 relative z-10">
          {/* Album Cover */}
          <div className="relative shrink-0">
            <div className={cn(
              "w-14 h-14 rounded-2xl overflow-hidden bg-surface-3 border border-line transition-transform duration-150 flex items-center justify-center",
              isPlaying && "animate-pulse"
            )}>
              {isPlayerReady ? (
                <img
                  src={song.coverUrl}
                  alt={song.title}
                  className="w-full h-full object-cover"
                  referrerPolicy="no-referrer" loading="lazy" decoding="async" />
              ) : (
                <Loader2 size={24} className="text-accent animate-spin" />
              )}
            </div>

            {/* Play/Pause Button Overlay */}
            <div className={cn(
              "absolute inset-0 flex items-center justify-center bg-black/40 rounded-2xl transition-opacity",
              isPlaying ? "opacity-0 group-hover:opacity-100" : "opacity-100"
            )}>
              {isPlaying ? <Pause size={20} className="text-white" /> : <Play size={20} className="text-white fill-current" />}
            </div>
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-0.5">
              <Music size={10} className={cn(isPlaying ? "text-accent" : "text-subtle")} />
              <span className="text-xs font-black uppercase tracking-widest text-subtle">Music profile</span>
            </div>
            <h4 className="text-sm font-bold truncate leading-tight">{song.title}</h4>
            <p className="text-xs text-muted font-medium truncate mt-0.5">{song.artist}</p>
          </div>

          {/* Mute toggle for viewers */}
          <button
            onClick={toggleMute}
            className="p-2 rounded-full hover:bg-surface-3 transition-colors text-subtle hover:text-fg"
          >
            {isMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
        </div>

        {/* Playback Progress Indicator (Fake/Simple for now) */}
        {isPlaying && (
          <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-surface-2">
            <motion.div
              initial={{ scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={{ duration: 30, repeat: Infinity, ease: "linear" }}
              className="h-full bg-accent origin-left"
            />
          </div>
        )}
      </div>
    </motion.div>
  );
}
