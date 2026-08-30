/**
 * Client-side video handling: validation and poster-frame extraction.
 *
 * ── NO TRANSCODING, DELIBERATELY ────────────────────────────────────────────
 * Compressing in the browser was considered and rejected for now. ffmpeg.wasm
 * is ~30MB of WebAssembly, which would dwarf this app's entire 1.5MB precache;
 * its multithreaded build needs SharedArrayBuffer, which needs COOP/COEP
 * headers, and `Cross-Origin-Embedder-Policy: require-corp` would break every
 * cross-origin image the app now loads (GIPHY, YouTube thumbnails, Supabase
 * storage) unless every one of them served CORP headers. The single-threaded
 * build avoids that but transcodes at a fraction of realtime — minutes for a
 * one-minute clip, on the main thread's doorstep.
 *
 * The stopgap is a hard size limit, enforced here before a byte is uploaded.
 */

/**
 * 50MB.
 *
 * Not a preference — it is the ceiling this Supabase project allows. The
 * project-level upload limit sits above every bucket, and bucket creation was
 * rejected at 60/80/100MB. Raising it is a dashboard and plan change.
 *
 * Checked client-side so an oversized file is refused instantly with its actual
 * size named, rather than after a long upload ending in an opaque 413.
 */
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

/**
 * quicktime (.mov) is what iPhones record. Omitting it would mean video
 * silently failing for every iOS user while working on Android.
 */
export const ACCEPTED_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];

/** For the file picker's `accept` attribute. */
export const VIDEO_ACCEPT = ACCEPTED_VIDEO_TYPES.join(',');

export const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)}MB`
    : `${Math.max(1, Math.round(bytes / 1024))}KB`;

/** Null when the file is acceptable, otherwise the reason, ready to display. */
export function validateVideo(file: File): string | null {
  // Some browsers report an empty type for .mov; fall back to the extension
  // rather than rejecting a file the bucket would have accepted.
  const type = file.type || guessTypeFromName(file.name);

  if (!ACCEPTED_VIDEO_TYPES.includes(type)) {
    return `${type || 'That file type'} isn't supported. Use MP4, WebM or MOV.`;
  }
  if (file.size > MAX_VIDEO_BYTES) {
    return `That video is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_VIDEO_BYTES)}.`;
  }
  if (file.size === 0) return 'That file is empty.';
  return null;
}

const guessTypeFromName = (name: string): string => {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'mp4' || ext === 'm4v') return 'video/mp4';
  if (ext === 'webm') return 'video/webm';
  if (ext === 'mov' || ext === 'qt') return 'video/quicktime';
  return '';
};

export interface VideoPoster {
  blob: Blob;
  /** Object URL for immediate preview. The caller must revoke it. */
  objectUrl: string;
  width: number;
  height: number;
  durationSeconds: number;
}

/**
 * Grabs a frame to use as the poster.
 *
 * Seeks a little way in rather than to 0: the very first frame of a phone
 * recording is routinely black or a blur while the sensor settles, and a black
 * poster is indistinguishable from a broken one.
 *
 * Everything happens locally — the file is never uploaded to produce this.
 * Rejects rather than returning a placeholder, so the caller decides whether a
 * posterless video is still worth sending.
 */
export function extractPoster(file: File, seekTo = 0.5): Promise<VideoPoster> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement('video');

    // muted + playsInline are required for a seek to actually render a frame on
    // iOS Safari, which otherwise refuses to decode without a user gesture.
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.src = objectUrl;

    let settled = false;
    const cleanup = () => {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(objectUrl);
    };
    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(new Error(reason));
    };

    // A codec the browser cannot decode produces neither an error nor a
    // loadeddata event on some platforms — it simply never resolves. Without
    // this the composer would sit on a spinner for ever.
    const timer = setTimeout(() => fail('Could not read that video (timed out).'), 15000);

    video.onerror = () => fail("This browser can't decode that video.");

    video.onloadedmetadata = () => {
      // Clamp: seeking past the end of a very short clip never fires `seeked`.
      const target = Math.min(seekTo, Math.max(0, (video.duration || 0) - 0.05));
      video.currentTime = Number.isFinite(target) ? target : 0;
    };

    video.onseeked = () => {
      if (settled) return;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        if (!canvas.width || !canvas.height) return fail('That video has no visible frames.');

        const ctx = canvas.getContext('2d');
        if (!ctx) return fail('Could not read a frame from that video.');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const duration = video.duration;
        const width = canvas.width;
        const height = canvas.height;

        canvas.toBlob(
          (blob) => {
            if (!blob) return fail('Could not read a frame from that video.');
            settled = true;
            clearTimeout(timer);
            cleanup();
            resolve({
              blob,
              objectUrl: URL.createObjectURL(blob),
              width,
              height,
              durationSeconds: Number.isFinite(duration) ? duration : 0,
            });
          },
          'image/jpeg',
          0.8
        );
      } catch (err) {
        // A cross-origin source would taint the canvas. Local files never do,
        // but the failure is worth naming rather than surfacing as "undefined".
        fail(err instanceof Error ? err.message : 'Could not read a frame from that video.');
      }
    };
  });
}

/** mm:ss for the player's time readouts. */
export const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};
