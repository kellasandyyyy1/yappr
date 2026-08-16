import React, { useState, useEffect, useCallback } from 'react';
import { users as usersApi, follows as followsApi } from '../lib/db';
import { User } from '../types';
import { Search as SearchIcon, Loader2, Clock, X, QrCode, Sparkles } from 'lucide-react';
import { cn } from '../lib/utils';
import { Avatar } from './Avatar';
import { RowSkeleton } from './Skeleton';
import { migrateStorageKey } from '../lib/brand';

interface SearchViewProps {
  user: User;
  onUserClick: (uid: string) => void;
  onBack: () => void;
  onScanClick?: () => void;
}

const RECENTS_KEY = 'yappr:recent-searches';
migrateStorageKey('privy:recent-searches', RECENTS_KEY);
const MAX_RECENTS = 6;

function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function writeRecents(terms: string[]) {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(terms.slice(0, MAX_RECENTS)));
  } catch {
    /* storage unavailable (private mode) — recents are best-effort */
  }
}

export function SearchView({ user, onUserClick, onScanClick }: SearchViewProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [results, setResults] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [recents, setRecents] = useState<string[]>(() => readRecents());
  const [suggested, setSuggested] = useState<User[] | null>(null);
  const [followingIds, setFollowingIds] = useState<Set<string>>(new Set());
  const [busyFollow, setBusyFollow] = useState<string | null>(null);

  // Follow graph + default suggestions, loaded once so the page is never blank.
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        // suggestions() excludes people already followed server-side, so this
        // no longer pulls 30 users down to keep at most 8 of them.
        const [ids, people] = await Promise.all([
          followsApi.following(user.uid),
          usersApi.suggestions(user.uid, 8),
        ]);
        if (cancelled) return;
        setFollowingIds(ids);
        setSuggested(people);
      } catch (err) {
        console.error('Error loading explore defaults:', err);
        if (!cancelled) setSuggested([]);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [user.uid]);

  useEffect(() => {
    if (!searchTerm.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    const run = async () => {
      try {
        // A real indexed ILIKE against the trigram indexes. The Firestore
        // version downloaded the first 100 user documents — an arbitrary slice,
        // not the first 100 matches — and filtered them in the browser, so
        // anyone outside that slice was simply unfindable.
        const found = await usersApi.search(searchTerm.trim(), user.uid, 20);
        if (!cancelled) setResults(found);
      } catch (err) {
        console.error('Error searching users:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    const debounce = setTimeout(run, 300);
    return () => {
      cancelled = true;
      clearTimeout(debounce);
    };
  }, [searchTerm, user.uid]);

  const rememberSearch = useCallback((term: string) => {
    const trimmed = term.trim();
    if (trimmed.length < 2) return;
    setRecents((prev) => {
      const next = [trimmed, ...prev.filter((t) => t.toLowerCase() !== trimmed.toLowerCase())].slice(
        0,
        MAX_RECENTS
      );
      writeRecents(next);
      return next;
    });
  }, []);

  const clearRecents = () => {
    setRecents([]);
    writeRecents([]);
  };

  const removeRecent = (term: string) => {
    setRecents((prev) => {
      const next = prev.filter((t) => t !== term);
      writeRecents(next);
      return next;
    });
  };

  const openProfile = (uid: string) => {
    rememberSearch(searchTerm);
    onUserClick(uid);
  };

  const toggleFollow = async (targetId: string) => {
    if (busyFollow) return;
    setBusyFollow(targetId);
    const isFollowing = followingIds.has(targetId);

    // Optimistic — the button is the only thing that changes.
    setFollowingIds((prev) => {
      const next = new Set(prev);
      isFollowing ? next.delete(targetId) : next.add(targetId);
      return next;
    });

    try {
      // The existence check the Firestore path needed is gone: the composite
      // primary key makes follow() idempotent, and it raises the notification.
      if (isFollowing) await followsApi.unfollow(user.uid, targetId);
      else await followsApi.follow(user.uid, targetId);
    } catch (err) {
      console.error('Error toggling follow:', err);
      setFollowingIds((prev) => {
        const next = new Set(prev);
        isFollowing ? next.add(targetId) : next.delete(targetId);
        return next;
      });
    } finally {
      setBusyFollow(null);
    }
  };

  const renderUserRow = (u: User) => {
    const isFollowing = followingIds.has(u.uid);
    return (
      <li key={u.uid}>
        <div
          className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-3 transition-colors duration-100 hover:bg-surface-2"
        >
          <button
            onClick={() => openProfile(u.uid)}
            className="press flex min-w-0 flex-1 items-center gap-3 text-left"
          >
            <Avatar user={u} size="lg" showStatus statusUser={u} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-semibold text-fg">
                {u.displayName}
              </span>
              <span className="block truncate text-sm text-muted">@{u.username}</span>
              {u.bio && <span className="mt-0.5 block truncate text-sm text-subtle">{u.bio}</span>}
            </span>
          </button>

          <button
            onClick={() => toggleFollow(u.uid)}
            disabled={busyFollow === u.uid}
            aria-pressed={isFollowing}
            className={cn(
              'shrink-0 rounded-full px-4 py-2 text-sm font-semibold transition-colors duration-100',
              'active:scale-[0.97] disabled:opacity-50',
              isFollowing
                ? 'border border-line bg-surface-2 text-muted hover:text-fg'
                : 'bg-accent text-white hover:bg-accent-deep'
            )}
          >
            {isFollowing ? 'Following' : 'Follow'}
          </button>
        </div>
      </li>
    );
  };

  const hasQuery = searchTerm.trim().length > 0;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold tracking-tight text-fg">Explore</h1>
        {onScanClick && (
          <button
            onClick={onScanClick}
            className="press flex items-center gap-2 rounded-full border border-line bg-surface-2 px-4 py-2 text-sm font-semibold text-accent transition-colors duration-100 hover:bg-surface-3"
          >
            <QrCode size={16} />
            Scan QR
          </button>
        )}
      </header>

      <div className="relative">
        <SearchIcon
          size={18}
          className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"
        />
        <input
          type="search"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          onBlur={() => rememberSearch(searchTerm)}
          placeholder="Search for people"
          aria-label="Search for people"
          className="field h-12 pl-11 pr-11"
        />
        {loading && (
          <Loader2
            size={16}
            className="absolute right-4 top-1/2 -translate-y-1/2 animate-spin text-accent"
          />
        )}
      </div>

      {hasQuery ? (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-muted">
            {loading ? 'Searching…' : `${results.length} result${results.length === 1 ? '' : 's'}`}
          </h2>

          {loading && results.length === 0 ? (
            <div className="space-y-3">
              <RowSkeleton />
              <RowSkeleton />
              <RowSkeleton />
            </div>
          ) : results.length > 0 ? (
            <ul className="space-y-3">{results.map(renderUserRow)}</ul>
          ) : (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-muted">
                <SearchIcon size={22} />
              </div>
              <p className="text-base font-semibold text-fg">No people found</p>
              <p className="max-w-xs text-sm leading-relaxed text-muted">
                Nothing matches &ldquo;{searchTerm}&rdquo;. Try a different name or username.
              </p>
            </div>
          )}
        </section>
      ) : (
        <>
          {/* Default state — never a blank screen. */}
          {recents.length > 0 && (
            <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-muted">
                  <Clock size={15} />
                  Recent searches
                </h2>
                <button
                  onClick={clearRecents}
                  className="text-sm font-semibold text-accent hover:text-accent-soft"
                >
                  Clear all
                </button>
              </div>
              <ul className="flex flex-wrap gap-2">
                {recents.map((term) => (
                  <li key={term}>
                    <span
                      className="flex items-center gap-1 rounded-full border border-line bg-surface-2 pl-3.5 text-sm text-fg"
                    >
                      <button
                        onClick={() => setSearchTerm(term)}
                        className="py-2 font-medium transition-colors duration-100 hover:text-accent"
                      >
                        {term}
                      </button>
                      <button
                        onClick={() => removeRecent(term)}
                        aria-label={`Remove ${term} from recent searches`}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors duration-100 hover:text-fg"
                      >
                        <X size={14} />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted">
              <Sparkles size={15} />
              Suggested people
            </h2>

            {suggested === null ? (
              <div className="space-y-3">
                <RowSkeleton />
                <RowSkeleton />
                <RowSkeleton />
                <RowSkeleton />
              </div>
            ) : suggested.length > 0 ? (
              <ul className="space-y-3">{suggested.map(renderUserRow)}</ul>
            ) : (
              <p className="py-8 text-center text-sm leading-relaxed text-muted">
                You're following everyone on Yappr right now. Search above to find someone
                specific.
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
