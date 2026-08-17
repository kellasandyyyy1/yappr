import React, { useState, useRef, useEffect } from 'react';
import YouTube, { YouTubeProps } from 'react-youtube';
import { Play, Pause, Music, Volume2, VolumeX, Loader2, AlertCircle } from 'lucide-react';
import { motion } from 'motion/react';
import { ThemeSong } from '../types';
import { cn } from '../lib/utils';
import { useToast } from './ToastContext';

interface ThemeSongCardProps {
  song: ThemeSong;
  isOwnProfile?: boolean;
  onPlay?: () => void;
}

/** YouTube's numeric onError codes. Without this mapping the console showed
 *  `{data: 150}` and the card showed nothing at all. */
const YT_ERRORS: Record<number, string> = {
  2: 'Invalid video ID',
  5: 'The HTML5 player failed to load this video',
  100: 'Video removed or private',
  101: 'The owner disabled playback outside YouTube',
  150: 'The owner disabled playback outside YouTube',
};

/** How long to wait for onReady before declaring the embed dead. The API script
 *  and the iframe together are well under this on any working connection; past
 *  it, something is blocking the embed (an extension, a proxy, a CSP rule) and
 *  no amount of further waiting helps. */
const INIT_TIMEOUT_MS = 8000;

export function ThemeSongCard({ song, isOwnProfile, onPlay: onPlayProp }: ThemeSongCardProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPlayerReady, setIsPlayerReady] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  // Whatever actually went wrong, in words, shown on the card. The old code
  // caught onError, set isPlayerReady(false) and said nothing — so a video with
  // embedding disabled looked identical to one still loading, forever, and
  // every click just re-toasted "Warming up the player…".
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumping this remounts <YouTube>, which is the only way to retry a failed
  // embed: the underlying player is destroyed and rebuilt from scratch.
  const [playerNonce, setPlayerNonce] = useState(0);
  const playerRef = useRef<any>(null);
  const { toast } = useToast();
  const playerId = React.useMemo(
    () => `yt-player-${song.youtubeId}-${Math.random().toString(36).substr(2, 9)}`,
    [song.youtubeId]
  );

  // If onReady has not fired by the deadline, stop pretending it is coming.
  useEffect(() => {
    if (isPlayerReady || loadError) return;
    const timer = setTimeout(() => {
      if (playerRef.current) return;
      const detail = {
        videoId: song.youtubeId,
        origin: window.location.origin,
        elapsedMs: INIT_TIMEOUT_MS,
        hint: 'onReady never fired — the iframe API or the embed itself is being blocked. Check the Network tab for www.youtube.com/iframe_api and any CSP violation in the console.',
      };
      console.error('[ThemeSongCard] YouTube player failed to initialise', detail);
      setLoadError("Player didn't load");
    }, INIT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [isPlayerReady, loadError, song.youtubeId, playerNonce]);

  const onReady: YouTubeProps['onReady'] = (event) => {
    playerRef.current = event.target;
    setIsPlayerReady(true);
    setLoadError(null);
    // Seek to start time
    try {
      event.target.seekTo(song.startTime || 0, true);
    } catch (e) {
      console.warn('Seek failed in onReady:', e);
    }
  };

  const retry = (e: React.MouseEvent) => {
    e.stopPropagation();
    playerRef.current = null;
    setIsPlayerReady(false);
    setIsPlaying(false);
    setLoadError(null);
    setPlayerNonce((n) => n + 1);
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

    if (loadError) {
      retry(e);
      return;
    }

    if (!player) {
      // Still inside the init window. Say so honestly rather than implying it
      // is about to work — the timeout above will resolve this either way.
      toast('Still loading the player…', 'info');
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
        // playVideo() is fire-and-forget: if the browser refuses the gesture
        // or the video is unplayable, nothing throws and nothing happens. The
        // state check confirms it actually started.
        player.playVideo();
        setTimeout(() => {
          const p = playerRef.current;
          if (!p || typeof p.getPlayerState !== 'function') return;
          const state = p.getPlayerState();
          // -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued.
          if (state === -1 || state === 5) {
            console.error('[ThemeSongCard] playVideo() had no effect', {
              videoId: song.youtubeId,
              playerState: state,
              hint: 'The player is alive but refused to start — usually an unplayable video or a blocked autoplay gesture.',
            });
            setLoadError("Couldn't start playback");
          }
        }, 1500);
      }
    } catch (err) {
      console.error('[ThemeSongCard] Play toggle threw', { videoId: song.youtubeId, err });
      setLoadError('Playback failed');
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

  // Stop the video when the card goes away.
  //
  // This read playerRef.current in the effect body, which runs at mount — when
  // the ref is still null, since onReady has not fired yet. The cleanup then
  // closed over that null and did nothing, so navigating away from a profile
  // left the song playing from a component that no longer exists. Reading the
  // ref inside the cleanup gets the player that exists at teardown.
  useEffect(() => {
    return () => {
      const player = playerRef.current;
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
          // Remounting on retry is what actually rebuilds a dead embed.
          key={`${song.youtubeId}-${playerNonce}`}
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
            },
          }}
          onReady={onReady}
          onStateChange={onStateChange}
          onPlay={onPlay}
          onPause={onPause}
          onError={(e) => {
            // The code is the whole story here, and it was being thrown away:
            // 101/150 means the owner disabled off-site playback, which no
            // retry can fix, and the reader needs to be told rather than left
            // watching a spinner.
            const code = Number((e as any)?.data);
            const reason = YT_ERRORS[code] ?? `Player error ${code}`;
            console.error('[ThemeSongCard] YouTube player error', {
              videoId: song.youtubeId,
              code,
              reason,
              origin: window.location.origin,
            });
            playerRef.current = null;
            setIsPlayerReady(false);
            setIsPlaying(false);
            setLoadError(reason);
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
          loadError
            ? "border-danger/30 bg-danger/[0.06]"
            : isPlaying
              ? "border-accent/30 bg-accent/[0.07]"
              : "border-line/70 bg-white/[0.02] hover:bg-white/[0.04]"
        )}
      >
        {/* Cover, 36px. It is also the play control, which removes the need for
            a separate button beside it. */}
        <button
          type="button"
          onClick={togglePlay}
          aria-label={
            loadError ? `Retry loading ${song.title}`
            : isPlaying ? `Pause ${song.title}`
            : `Play ${song.title}`
          }
          className="relative shrink-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg bg-surface-3">
            {isPlayerReady && !loadError ? (
              <img
                src={song.coverUrl}
                alt=""
                className="h-full w-full object-cover"
                referrerPolicy="no-referrer" loading="lazy" decoding="async"
              />
            ) : loadError ? (
              <AlertCircle size={15} className="text-danger" />
            ) : (
              <Loader2 size={14} className="animate-spin text-subtle" />
            )}
          </span>
          {!loadError && (
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
          )}
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
          {/* The failure replaces the artist line: same slot, no extra height,
              and it names the actual cause instead of a spinner that never
              resolves. */}
          {loadError ? (
            <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] leading-tight text-danger">
              <span className="truncate">{loadError}</span>
              <button
                type="button"
                onClick={retry}
                className="shrink-0 font-medium underline underline-offset-2 hover:text-fg"
              >
                Retry
              </button>
            </p>
          ) : song.artist ? (
            <p className="mt-0.5 truncate text-[11px] leading-tight text-subtle">
              {song.artist}
            </p>
          ) : null}
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
            isPlaying ? "opacity-100" : "opacity-0 group-hover:opacity-100",
            loadError && "hidden"
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
