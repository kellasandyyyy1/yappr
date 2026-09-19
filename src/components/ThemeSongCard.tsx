import React, { useState, useRef, useEffect } from 'react';
import YouTube, { YouTubeProps } from 'react-youtube';
import { Play, Pause, Music, Loader2, AlertCircle } from './icons';
import { motion } from 'motion/react';
import { ThemeSong } from '../types';
import { cn } from '../lib/utils';
import { useToast } from './ToastContext';

interface ThemeSongCardProps {
  song: ThemeSong;
  isOwnProfile?: boolean;
  onPlay?: () => void;
  /** Overrides the wrapper width. The default 340px cap suits a feed column;
   *  a card that stacks this under a full-width banner wants it to match. */
  className?: string;
  /**
   * "inline" strips the chrome down to a play button and a title, sized to
   * sit in an existing row of text.
   *
   * It is a variant rather than a second component on purpose: playback,
   * error handling and — the part that matters — the module-level registry
   * that stops one song when another starts are all in here. A separate
   * small player would have its own registry and two songs would play over
   * each other again.
   */
  variant?: 'card' | 'inline';
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

/**
 * Only one theme song plays at a time, across every card on the page.
 *
 * The feed renders a card per music post, each with its own independent
 * player, so without a registry two songs started in sequence simply play
 * over each other. Starting one stops whichever was already going.
 */
let nowPlaying: { key: string; stop: () => void } | null = null;

const claimPlayback = (key: string, stop: () => void) => {
  if (nowPlaying && nowPlaying.key !== key) nowPlaying.stop();
  nowPlaying = { key, stop };
};

const releasePlayback = (key: string) => {
  if (nowPlaying?.key === key) nowPlaying = null;
};

/**
 * A song PREVIEW, not a player: artwork, title, artist and a play control.
 *
 * It had a transport row underneath — elapsed time, a seek slider, duration
 * and a volume control — and that is deliberately gone. Two reasons it is not
 * missed: the card is a preview of someone's theme song rather than something
 * you sit and scrub through, and the scrubber cost a timer.
 *
 * The IFrame API exposes getCurrentTime() but fires no timeupdate event, so
 * the only way to drive a progress bar from it is to poll — this polled every
 * 250ms for the whole length of the track, four state updates a second, each
 * re-rendering the card. Deleting the bar deletes the poll.
 *
 * Playback is untouched: play, pause, the one-song-at-a-time registry and the
 * per-song start time all work exactly as before.
 */
export function ThemeSongCard({ song, isOwnProfile, onPlay: onPlayProp, className, variant = 'card' }: ThemeSongCardProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPlayerReady, setIsPlayerReady] = useState(false);
  // Whatever actually went wrong, in words, shown on the card. The old code
  // caught onError, set isPlayerReady(false) and said nothing — so a video with
  // embedding disabled looked identical to one still loading, forever, and
  // every click just re-toasted "Warming up the player…".
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumping this remounts <YouTube>, which is the only way to retry a failed
  // embed: the underlying player is destroyed and rebuilt from scratch.
  const [playerNonce, setPlayerNonce] = useState(0);
  const playerRef = useRef<any>(null);
  // True only between pressing play and playback stopping. Anything that starts
  // the video without this set is playback nobody asked for, and gets stopped.
  const userStartedRef = useRef(false);
  /**
   * The pending "did playVideo() actually work?" check.
   *
   * Held in a ref so the player itself can call it off. The check used to be a
   * fire-and-forget setTimeout that nothing could cancel: it looked once, 1.5s
   * after the tap, and if the player had not left the cued state by then it
   * declared failure — even though playback then started a moment later. On a
   * phone that is the normal case, not the exception, which is why the card
   * said "Couldn't start playback" over a song that was audibly playing.
   */
  const startCheckRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Called the moment the player reports it is doing something. */
  const cancelStartCheck = () => {
    if (startCheckRef.current) {
      clearTimeout(startCheckRef.current);
      startCheckRef.current = null;
    }
  };
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

    // This used to call seekTo(startTime) here, which is what made every music
    // post in the feed start playing the moment its iframe finished loading.
    // Per the IFrame API reference: "If the player is paused when the function
    // is called, it will remain paused. If the function is called from another
    // state (playing, video cued, etc.), the player will play the video."
    // A player that has just become ready is in state 5, video cued — never
    // paused — so the seek always started it.
    //
    // No seek is needed at all: playerVars.start already cues the video at
    // startTime, and togglePlay seeks again before playing.
  };

  const retry = (e: React.MouseEvent) => {
    e.stopPropagation();
    cancelStartCheck();
    playerRef.current = null;
    setIsPlayerReady(false);
    setIsPlaying(false);
    setLoadError(null);
    setPlayerNonce((n) => n + 1);
  };

  const onStateChange: YouTubeProps['onStateChange'] = (event) => {
    // 1 is playing, 2 is paused, 0 is ended, 3 is buffering
    //
    // Buffering counts as success. It means the player accepted the gesture
    // and is fetching — the thing the check below is asking about — so a slow
    // connection must not be reported as a refusal.
    if (event.data === 1 || event.data === 3) cancelStartCheck();

    if (event.data === 1) {
      // A backstop for any route into playback that did not come from the play
      // button — the seekTo above was one, and silently starting the audio is a
      // bad enough failure to be worth guarding rather than merely fixing.
      if (!userStartedRef.current) {
        console.warn('[ThemeSongCard] stopping playback that was not requested', {
          videoId: song.youtubeId,
        });
        try { event.target.pauseVideo(); } catch { /* ignore */ }
        setIsPlaying(false);
        return;
      }
      setIsPlaying(true);
      claimPlayback(playerId, () => {
        userStartedRef.current = false;
        try { event.target.pauseVideo(); } catch { /* ignore */ }
      });
      // Only a song someone chose to play counts as listened to. Autoplay was
      // writing a history row for every music post that scrolled into the feed.
      onPlayProp?.();
    } else if (event.data === 2 || event.data === 0) {
      // Pausing or ending is also the player answering, so nothing is left
      // for an armed check to report.
      cancelStartCheck();
      userStartedRef.current = false;
      releasePlayback(playerId);
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
        userStartedRef.current = false;
        player.pauseVideo();
      } else {
        // Set before playVideo(), so the onStateChange guard above lets this
        // one through.
        userStartedRef.current = true;
        // Essential for mobile: unMute and then Play
        // Some mobile browsers block sound-on autoplay, so we ensure it's loud
        // Full volume, unconditionally. There is no volume control on the
        // card any more, so there is no chosen level to respect — and the
        // device already has one.
        player.unMute();
        player.setVolume(100);
        player.seekTo(song.startTime || 0, true);
        // playVideo() is fire-and-forget: if the browser refuses the gesture
        // or the video is unplayable, nothing throws and nothing happens. The
        // state check confirms it actually started.
        player.playVideo();

        // Cancelled by onStateChange the instant the player reports playing or
        // buffering, so this can only ever fire for a player that did nothing
        // at all. The window is generous for the same reason: nothing is
        // waiting on it, and a phone on a slow connection deserves longer than
        // a desktop before being told it failed.
        cancelStartCheck();
        startCheckRef.current = setTimeout(() => {
          startCheckRef.current = null;
          const p = playerRef.current;
          if (!p || typeof p.getPlayerState !== 'function') return;
          const state = p.getPlayerState();
          // -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued.
          // Re-checked here as well as cancelled above: the two together mean
          // a false report needs the player to be BOTH silent on its state
          // events and sitting in a non-playing state seconds later.
          if (state === -1 || state === 5) {
            console.error('[ThemeSongCard] playVideo() had no effect', {
              videoId: song.youtubeId,
              playerState: state,
              hint: 'The player is alive but refused to start — usually an unplayable video or a blocked autoplay gesture.',
            });
            setLoadError("Couldn't start playback");
          }
        }, 6000);
      }
    } catch (err) {
      console.error('[ThemeSongCard] Play toggle threw', { videoId: song.youtubeId, err });
      setLoadError('Playback failed');
    }
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
      cancelStartCheck();
      releasePlayback(playerId);
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
      className={cn(
        'group relative',
        variant === 'inline' ? 'w-auto max-w-[190px] shrink' : 'w-full max-w-[340px]',
        className
      )}
    >
      {/* The video surface: present, but never shown.

          This is an audio player — none of YouTube's own chrome is used and
          the cover art comes from the thumbnail instead. The iframe still has
          to render, though: display:none and visibility:hidden both let
          browsers treat a player as off-screen and throttle or pause it, which
          is the one thing that must not happen to something whose entire job
          is to keep playing. So it is 1x1, pushed off-canvas, and very
          slightly opaque rather than fully transparent — the same trick the
          song picker's preview player already uses. aria-hidden keeps it out
          of the accessibility tree; the controls below are what is exposed. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute overflow-hidden"
        style={{ width: 1, height: 1, top: -1, left: -1, opacity: 0.01 }}>
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

      {variant === 'inline' ? (
        /* Sized to a line of text: a 24px play button and a title, no fill,
           no border, no transport. It shares a row with an avatar and a
           timestamp, so anything with edges would read as a second card
           dropped into that row. */
        <button
          type="button"
          onClick={togglePlay}
          title={loadError ?? song.title}
          aria-label={
            loadError ? `Retry ${song.title}`
              : isPlaying ? `Pause ${song.title}`
              : `Play ${song.title}`
          }
          className={cn(
            'group/inline flex h-8 min-w-0 items-center gap-1.5 rounded-full pl-0.5 pr-2',
            'transition-colors hover:bg-white/[0.05]'
          )}
        >
          <span
            className={cn(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors',
              loadError
                ? 'bg-danger/15 text-danger'
                : isPlaying
                  ? 'bg-accent text-white'
                  : 'bg-accent/15 text-accent group-hover/inline:bg-accent/25'
            )}
          >
            {loadError ? (
              <AlertCircle size={12} />
            ) : !isPlayerReady ? (
              <Loader2 size={12} className="animate-spin" />
            ) : isPlaying ? (
              <Pause size={12} fill="currentColor" />
            ) : (
              <Play size={12} fill="currentColor" className="ml-px" />
            )}
          </span>
          <span
            className={cn(
              'truncate text-xs font-medium',
              loadError ? 'text-danger/80' : isPlaying ? 'text-fg' : 'text-muted'
            )}
          >
            {loadError ? 'Unavailable' : song.title}
          </span>
        </button>
      ) : (
      <>

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

        {isPlaying && (
          <span className="absolute inset-x-0 bottom-0 h-px bg-accent/50" />
        )}
      </div>

      </>
      )}
    </motion.div>
  );
}
