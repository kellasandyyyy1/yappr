import React from 'react';
import { Avatar, AvatarSize } from './Avatar';
import { cn } from '../lib/utils';
import type { User } from '../types';

/** The pixel box each Avatar size renders at, for the "+N" bubble to match. */
const OVERFLOW_BOX: Record<string, string> = {
  xs: 'h-6 w-6 text-[10px]',
  sm: 'h-8 w-8 text-[11px]',
  md: 'h-10 w-10 text-xs',
};

interface AvatarStackProps {
  users: Array<User | undefined>;
  /** How many faces before the rest become "+N". */
  max?: number;
  size?: Extract<AvatarSize, 'xs' | 'sm' | 'md'>;
  className?: string;
}

/**
 * Overlapping avatars with a "+N" overflow bubble.
 *
 * Presentational only — no click handling. The two places this appears want
 * different things from a tap: the feed opens each liker's profile, so every
 * avatar there is its own button, while the pin detail opens one member list,
 * so the whole stack is a single target. Baking either in would make the
 * other one wrong, so the caller wraps this however it needs.
 *
 * The ring is the surface colour rather than a border: it is what carves each
 * face out of the one behind it, and a border would darken the overlap
 * instead of hiding it.
 */
export function AvatarStack({ users, max = 3, size = 'sm', className }: AvatarStackProps) {
  const present = users.filter(Boolean) as User[];
  if (present.length === 0) return null;

  const shown = present.slice(0, max);
  const extra = present.length - shown.length;

  return (
    <div className={cn('flex -space-x-2', className)}>
      {shown.map((u, i) => (
        <span
          key={u.uid ?? u.id ?? i}
          className="rounded-full ring-2 ring-surface"
          // Earlier avatars sit on top, so the stack reads left to right.
          style={{ zIndex: shown.length - i }}
        >
          <Avatar user={u} size={size} />
        </span>
      ))}
      {extra > 0 && (
        <span
          className={cn(
            'flex items-center justify-center rounded-full bg-surface-3 font-semibold text-muted ring-2 ring-surface',
            OVERFLOW_BOX[size]
          )}
        >
          +{extra}
        </span>
      )}
    </div>
  );
}
