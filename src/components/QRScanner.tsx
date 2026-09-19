import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { motion, useReducedMotion } from 'motion/react';
import {
  Camera, Zap, AlertCircle, Loader2, Image as ImageIcon,
  CheckCircle2, RefreshCw,
} from './icons';
import { Modal, ModalHeader, ModalBody } from './Modal';
import { Avatar } from './Avatar';
import { users as usersApi } from '../lib/db';
import { parseProfileQr } from '../lib/brand';
import { cn } from '../lib/utils';
import type { User } from '../types';

interface QRScannerProps {
  onScan: (data: string) => void;
  onClose: () => void;
}

/**
 * What the scanner is doing, as one value.
 *
 * Previously this was four independent booleans, which allowed states that
 * cannot happen (initialising AND processing an image) and left the most
 * important one unrepresented: a code was decoded and we are about to act on
 * it. The abrupt hand-off people noticed was that gap — the modal vanished
 * mid-frame with nothing to confirm what had been read.
 */
type Phase =
  | { kind: 'starting' }
  | { kind: 'scanning' }
  | { kind: 'reading-image' }
  | { kind: 'found'; user: User; payload: string }
  | { kind: 'unknown' }
  | { kind: 'error'; message: string; denied: boolean };

/** How long the confirmation sits on screen before handing off. Long enough to
 *  read a handle, short enough not to feel like a wait. */
const CONFIRM_MS = 1100;

const READER_ID = 'qr-reader';

export function QRScanner({ onScan, onClose }: QRScannerProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const [torchOn, setTorchOn] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);

  const scannerRef = useRef<Html5Qrcode | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const reduceMotion = useReducedMotion();

  /**
   * The parent's callback, held in a ref.
   *
   * App defines handleScan in its render body, so it is a new function on every
   * render. As an effect dependency that restarted the camera each time the app
   * re-rendered — a visible flicker and a fresh permission check. The effect
   * below runs once; this is how it still calls the current callback.
   */
  const onScanRef = useRef(onScan);
  useEffect(() => { onScanRef.current = onScan; }, [onScan]);

  /** Guards against the decoder firing twice before the camera has stopped. */
  const handledRef = useRef(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopCamera = useCallback(async () => {
    const scanner = scannerRef.current;
    if (!scanner) return;
    try {
      if (scanner.isScanning) await scanner.stop();
    } catch (err) {
      // removeChild/Node errors are the library racing React's unmount. They
      // mean the video is already gone, which is the goal.
      const message = (err as Error)?.message ?? '';
      if (!message.includes('removeChild') && !message.includes('Node')) {
        console.warn('Scanner stop warning:', err);
      }
    }
  }, []);

  /**
   * Resolve a decoded payload into something to show.
   *
   * The lookup happens HERE rather than in the parent so the confirmation can
   * name who was found. It also closes a real gap: a non-Yappr code used to be
   * logged to the console and otherwise ignored, so the scanner simply stopped
   * and sat there looking broken.
   */
  const handleDecoded = useCallback(async (payload: string) => {
    if (handledRef.current) return;
    handledRef.current = true;

    await stopCamera();

    const userId = parseProfileQr(payload);
    if (!userId) {
      setPhase({ kind: 'unknown' });
      return;
    }

    try {
      const found = await usersApi.get(userId);
      if (!found) {
        setPhase({ kind: 'unknown' });
        return;
      }
      setPhase({ kind: 'found', user: found, payload });
      confirmTimer.current = setTimeout(() => onScanRef.current(payload), CONFIRM_MS);
    } catch (err) {
      console.error('Error resolving scanned profile:', err);
      // The code parsed; only the lookup failed. Hand off anyway rather than
      // calling a valid code unknown — the preview card will surface it.
      onScanRef.current(payload);
    }
  }, [stopCamera]);

  const start = useCallback(async (mode: 'environment' | 'user') => {
    handledRef.current = false;
    setPhase({ kind: 'starting' });
    setTorchOn(false);
    setTorchAvailable(false);

    try {
      const scanner = scannerRef.current ?? new Html5Qrcode(READER_ID);
      scannerRef.current = scanner;

      await scanner.start(
        { facingMode: mode },
        { fps: 10, qrbox: { width: 200, height: 200 }, aspectRatio: 1.0 },
        (decodedText) => { void handleDecoded(decodedText); },
        () => {
          // Fires continuously for every frame without a code. Not an error.
        }
      );

      setPhase({ kind: 'scanning' });

      // Torch is a capability of the running track, so it can only be asked
      // about once the camera is live — and most front cameras and most
      // desktops do not have one. The button reflects that rather than
      // pretending to be a control that does nothing.
      try {
        const capabilities = scanner.getRunningTrackCapabilities() as Record<string, unknown>;
        setTorchAvailable('torch' in capabilities);
      } catch {
        setTorchAvailable(false);
      }
    } catch (err) {
      const raw = (err as Error)?.message ?? String(err);
      const denied = raw.includes('NotAllowedError') || raw.includes('Permission denied');
      const missing = raw.includes('NotFoundError');

      setPhase({
        kind: 'error',
        denied,
        message: denied
          ? 'Yappr needs camera access to scan. Allow it in your browser settings, then try again.'
          : missing
            ? 'No camera found on this device. You can still import a photo of a code.'
            : raw || 'Could not start the camera.',
      });
    }
  }, [handleDecoded]);

  // Runs once. `start` is stable and the parent callback is behind a ref, so
  // nothing here re-triggers on a parent render.
  useEffect(() => {
    void start('environment');
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      void stopCamera();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flipCamera = async () => {
    const next = facing === 'environment' ? 'user' : 'environment';
    setFacing(next);
    await stopCamera();
    await start(next);
  };

  const toggleTorch = async () => {
    const scanner = scannerRef.current;
    if (!scanner || !torchAvailable) return;
    try {
      // `torch` is not in the standard MediaTrackConstraintSet type, but it is
      // what every browser that supports a torch actually accepts.
      await scanner.applyVideoConstraints({
        advanced: [{ torch: !torchOn }],
      } as unknown as MediaTrackConstraints);
      setTorchOn((on) => !on);
    } catch (err) {
      console.error('Could not toggle the torch:', err);
      setTorchAvailable(false);
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = ''; // so the same file can be picked again
    if (!file) return;

    await stopCamera();
    handledRef.current = false;
    setPhase({ kind: 'reading-image' });

    try {
      const scanner = scannerRef.current ?? new Html5Qrcode(READER_ID);
      scannerRef.current = scanner;
      const result = await scanner.scanFileV2(file, false);
      await handleDecoded(result.decodedText);
    } catch (err) {
      console.error('Failed to scan image:', err);
      setPhase({ kind: 'unknown' });
    }
  };

  const live = phase.kind === 'scanning';
  const settled = phase.kind === 'found' || phase.kind === 'unknown';

  /** The line above the frame: one instruction, one status, never both. */
  const statusLine = (() => {
    switch (phase.kind) {
      case 'starting': return { text: 'Starting the camera…', tone: 'muted' as const };
      case 'scanning': return { text: 'Looking for a code…', tone: 'muted' as const };
      case 'reading-image': return { text: 'Reading that image…', tone: 'muted' as const };
      case 'found': return { text: `Found @${phase.user.username}`, tone: 'good' as const };
      case 'unknown': return { text: "That isn't a Yappr code", tone: 'bad' as const };
      case 'error': return { text: phase.denied ? 'Camera blocked' : 'Camera unavailable', tone: 'bad' as const };
    }
  })();

  return (
    <Modal onClose={onClose} size="sm" variant="center" labelledBy="scanner-title">
      <ModalHeader
        title="Scan a code"
        subtitle="Point at someone's Yappr QR"
        onClose={onClose}
        id="scanner-title"
      />

      <ModalBody className="space-y-3">
        {/* Instruction and status sit ABOVE the frame. As a caption underneath
            they were the last thing read, after the person had already worked
            out what to do — or failed to. */}
        <div className="flex items-center justify-center gap-2 text-center">
          {live && !reduceMotion && (
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
            </span>
          )}
          {phase.kind === 'found' && <CheckCircle2 size={15} className="shrink-0 text-accent-soft" />}
          {(phase.kind === 'unknown' || phase.kind === 'error') && (
            <AlertCircle size={15} className="shrink-0 text-danger" />
          )}
          <p
            className={cn(
              'text-sm font-medium',
              statusLine.tone === 'good' && 'text-accent-soft',
              statusLine.tone === 'bad' && 'text-danger',
              statusLine.tone === 'muted' && 'text-muted'
            )}
          >
            {statusLine.text}
          </p>
        </div>

        {/* --- the frame ------------------------------------------------- */}
        <div className="relative aspect-square w-full overflow-hidden rounded-2xl border border-line bg-black">
          <div id={READER_ID} className="h-full w-full" />

          {/* Corner brackets. They turn green on a hit, which is the same
              signal as the status line in the place the eye already is. */}
          {!settled || phase.kind === 'found' ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="relative h-[190px] w-[190px]">
                {([
                  'top-0 left-0 border-t-2 border-l-2 rounded-tl-xl',
                  'top-0 right-0 border-t-2 border-r-2 rounded-tr-xl',
                  'bottom-0 left-0 border-b-2 border-l-2 rounded-bl-xl',
                  'bottom-0 right-0 border-b-2 border-r-2 rounded-br-xl',
                ]).map((corner) => (
                  <span
                    key={corner}
                    className={cn(
                      'absolute h-6 w-6 transition-colors duration-300',
                      corner,
                      phase.kind === 'found' ? 'border-accent-soft' : 'border-accent',
                      live && !reduceMotion && 'animate-pulse'
                    )}
                  />
                ))}
              </div>
            </div>
          ) : null}

          {/* The sweep, only while actually scanning. */}
          {live && !reduceMotion && (
            <div className="pointer-events-none absolute inset-0 border-[24px] border-black/30">
              <motion.div
                animate={{ top: ['0%', '100%', '0%'] }}
                transition={{ duration: 3, repeat: Infinity, ease: 'linear' }}
                className="absolute left-0 right-0 h-0.5 bg-accent/60"
              />
            </div>
          )}

          {(phase.kind === 'starting' || phase.kind === 'reading-image') && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black">
              <Loader2 size={20} className="animate-spin text-accent" />
            </div>
          )}

          {phase.kind === 'found' && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/85 p-4 text-center"
            >
              <motion.span
                initial={reduceMotion ? false : { scale: 0.7 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 400, damping: 18 }}
              >
                <Avatar user={phase.user} size="lg" />
              </motion.span>
              <div>
                <p className="flex items-center justify-center gap-1.5 text-sm font-semibold text-fg">
                  <CheckCircle2 size={15} className="text-accent-soft" />
                  {phase.user.displayName}
                </p>
                <p className="text-xs text-muted">@{phase.user.username}</p>
              </div>
              <p className="text-[11px] uppercase tracking-wider text-subtle">Opening…</p>
            </motion.div>
          )}

          {phase.kind === 'unknown' && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/90 p-5 text-center">
              <AlertCircle size={22} className="text-danger" />
              <p className="text-sm text-muted">
                No Yappr code there. Try again, or import a photo of one.
              </p>
              <button
                type="button"
                onClick={() => start(facing)}
                className="btn-primary flex h-9 items-center gap-1.5 px-4 text-xs"
              >
                <RefreshCw size={13} />
                Scan again
              </button>
            </div>
          )}

          {phase.kind === 'error' && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/90 p-5 text-center">
              <AlertCircle size={22} className="text-danger" />
              <p className="max-h-24 overflow-y-auto text-xs leading-relaxed text-muted">
                {phase.message}
              </p>
              <div className="flex w-full max-w-[200px] flex-col gap-2">
                <button
                  type="button"
                  onClick={() => start(facing)}
                  className="btn-primary flex h-9 w-full items-center justify-center gap-1.5 text-xs"
                >
                  <RefreshCw size={13} />
                  Try again
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="btn-secondary flex h-9 w-full items-center justify-center gap-1.5 text-xs"
                >
                  <ImageIcon size={13} />
                  Import an image
                </button>
              </div>
            </div>
          )}
        </div>

        {/* --- controls --------------------------------------------------- */}
        {/* Labelled, not icon-only. The bottom nav earns icon-only through
            daily repetition; these three are used rarely enough that nobody
            builds that memory — and a torch and a camera flip are not
            self-evident glyphs. title= covers the desktop hover as well. */}
        <div className="grid grid-cols-3 gap-2">
          <ControlButton
            icon={<Camera size={17} />}
            label={facing === 'environment' ? 'Front camera' : 'Back camera'}
            title="Switch between the front and back camera"
            onClick={flipCamera}
            disabled={phase.kind === 'starting' || phase.kind === 'found'}
          />
          <ControlButton
            icon={<ImageIcon size={17} />}
            label="Import"
            title="Scan a QR code from a saved photo"
            onClick={() => fileInputRef.current?.click()}
            disabled={phase.kind === 'found'}
          />
          <ControlButton
            icon={<Zap size={17} />}
            label="Flash"
            title={torchAvailable ? 'Turn the torch on or off' : 'This camera has no torch'}
            onClick={toggleTorch}
            disabled={!torchAvailable || phase.kind === 'found'}
            active={torchOn}
          />
        </div>

        <input
          type="file"
          ref={fileInputRef}
          onChange={handleImageUpload}
          accept="image/*"
          className="hidden"
        />
      </ModalBody>

      <style>{`
        #${READER_ID} video {
          width: 100% !important;
          height: 100% !important;
          object-fit: cover !important;
        }
        /* The library injects its own controls and a border; the frame above
           is the affordance, so they are hidden rather than styled. */
        #${READER_ID} img[alt="Info icon"],
        #${READER_ID}__dashboard { display: none !important; }
      `}</style>
    </Modal>
  );
}

function ControlButton({
  icon, label, title, onClick, disabled, active,
}: {
  icon: React.ReactNode;
  label: string;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={cn(
        'flex flex-col items-center gap-1 rounded-xl border px-2 py-2.5 transition-colors',
        active
          ? 'border-accent/50 bg-accent/15 text-accent'
          : 'border-line bg-surface-2 text-muted hover:bg-surface-3 hover:text-fg',
        disabled && 'cursor-not-allowed opacity-40 hover:bg-surface-2 hover:text-muted'
      )}
    >
      {icon}
      <span className="text-[11px] font-medium leading-none">{label}</span>
    </button>
  );
}
