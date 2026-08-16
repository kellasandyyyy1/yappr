import React from 'react';
import { cn } from '../lib/utils';

/**
 * Loading placeholders that mirror the shape of the content they replace.
 * The pulse is the only decorative-looking animation kept in the app — it
 * is bound to a real state (data in flight) and stops the moment it resolves.
 */

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-surface-2', className)} />;
}

/** Matches a Feed post card: avatar + name row, body lines, action row. */
export function PostSkeleton() {
  return (
    <div className="rounded-3xl border border-line bg-surface p-5 sm:p-6">
      <div className="flex items-center gap-3">
        <Skeleton className="h-11 w-11 shrink-0 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-2.5 w-20" />
        </div>
      </div>
      <div className="mt-5 space-y-2.5">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-[85%]" />
        <Skeleton className="h-4 w-[60%]" />
      </div>
      <div className="mt-5 flex gap-6 border-t border-line pt-4">
        <Skeleton className="h-8 w-14 rounded-full" />
        <Skeleton className="h-8 w-14 rounded-full" />
        <Skeleton className="h-8 w-10 rounded-full" />
      </div>
    </div>
  );
}

/** Matches a row in the inbox / search results / followers list. */
export function RowSkeleton() {
  return (
    <div className="flex items-center gap-4 rounded-2xl border border-line bg-surface p-4">
      <Skeleton className="h-12 w-12 shrink-0 rounded-full" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-3.5 w-36" />
        <Skeleton className="h-2.5 w-48 max-w-full" />
      </div>
      <Skeleton className="h-2.5 w-10 shrink-0" />
    </div>
  );
}

/** Matches a notification row (avatar + one line of text + timestamp). */
export function NotificationSkeleton() {
  return (
    <div className="flex items-center gap-4 rounded-2xl border border-line bg-surface p-4">
      <Skeleton className="h-12 w-12 shrink-0 rounded-full" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-3.5 w-[70%]" />
        <Skeleton className="h-2.5 w-16" />
      </div>
    </div>
  );
}

/** Matches the profile post grid at its current column count. */
export function GridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="aspect-square animate-pulse rounded-2xl bg-surface-2" />
      ))}
    </div>
  );
}

export function SkeletonList({
  count = 4,
  children,
}: {
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      {Array.from({ length: count }).map((_, i) => (
        <React.Fragment key={i}>{children}</React.Fragment>
      ))}
    </div>
  );
}
