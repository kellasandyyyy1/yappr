import React, { useState, useEffect } from 'react';
import { users as usersApi, follows as followsApi } from '../lib/db';
import { User } from '../types';
import { Avatar } from './Avatar';
import { Skeleton } from './Skeleton';
import { cn } from '../lib/utils';
import { navigate } from '../lib/router';

interface RightRailProps {
  user: User;
  onUserClick: (uid: string) => void;
  onProfileClick: () => void;
}

/**
 * Desktop-only (>=1024px) companion column. Its job is to give the freed
 * horizontal space something useful to hold instead of leaving black gutters
 * either side of the feed.
 */
export function RightRail({ user, onUserClick, onProfileClick }: RightRailProps) {
  const [counts, setCounts] = useState<{ followers: number; following: number } | null>(null);
  const [suggestions, setSuggestions] = useState<User[] | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        // suggestions() already excludes the viewer and everyone they follow,
        // so the second query no longer has to fetch 20 users and discard 17.
        const [followCounts, people] = await Promise.all([
          followsApi.counts(user.uid),
          usersApi.suggestions(user.uid, 3),
        ]);
        if (cancelled) return;

        setCounts(followCounts);
        setSuggestions(people);
      } catch (err) {
        console.error('Error loading sidebar data:', err);
        if (!cancelled) {
          setCounts({ followers: 0, following: 0 });
          setSuggestions([]);
        }
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [user.uid]);

  const handleFollow = async (targetId: string) => {
    if (pending.has(targetId)) return;
    setPending((prev) => new Set(prev).add(targetId));
    try {
      await followsApi.follow(user.uid, targetId);
      setSuggestions((prev) => (prev ? prev.filter((s) => s.uid !== targetId) : prev));
      setCounts((prev) => prev && { ...prev, following: prev.following + 1 });
    } catch (err) {
      console.error('Error following from suggestions:', err);
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(targetId);
        return next;
      });
    }
  };

  return (
    <aside
      className="hidden w-80 shrink-0 lg:block"
      aria-label="Profile summary and suggestions"
    >
      <div className="sticky top-0 space-y-4 py-6">
        {/* Profile summary */}
        <section className="rounded-2xl border border-line bg-surface p-5">
          <button
            onClick={onProfileClick}
            className="press flex w-full items-center gap-3 text-left"
          >
            <Avatar user={user} size="xl" showStatus statusUser={user} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-semibold text-fg">
                {user.displayName}
              </span>
              <span className="block truncate text-sm text-muted">@{user.username}</span>
            </span>
          </button>

          {user.bio && (
            <p className="mt-3 line-clamp-2 text-sm leading-relaxed text-muted">{user.bio}</p>
          )}

          <div className="mt-4 grid grid-cols-2 divide-x divide-line border-t border-line pt-4">
            {(['followers', 'following'] as const).map((key) => (
              <div key={key} className="flex flex-col items-center">
                {counts ? (
                  <span className="text-lg font-bold text-fg">{counts[key]}</span>
                ) : (
                  <Skeleton className="h-6 w-8" />
                )}
                <span className="mt-0.5 text-xs capitalize text-muted">{key}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Suggestions */}
        <section className="rounded-2xl border border-line bg-surface p-5">
          <h2 className="mb-4 text-sm font-semibold text-fg">Suggested for you</h2>

          {suggestions === null ? (
            <div className="space-y-4">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-10 w-10 rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3 w-24" />
                    <Skeleton className="h-2.5 w-16" />
                  </div>
                  <Skeleton className="h-8 w-16 rounded-full" />
                </div>
              ))}
            </div>
          ) : suggestions.length === 0 ? (
            <p className="text-sm leading-relaxed text-muted">
              You're following everyone here. Check back as more people join.
            </p>
          ) : (
            <ul className="space-y-3">
              {suggestions.map((s) => (
                <li key={s.uid} className="flex items-center gap-3">
                  <button
                    onClick={() => onUserClick(s.uid)}
                    className="press flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <Avatar user={s} size="md" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-fg">
                        {s.displayName}
                      </span>
                      <span className="block truncate text-xs text-muted">@{s.username}</span>
                    </span>
                  </button>
                  <button
                    onClick={() => handleFollow(s.uid)}
                    disabled={pending.has(s.uid)}
                    className={cn(
                      'btn-secondary shrink-0 px-4 py-1.5 text-xs',
                      pending.has(s.uid) && 'opacity-50'
                    )}
                  >
                    Follow
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <footer className="px-2 text-xs leading-relaxed text-muted">
          <nav className="flex flex-wrap gap-x-3 gap-y-1">
            <button
              onClick={() => navigate('/privacy-policy')}
              className="hover:text-accent hover:underline"
            >
              Privacy Policy
            </button>
            <button
              onClick={() => navigate('/terms-of-conditions')}
              className="hover:text-accent hover:underline"
            >
              Terms
            </button>
          </nav>
          <p className="mt-2 text-subtle">
            Developed by{' '}
            <a
              href="https://kellasandrei.netlify.app"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-accent hover:underline"
            >
              andrei
            </a>
          </p>
        </footer>
      </div>
    </aside>
  );
}
