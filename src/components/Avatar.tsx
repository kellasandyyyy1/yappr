import React, { useState, useEffect } from 'react';
import { User } from '../types';
import { cn } from '../lib/utils';
import { StatusIndicator } from './StatusIndicator';

/**
 * The single avatar style used everywhere in the app.
 *
 * One shape, one border, one fallback. Previously each surface invented its
 * own treatment (blue→indigo gradient here, indigo→purple there, plain grey
 * elsewhere), so the same person looked different in the inbox than in the
 * feed. The fallback is now always neutral initials — never a coloured
 * gradient — so a list of conversations reads as one consistent column.
 */

const SIZES = {
  xs: { box: 'w-6 h-6', text: 'text-[9px]' },
  sm: { box: 'w-8 h-8', text: 'text-[11px]' },
  md: { box: 'w-10 h-10', text: 'text-xs' },
  lg: { box: 'w-12 h-12', text: 'text-sm' },
  xl: { box: 'w-14 h-14', text: 'text-base' },
  '2xl': { box: 'w-20 h-20', text: 'text-xl' },
  '3xl': { box: 'w-32 h-32', text: 'text-3xl' },
  '4xl': { box: 'w-36 h-36 sm:w-40 sm:h-40', text: 'text-4xl' },
} as const;

export type AvatarSize = keyof typeof SIZES;

interface AvatarProps {
  user?: Pick<User, 'displayName' | 'username' | 'photoURL'> | null;
  /** Overrides `user.photoURL` — for group chats and previews. */
  src?: string;
  /** Overrides `user.displayName` for the initials fallback. */
  name?: string;
  size?: AvatarSize;
  className?: string;
  /** Renders the presence dot in the bottom-right corner. */
  showStatus?: boolean;
  statusUser?: User | null;
  /** Replaces the initials fallback (e.g. a group icon). */
  fallbackIcon?: React.ReactNode;
}

function initialsFor(name?: string): string {
  if (!name) return '?';
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/**
 * Deterministic tint per person, derived from their identity string.
 *
 * Every initials avatar used to be the same navy, which made a contact list
 * read as one repeated shape. Hue is spread across the wheel; saturation and
 * lightness are fixed low/high respectively so the fill stays quiet against
 * the dark theme and the initials keep >7:1 contrast on top of it. The blue
 * accent stays reserved for interactive state — these are identity tints, not
 * accents, and they never appear on a control.
 */
function tintFor(seed: string): { background: string; color: string } {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0; // keep in int32
  }
  const hue = Math.abs(hash) % 360;
  return {
    background: `hsl(${hue} 42% 22%)`,
    color: `hsl(${hue} 65% 82%)`,
  };
}

export function Avatar({
  user,
  src,
  name,
  size = 'md',
  className,
  showStatus = false,
  statusUser,
  fallbackIcon,
}: AvatarProps) {
  const photo = (src ?? user?.photoURL ?? '').trim();
  const label = name ?? user?.displayName ?? user?.username ?? '';
  const [failed, setFailed] = useState(false);

  // A new src is a fresh chance to load — clear any previous error.
  useEffect(() => setFailed(false), [photo]);

  const { box, text } = SIZES[size];
  const showPhoto = photo !== '' && !failed;
  // Seed on username first — it's stable even when a display name is edited.
  const tint = tintFor(user?.username || label || '?');

  return (
    <div className={cn('relative shrink-0', box, className)}>
      <div
        className={cn(
          'w-full h-full overflow-hidden rounded-full border border-line',
          'flex items-center justify-center'
        )}
        style={showPhoto || fallbackIcon ? undefined : { backgroundColor: tint.background }}
      >
        {showPhoto ? (
          <img
            src={photo}
            alt={label ? `${label}'s avatar` : ''}
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
            className="w-full h-full object-cover"
          />
        ) : fallbackIcon ? (
          <span className="flex h-full w-full items-center justify-center bg-surface-2 text-muted">
            {fallbackIcon}
          </span>
        ) : (
          <span
            className={cn('font-semibold select-none', text)}
            style={{ color: tint.color }}
          >
            {initialsFor(label)}
          </span>
        )}
      </div>

      {showStatus && (
        <StatusIndicator
          user={statusUser ?? (user as User | null | undefined) ?? null}
          className="absolute bottom-0 right-0 rounded-full ring-2 ring-bg"
        />
      )}
    </div>
  );
}
