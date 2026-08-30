import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { CheckCircle2, AlertCircle, Info, X } from './icons';
import { cn } from '../lib/utils';
import {
  ToastType,
  ToastItem,
  autoDismissMs,
  appendToast,
} from '../lib/toastPolicy';

export type { ToastType } from '../lib/toastPolicy';

interface ToastContextType {
  toast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const removeToast = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((message: string, type: ToastType = 'success') => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => appendToast(prev, { id, message, type }));

    const ttl = autoDismissMs(type);
    if (ttl !== null) {
      const timer = setTimeout(() => {
        timers.current.delete(id);
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, ttl);
      timers.current.set(id, timer);
    }
  }, []);

  // Timers outlive the toast they belong to if the provider unmounts mid-flight.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {/* Toasts sit above every modal so confirmations stay visible. */}
      {/* Placement.

          Desktop: the top-right of the READING COLUMN, not of the viewport.
          The right rail is sticky at top-0 and its first card is the profile
          summary — avatar, name, @username — so anything pinned to the
          viewport's top-right corner lands squarely on top of it. The offsets
          below mirror the app shell (fixed sidebar 80/256px, 1120px container,
          gap-8, rail w-80) so the toast stops at main's right edge and never
          covers the rail, at any width.

          Mobile: bottom, lifted clear of the fixed nav by its declared height
          plus the safe-area inset plus a gap, so it can sit on neither the
          navigation icons nor a home indicator. */}
      <div
        style={{ zIndex: 'var(--z-toast)' }}
        className={cn(
          'pointer-events-none fixed',
          // Mobile: above the nav bar.
          'inset-x-0 bottom-[calc(var(--nav-h)+env(safe-area-inset-bottom)+0.75rem)]',
          // Desktop: top, offset by the same fixed sidebar the shell offsets by.
          'sm:bottom-auto sm:top-4 sm:pl-20 lg:pl-64'
        )}
      >
        <div
          className={cn(
            'mx-auto flex w-full max-w-[1120px] gap-2',
            // Padding matches the shell's own. On lg the right padding also
            // clears the rail: 2rem (px-8) + 20rem (w-80) + 2rem (gap-8).
            'px-4 sm:px-6 lg:pl-8 lg:pr-96',
            // Newest toast nearest the thumb on mobile, nearest the top on
            // desktop — in both cases nearest the edge it entered from.
            'flex-col-reverse items-stretch',
            'sm:flex-col sm:items-end'
          )}
        >
        <AnimatePresence mode="popLayout">
          {toasts.map((t, i) => {
            const isError = t.type === 'error';
            return (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0, y: -12, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.15 } }}
                // Each toast down the stack is a few pixels narrower, so a
                // group reads as separate cards rather than one tall block.
                // A margin would push a right-aligned card past the container
                // edge; a width step cascades identically in both alignments
                // and cannot overflow. Capped, or the fourth would look stunted.
                style={{ width: `calc(100% - ${Math.min(i, 3) * 5}px)` }}
                className="pointer-events-auto w-full sm:w-[340px]"
              >
                <div
                  role="status"
                  aria-live={isError ? 'assertive' : 'polite'}
                  className={cn(
                    'flex items-start gap-2.5 rounded-xl border px-3 py-2.5',
                    // A real surface rather than a tinted wash, so the toast
                    // reads as a card lifted off the page. The shadow is the
                    // elevation; it was shadow-2xl, which on a dark theme is a
                    // black smear rather than a lift.
                    'bg-surface shadow-[0_6px_20px_rgba(0,0,0,0.45)]',
                    // Colour is a signal, not decoration: only an error tints
                    // its border. A success used to arrive in the same weight
                    // of green that an error arrived in red.
                    isError ? 'border-danger/40' : 'border-line-strong'
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'mt-px shrink-0',
                      isError ? 'text-danger' : 'text-subtle'
                    )}
                  >
                    {t.type === 'success' && <CheckCircle2 size={14} />}
                    {t.type === 'error' && <AlertCircle size={14} />}
                    {t.type === 'info' && <Info size={14} />}
                  </span>

                  {/* The message is the toast. It was 12px black uppercase in
                      the status colour — shouted, and the same visual weight
                      whether it said "Comment posted" or "Action failed". */}
                  <p
                    className={cn(
                      'min-w-0 flex-1 text-[13px] leading-snug text-fg',
                      isError ? 'font-medium' : 'font-normal'
                    )}
                  >
                    {t.message}
                  </p>

                  <button
                    onClick={() => removeToast(t.id)}
                    aria-label="Dismiss"
                    className="-mr-0.5 mt-px shrink-0 rounded-full p-0.5 text-subtle transition-colors hover:text-fg"
                  >
                    <X size={13} />
                  </button>
                </div>
              </motion.div>
            );
          })}
          </AnimatePresence>
        </div>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}
