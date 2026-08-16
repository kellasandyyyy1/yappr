import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Plus, Smile } from 'lucide-react';
import { cn } from '../lib/utils';

interface EmojiReactionsProps {
  reactions?: Record<string, string[]>;
  onReact: (emoji: string) => void;
  currentUserId: string;
  isSmall?: boolean;
  /** Chips only — used where the picker lives elsewhere (chat hover actions). */
  hideAddButton?: boolean;
}

const COMMON_EMOJIS = ['❤️', '😂', '🔥', '😮', '😢', '👍', '🙌', '💯'];

export function EmojiReactions({ reactions = {}, onReact, currentUserId, isSmall, hideAddButton }: EmojiReactionsProps) {
  const [showPicker, setShowPicker] = useState(false);

  const totalReactions = Object.values(reactions).reduce((sum, users) => sum + users.length, 0);
  const reactionEntries = Object.entries(reactions)
    .filter(([_, users]) => users.length > 0)
    .sort((a, b) => b[1].length - a[1].length);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <>
        {reactionEntries.map(([emoji, users]) => {
          const hasReacted = users.includes(currentUserId);
          return (
            <button
              key={emoji}
              onClick={(e) => {
                e.stopPropagation();
                onReact(emoji);
              }}
              aria-pressed={hasReacted}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
                "transition-colors duration-100 active:scale-[0.97]",
                hasReacted
                  ? "bg-accent/20 border-accent/40 text-accent"
                  : "bg-surface-2 border-line text-muted hover:text-fg"
              )}
            >
              <span className="leading-none">{emoji}</span>
              {users.length > 1 && <span className="font-semibold">{users.length}</span>}
            </button>
          );
        })}
      </>

      <div className={cn('relative', hideAddButton && 'hidden')}>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setShowPicker(!showPicker);
          }}
          aria-label="Add reaction"
          aria-expanded={showPicker}
          className={cn(
            "rounded-full p-2 transition-colors duration-100 active:scale-[0.97]",
            showPicker ? "bg-accent/10 text-accent" : "text-muted hover:bg-surface-2 hover:text-fg"
          )}
        >
          <Smile size={isSmall ? 14 : 16} />
        </button>

        <AnimatePresence>
          {showPicker && (
            <EmojiPicker
              isSmall={isSmall}
              onPick={(emoji) => {
                onReact(emoji);
                setShowPicker(false);
              }}
              onDismiss={() => setShowPicker(false)}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/** The picker popover, shared by the inline trigger and the chat hover actions. */
function EmojiPicker({
  isSmall,
  onPick,
  onDismiss,
}: {
  isSmall?: boolean;
  onPick: (emoji: string) => void;
  onDismiss: () => void;
}) {
  return (
    <>
      <div className="fixed inset-0" style={{ zIndex: 'var(--z-popover)' }} onClick={onDismiss} />
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 6 }}
        transition={{ duration: 0.12, ease: 'easeOut' }}
        style={{ zIndex: 'calc(var(--z-popover) + 1)' }}
        className={cn(
          'absolute bottom-full left-1/2 mb-2 flex -translate-x-1/2 items-center gap-1 rounded-2xl border border-line bg-surface-2 p-1.5 shadow-xl',
          isSmall ? '' : ''
        )}
      >
        {COMMON_EMOJIS.map((emoji) => (
          <button
            key={emoji}
            onClick={(e) => {
              e.stopPropagation();
              onPick(emoji);
            }}
            className="flex h-9 w-9 items-center justify-center rounded-xl text-lg transition-colors duration-100 hover:bg-surface-3 active:scale-95"
          >
            {emoji}
          </button>
        ))}
      </motion.div>
    </>
  );
}

/**
 * Standalone "react" trigger. Chat messages put this in their hover action
 * cluster so the reaction affordance never floats beneath a short bubble.
 */
export function EmojiPickerButton({ onReact }: { onReact: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-label="Add reaction"
        aria-expanded={open}
        title="Add reaction"
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded-full border border-line transition-colors duration-100',
          open ? 'bg-accent/15 text-accent' : 'bg-surface-3 text-muted hover:text-fg'
        )}
      >
        <Smile size={14} />
      </button>

      <AnimatePresence>
        {open && (
          <EmojiPicker isSmall onPick={(emoji) => { onReact(emoji); setOpen(false); }} onDismiss={() => setOpen(false)} />
        )}
      </AnimatePresence>
    </div>
  );
}
