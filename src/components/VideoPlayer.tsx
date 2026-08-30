import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Play, Pause, Volume2, VolumeX, Maximize, Loader2, AlertCircle } from 'lucide-react';
import { cn } from '../lib/utils';
import { formatDuration } from '../lib/video';
import { resolveStorageUrl } from '../lib/supabase';

interface VideoPlayerProps {
  /** Public URL, or the `supabase://bucket/path` form for a private bucket. */
  src: string;
  /** Poster frame. Same two forms as `src`. */
  poster?: string | null;
  className?: string;
}

/**
 * Video with the app's own controls.
 *
 * `controls` is deliberately absent from the <video> element: the browser's
 * native bar is a light chrome-coloured strip that looks pasted onto a dark
 * app, and it differs on every platform.
 *
 * Nothing autoplays. A feed that starts playing on scroll is the same failure
 * as the music card that started every song on load — the poster and a play
 * button are the whole interaction until someone asks for more.
 */
export function VideoPlayer({ src, poster, className }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const scrubbingRef = useRef(false);

  // Chat videos live in a private bucket, so the stored value is a
  // `supabase://` reference that has to be signed before it can be played.
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);
  const [resolvedPoster, setResolvedPoster] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);

  const [started, setStarted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [muted, setMuted] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setResolveError(null);
    (async () => {
      try {
        const [s, p] = await Promise.all([
          resolveStorageUrl(src),
          poster ? resolveStorageUrl(poster) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        if (!s) {
          setResolveError('This video is no longer available.');
          return;
        }
        setResolvedSrc(s);
        setResolvedPoster(p);
      } catch (err) {
        if (!cancelled) {
          console.error('[VideoPlayer] could not resolve source', { src, err });
          setResolveError('Could not load this video.');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [src, poster]);

  /** Hide the controls a moment after playback starts, reveal on interaction. */
  useEffect(() => {
    if (!playing) { setControlsVisible(true); return; }
    const timer = setTimeout(() => setControlsVisible(false), 2200);
    return () => clearTimeout(timer);
  }, [playing, current]);

  const togglePlay = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    setControlsVisible(true);
    if (el.paused) {
      setStarted(true);
      // play() rejects if the browser blocks it; without the catch that is an
      // unhandled rejection and the UI silently stays on the poster.
      el.play().catch((err) => {
        console.error('[VideoPlayer] play() was refused', { src, err });
        setError('Playback was blocked by the browser.');
      });
    } else {
      el.pause();
    }
  }, [src]);

  const toggleMute = () => {
    const el = videoRef.current;
    if (!el) return;
    el.muted = !el.muted;
    setMuted(el.muted);
  };

  const seek = (seconds: number) => {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = seconds;
    setCurrent(seconds);
  };

  const goFullscreen = () => {
    const el = wrapRef.current;
    if (!el) return;
    // iOS Safari exposes no Fullscreen API on arbitrary elements, only
    // webkitEnterFullscreen on the <video> itself.
    const anyVideo = videoRef.current as any;
    if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    else if (anyVideo?.webkitEnterFullscreen) anyVideo.webkitEnterFullscreen();
  };

  if (resolveError) {
    return (
      <div className={cn('flex items-center justify-center gap-2 rounded-xl border border-line bg-surface-2 py-8', className)}>
        <AlertCircle size={16} className="text-danger" />
        <span className="text-sm text-muted">{resolveError}</span>
      </div>
    );
  }

  const progress = duration > 0 ? (current / duration) * 100 : 0;

  return (
    <div
      ref={wrapRef}
      className={cn('group/video relative overflow-hidden rounded-xl bg-black', className)}
      onMouseMove={() => setControlsVisible(true)}
    >
      {resolvedSrc && (
        <video
          ref={videoRef}
          src={resolvedSrc}
          poster={resolvedPoster ?? undefined}
          // metadata, not auto: a feed with several videos would otherwise
          // download all of them before anyone pressed play.
          preload="metadata"
          playsInline
          className="block max-h-[70vh] w-full"
          onClick={togglePlay}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onWaiting={() => setWaiting(true)}
          onPlaying={() => setWaiting(false)}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
          onTimeUpdate={(e) => { if (!scrubbingRef.current) setCurrent(e.currentTarget.currentTime); }}
          onEnded={() => { setPlaying(false); setStarted(false); setCurrent(0); }}
          onError={() => {
            const el = videoRef.current;
            console.error('[VideoPlayer] media error', { src, code: el?.error?.code, message: el?.error?.message });
            setError("This video can't be played.");
          }}
        />
      )}

      {/* Poster state: the only thing on screen until someone presses play. */}
      {!started && !error && (
        <button
          type="button"
          onClick={togglePlay}
          aria-label="Play video"
          className="absolute inset-0 flex items-center justify-center bg-black/25 transition-colors hover:bg-black/35"
        >
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-black/60 backdrop-blur-sm">
            <Play size={24} className="ml-0.5 fill-white text-white" />
          </span>
        </button>
      )}

      {waiting && started && !error && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Loader2 size={28} className="animate-spin text-white/80" />
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80 px-4 text-center">
          <AlertCircle size={20} className="text-danger" />
          <p className="text-sm text-white">{error}</p>
        </div>
      )}

      {/* Controls. Present once playback has started; they fade out while
          playing and come back on hover, focus or pause. */}
      {started && !error && (
        <div
          className={cn(
            'absolute inset-x-0 bottom-0 flex items-center gap-2 px-2.5 pb-2 pt-6',
            'bg-gradient-to-t from-black/80 to-transparent',
            'transition-opacity duration-200',
            controlsVisible || !playing
              ? 'opacity-100'
              : 'opacity-0 group-hover/video:opacity-100 focus-within:opacity-100'
          )}
        >
          <button
            type="button"
            onClick={togglePlay}
            aria-label={playing ? 'Pause' : 'Play'}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white/90 transition-colors hover:text-white"
          >
            {playing ? <Pause size={15} className="fill-current" /> : <Play size={15} className="fill-current" />}
          </button>

          <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-white/80">
            {formatDuration(current)}
          </span>

          <input
            type="range"
            min={0}
            max={duration > 0 ? Math.floor(duration) : 100}
            step={0.1}
            value={Math.min(current, duration || 100)}
            disabled={duration === 0}
            aria-label="Seek"
            onPointerDown={() => { scrubbingRef.current = true; }}
            onPointerUp={(e) => { scrubbingRef.current = false; seek(Number((e.target as HTMLInputElement).value)); }}
            onChange={(e) => seek(Number(e.target.value))}
            style={{ ['--fill' as string]: `${progress}%` }}
            className="track-slider h-1 min-w-0 flex-1"
          />

          <span className="w-9 shrink-0 text-[10px] tabular-nums text-white/80">
            {formatDuration(duration)}
          </span>

          <button
            type="button"
            onClick={toggleMute}
            aria-label={muted ? 'Unmute' : 'Mute'}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white/90 transition-colors hover:text-white"
          >
            {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </button>

          <button
            type="button"
            onClick={goFullscreen}
            aria-label="Fullscreen"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white/90 transition-colors hover:text-white"
          >
            <Maximize size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
