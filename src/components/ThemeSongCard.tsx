import React, { useState, useRef, useEffect } from 'react';
import YouTube, { YouTubeProps } from 'react-youtube';
import { Play, Pause, Music, Volume2, VolumeX, Loader2 } from 'lucide-react';
import { motion } from 'motion/react';
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
      className="group relative w-full max-w-[340px]"
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

      {/* A now-playing chip, not a feature card.
          Previously: 16px padding, a 56px cover, a bold all-caps "MUSIC
          PROFILE" label above the title, and an always-visible mute button —
          four elements competing with the one thing that matters, the song
          name. Now the title is the only prominent text and everything else
          recedes. */}
      {/* Anywhere in the chip toggles playback, but the two real controls below
          are what the keyboard and screen readers see — a <button> may not
          contain another interactive element, so the outer box stays a div. */}
      <div
        onClick={togglePlay}
        className={cn(
          "relative flex items-center gap-2.5 overflow-hidden rounded-xl px-2.5 py-2 cursor-pointer",
          "border transition-colors duration-150",
          // Sits ON the surrounding card rather than beside it: a near
          // transparent fill instead of the solid surface-2 block, so it reads
          // as inline content.
          isPlaying
            ? "border-accent/30 bg-accent/[0.07]"
            : "border-line/70 bg-white/[0.02] hover:bg-white/[0.04]"
        )}
      >
        {/* Cover, 36px. It is also the play control, which removes the need for
            a separate button beside it. */}
        <button
          type="button"
          onClick={togglePlay}
          aria-label={isPlaying ? `Pause ${song.title}` : `Play ${song.title}`}
          className="relative shrink-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg bg-surface-3">
            {isPlayerReady ? (
              <img
                src={song.coverUrl}
                alt=""
                className="h-full w-full object-cover"
                referrerPolicy="no-referrer" loading="lazy" decoding="async"
              />
            ) : (
              <Loader2 size={14} className="animate-spin text-subtle" />
            )}
          </span>
          <span className={cn(
            "absolute inset-0 flex items-center justify-center rounded-lg bg-black/45 transition-opacity duration-100",
            // Once playing, the cover art is more useful than the icon — the
            // control only comes back on hover.
            isPlaying && "opacity-0 group-hover:opacity-100"
          )}>
            {isPlaying
              ? <Pause size={14} className="fill-current text-white" />
              : <Play size={14} className="fill-current text-white" />}
          </span>
        </button>

        {/* Title is the anchor; artist supports it. The "MUSIC PROFILE" caption
            is gone — the note icon says the same thing in a fraction of the
            space. */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <Music size={9} className={cn("shrink-0", isPlaying ? "text-accent" : "text-subtle")} />
            <span className="truncate text-[13px] font-semibold leading-tight text-fg">
              {song.title}
            </span>
          </div>
          {song.artist && (
            <p className="mt-0.5 truncate text-[11px] leading-tight text-subtle">
              {song.artist}
            </p>
          )}
        </div>

        {/* Mute is hover-revealed rather than permanently occupying space next
            to the play control, where it read as a second primary action. It
            stays visible once playback starts, so touch — where hover never
            fires — can still reach it when it matters. */}
        <button
          type="button"
          onClick={toggleMute}
          aria-label={isMuted ? 'Unmute' : 'Mute'}
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-subtle",
            "transition-opacity duration-100 hover:text-fg",
            "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
            isPlaying ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          )}
        >
          {isMuted ? <VolumeX size={13} /> : <Volume2 size={13} />}
        </button>

        {isPlaying && (
          <span className="absolute inset-x-0 bottom-0 h-px bg-accent/50" />
        )}
      </div>
    </motion.div>
  );
}
