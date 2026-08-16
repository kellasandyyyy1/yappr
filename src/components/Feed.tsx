import React, { useState, useEffect, useRef } from 'react';
import {
  posts as postsApi,
  likes as likesApi,
  follows as followsApi,
  reactions as reactionsApi,
  songs as songsApi,
  users as usersApi,
} from '../lib/db';
import { supabase } from '../lib/supabase';
import { User, Post, ThemeSong } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import { Heart, MessageCircle, Share2, Plus, X, Image as ImageIcon, Edit3, Trash2, History, AtSign } from 'lucide-react';
import { cn, formatTimeAgo } from '../lib/utils';
import { ImageViewer } from './ImageViewer';
import { VoiceMessage } from './VoiceMessage';
import { EmojiReactions } from './EmojiReactions';
import { Avatar } from './Avatar';
import { PostSkeleton } from './Skeleton';
import { ShareModal } from './ShareModal';
import { ThemeSongCard } from './ThemeSongCard';
import { sendPushNotification } from '../lib/sendPush';

interface FeedProps {
  user: User;
  onNewPost: () => void;
  onProfileClick: () => void;
  onUserClick?: (uid: string) => void;
  onShowComments: (postId: string, postUserId: string) => void;
  onEditingChange?: (isEditing: boolean) => void;
}

function PostActions({ postId, initialLikes, initialComments, isLiked, onLike, onShowComments, onShare }: {
  postId: string;
  initialLikes: number;
  initialComments: number;
  isLiked: boolean;
  onLike: () => void;
  onShowComments: () => void;
  onShare: () => void;
}) {
  const [likesCount, setLikesCount] = useState(initialLikes);
  const [commentsCount, setCommentsCount] = useState(initialComments);

  // Counters are columns on `posts`, maintained by trigger, so a live count
  // is one subscription to that row rather than two subscriptions that
  // streamed every like and comment document just to measure the result size.
  useEffect(() => {
    setLikesCount(initialLikes);
    setCommentsCount(initialComments);

    const channel = supabase
      .channel(`post-counts:${postId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'posts', filter: `id=eq.${postId}` },
        (payload) => {
          const row = payload.new as { likes_count?: number; comments_count?: number };
          if (typeof row.likes_count === 'number') setLikesCount(row.likes_count);
          if (typeof row.comments_count === 'number') setCommentsCount(row.comments_count);
        }
      )
      .subscribe();

    return () => { void supabase.removeChannel(channel); };
  }, [postId, initialLikes, initialComments]);

  // Every control below is >=44x44 via `tap`, with the count sitting inside
  // the same hit area rather than beside it.
  return (
    <div className="flex items-center gap-1">
      <button
        onClick={onLike}
        aria-pressed={isLiked}
        aria-label={`Like — ${likesCount} likes`}
        className={cn(
          'tap gap-2 rounded-full px-3 transition-colors duration-100',
          isLiked ? 'text-danger' : 'text-muted hover:text-danger'
        )}
      >
        <Heart size={19} fill={isLiked ? 'currentColor' : 'none'} />
        <span className="text-sm font-semibold">{likesCount}</span>
      </button>

      <button
        onClick={onShowComments}
        aria-label={`Comments — ${commentsCount} comments`}
        className="tap gap-2 rounded-full px-3 text-muted transition-colors duration-100 hover:text-accent"
      >
        <MessageCircle size={19} />
        <span className="text-sm font-semibold">{commentsCount}</span>
      </button>

      <button
        onClick={onShare}
        aria-label="Share post"
        className="tap rounded-full px-3 text-muted transition-colors duration-100 hover:text-accent"
      >
        <Share2 size={19} />
      </button>
    </div>
  );
}

export function Feed({ user, onNewPost, onProfileClick, onUserClick, onShowComments, onEditingChange }: FeedProps) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [tick, setTick] = useState(0);
  // Keyset cursor: the created_at of the last row on the previous page.
  // Replaces Firestore's startAfter(documentSnapshot).
  const [cursor, setCursor] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const observerTarget = useRef<HTMLDivElement>(null);
  const isInitialLoad = useRef(true);

  // Periodic tick to refresh "X mins ago" labels
  useEffect(() => {
    const interval = setInterval(() => {
      setTick(t => t + 1);
    }, 30000); 
    return () => clearInterval(interval);
  }, []);

  const [isPosting, setIsPosting] = useState(false);
  const [editingPost, setEditingPost] = useState<Post | null>(null);
  const [editContent, setEditContent] = useState('');
  const [showHistory, setShowHistory] = useState<Post | null>(null);
  const [isDeleting, setIsDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [sharingPost, setSharingPost] = useState<Post | null>(null);
  const [followingIds, setFollowingIds] = useState<Set<string>>(new Set());
  const [userLikes, setUserLikes] = useState<Set<string>>(new Set());
  const [viewingImage, setViewingImage] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);

  const recordListenedMusic = async (song: ThemeSong) => {
    try {
      await songsApi.recordPlay(user.uid, song, 'listened');
    } catch (err) {
      console.error('Error recording listening history:', err);
    }
  };

  /**
   * One page of the feed.
   *
   * Replaces five parallel chunked `in` queries plus an N+1 author fetch with
   * a single keyset-paginated query that joins the author, images, song and
   * reactions. Audience filtering now happens in the database via the
   * can_view_post() RLS policy, so `visibility` is a real boundary rather than
   * the client-side presentation filter it was under Firestore.
   */
  const loadPosts = async (isFirstLoad = false) => {
    if (isLoadingMore || (!hasMore && !isFirstLoad)) return;

    setIsLoadingMore(true);
    try {
      const page = await postsApi.feed(user.uid, {
        cursor: isFirstLoad ? null : cursor,
        limit: 15,
      });

      setCursor(page.nextCursor);
      setHasMore(page.nextCursor !== null);

      if (isFirstLoad) {
        setPosts(page.posts);
      } else {
        setPosts((prev) => {
          const existing = new Set(prev.map((p) => p.id));
          return [...prev, ...page.posts.filter((p) => !existing.has(p.id))];
        });
      }
    } catch (error) {
      console.error('Feed loading error:', error);
    } finally {
      setIsLoadingMore(false);
      setHasLoadedOnce(true);
    }
  };

  // Follow graph and the viewer's likes. Both are plain reads now — Firestore
  // needed live listeners because it had no way to ask "which of these do I
  // like" without streaming the whole collection.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const [following, liked] = await Promise.all([
        followsApi.following(user.uid),
        likesApi.byUser(user.uid),
      ]);
      if (cancelled) return;
      setFollowingIds(following);
      setUserLikes(liked);
    })();

    return () => { cancelled = true; };
  }, [user.uid]);

  // Initial page, and re-fetch when the follow graph changes shape.
  useEffect(() => {
    if (isInitialLoad.current) {
      isInitialLoad.current = false;
    }
    loadPosts(true);
  }, [user.uid, followingIds.size]);

  // New posts from people you follow, prepended live.
  useEffect(() => {
    const authors = new Set<string>([user.uid, ...followingIds]);
    return postsApi.subscribeToNew(authors, (post) => {
      setPosts((prev) => (prev.some((p) => p.id === post.id) ? prev : [post, ...prev]));
    });
  }, [user.uid, followingIds]);

  // Re-load posts when following list changes initially or when self posts
  useEffect(() => {
    loadPosts(true);
  }, [followingIds.size]);

  // Infinite scroll observer
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !isLoadingMore) {
          loadPosts(false);
        }
      },
      { threshold: 0.1 }
    );

    if (observerTarget.current) {
      observer.observe(observerTarget.current);
    }

    return () => observer.disconnect();
  }, [hasMore, isLoadingMore, cursor]);

  useEffect(() => {
    const isAnyModalOpen = !!editingPost || !!showHistory || !!confirmDelete;
    onEditingChange?.(isAnyModalOpen);
    return () => onEditingChange?.(false);
  }, [editingPost, showHistory, confirmDelete, onEditingChange]);

  const handleFollow = async (targetUserId: string) => {
    // Optimistic — the composite PK makes the write idempotent, so a double
    // click cannot create the duplicate follow rows Firestore's addDoc allowed.
    setFollowingIds((prev) => new Set(prev).add(targetUserId));
    try {
      await followsApi.follow(user.uid, targetUserId);
      sendPushNotification(
        targetUserId,
        'New Follower',
        `${user.displayName} started following you`,
        `/profile?id=${user.uid}`
      );
    } catch (err) {
      console.error('Follow failed:', err);
      setFollowingIds((prev) => {
        const next = new Set(prev);
        next.delete(targetUserId);
        return next;
      });
    }
  };

  const handleUnfollow = async (targetUserId: string) => {
    setFollowingIds((prev) => {
      const next = new Set(prev);
      next.delete(targetUserId);
      return next;
    });
    try {
      await followsApi.unfollow(user.uid, targetUserId);
    } catch (err) {
      console.error('Unfollow failed:', err);
      setFollowingIds((prev) => new Set(prev).add(targetUserId));
    }
  };

  const handleLike = async (postId: string, postUserId: string) => {
    const isLiked = userLikes.has(postId);

    // Optimistic. No counter write here — the likes_count trigger owns it, so
    // the two-write race that left Firestore counters permanently wrong is gone.
    setUserLikes((prev) => {
      const next = new Set(prev);
      isLiked ? next.delete(postId) : next.add(postId);
      return next;
    });

    try {
      if (isLiked) {
        await likesApi.unlike(postId, user.uid);
      } else {
        await likesApi.like(postId, user.uid, postUserId);
        if (user.uid !== postUserId) {
          sendPushNotification(
            postUserId,
            'New Like',
            `${user.displayName} liked your post`,
            `/post/${postId}`
          );
        }
      }
    } catch (err) {
      console.error('Like failed:', err);
      setUserLikes((prev) => {
        const next = new Set(prev);
        isLiked ? next.add(postId) : next.delete(postId);
        return next;
      });
    }
  };

  const handleReactPost = async (postId: string, emoji: string) => {
    const post = posts.find((p) => p.id === postId);
    if (!post) return;

    const alreadyReacted = (post.reactions?.[emoji] ?? []).includes(user.uid);
    // Clicking the same emoji clears it; a different one replaces it. The
    // upsert on (post_id, user_id) does both without the read-modify-write of
    // the whole reactions map, which could drop a concurrent reaction.
    const nextEmoji = alreadyReacted ? null : emoji;

    try {
      await reactionsApi.setOnPost(postId, user.uid, nextEmoji);

      setPosts((prev) =>
        prev.map((p) => {
          if (p.id !== postId) return p;
          const reactions: Record<string, string[]> = {};
          for (const [key, ids] of Object.entries<string[]>(p.reactions ?? {})) {
            const kept = ids.filter((id) => id !== user.uid);
            if (kept.length > 0) reactions[key] = kept;
          }
          if (nextEmoji) reactions[nextEmoji] = [...(reactions[nextEmoji] ?? []), user.uid];
          return { ...p, reactions };
        })
      );

      if (nextEmoji && user.uid !== post.userId) {
        sendPushNotification(
          post.userId,
          'New Reaction',
          `${user.displayName} reacted ${emoji} to your post`,
          `/post/${postId}`
        );
      }
    } catch (err) {
      console.error('Reaction failed:', err);
    }
  };

  const handleDeletePost = async (postId: string) => {
    setIsDeleting(postId);
    setConfirmDelete(null);
    try {
      await postsApi.remove(postId);
      // ON DELETE CASCADE removes the images, comments, likes and reactions,
      // so there is no orphan cleanup to do client-side.
      setPosts((prev) => prev.filter((p) => p.id !== postId));
    } catch (err) {
      console.error('Delete failed:', err);
    } finally {
      setIsDeleting(null);
    }
  };

  const handleUpdatePost = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingPost || !editContent.trim()) return;

    setIsPosting(true);
    const next = editContent.trim();
    try {
      await postsApi.update(editingPost.id, editingPost.content, next);
      setPosts((prev) =>
        prev.map((p) =>
          p.id === editingPost.id
            ? {
                ...p,
                content: next,
                editHistory: [
                  ...(p.editHistory ?? []),
                  { content: editingPost.content, editedAt: new Date().toISOString() },
                ],
              }
            : p
        )
      );
      setEditingPost(null);
      onEditingChange?.(false);
      setEditContent('');
    } catch (err) {
      console.error('Update failed:', err);
    } finally {
      setIsPosting(false);
    }
  };

  const handleMentionClick = async (username: string) => {
    try {
      // Exact lookup against the unique username index.
      const { data } = await supabase
        .from('users').select('id').eq('username', username.toLowerCase()).maybeSingle();
      if (data?.id) onUserClick?.(data.id);
    } catch (err) {
      console.error('Error resolving mention:', err);
    }
  };

  const renderContent = (content: string) => {
    const parts = content.split(/(@\w+)/g);
    return parts.map((part, i) => {
      if (part.startsWith('@')) {
        const username = part.slice(1);
        return (
          <span 
            key={i} 
            onClick={(e) => {
              e.stopPropagation();
              handleMentionClick(username);
            }}
            className="text-accent font-bold hover:underline cursor-pointer inline-flex items-center gap-0.5"
          >
            <AtSign size={10} className="text-accent" />
            {part}
          </span>
        );
      }
      return part;
    });
  };

  const isInitialLoading = !hasLoadedOnce && posts.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <header className="mb-2 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold tracking-tight text-fg">Feed</h1>
        <button
          onClick={onProfileClick}
          className="press flex items-center gap-2.5 rounded-full py-1 pl-1 pr-3 transition-colors duration-100 hover:bg-surface-2"
        >
          <Avatar user={user} size="sm" showStatus statusUser={user} />
          <span className="hidden text-sm font-semibold text-fg sm:inline">
            {user.displayName.split(' ')[0]}
          </span>
        </button>
      </header>

      {isInitialLoading && (
        <div className="flex flex-col gap-4">
          <PostSkeleton />
          <PostSkeleton />
          <PostSkeleton />
        </div>
      )}

      {posts.map((post) => (
        <article
          key={post.id}
          id={`post-${post.id}`}
          className="flex flex-col gap-4 rounded-3xl border border-line bg-surface p-5 sm:p-6"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <button
                onClick={() => onUserClick?.(post.userId)}
                aria-label={`View ${post.user?.displayName ?? 'user'}'s profile`}
                className="press shrink-0"
              >
                <Avatar user={post.user} size="lg" showStatus statusUser={post.user} />
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <button
                    onClick={() => onUserClick?.(post.userId)}
                    className="truncate text-[15px] font-semibold text-fg transition-colors duration-100 hover:text-accent"
                  >
                    {post.user?.displayName}
                  </button>
                  {post.userId !== user.uid && (
                    <button
                      onClick={() =>
                        followingIds.has(post.userId)
                          ? handleUnfollow(post.userId)
                          : handleFollow(post.userId)
                      }
                      className={cn(
                        'shrink-0 rounded-full px-3 py-1 text-xs font-semibold transition-colors duration-100',
                        followingIds.has(post.userId)
                          ? 'border border-line bg-surface-2 text-muted hover:text-fg'
                          : 'bg-accent text-white hover:bg-accent-deep'
                      )}
                    >
                      {followingIds.has(post.userId) ? 'Following' : 'Follow'}
                    </button>
                  )}
                  {post.editHistory && post.editHistory.length > 0 && (
                    <button
                      onClick={() => setShowHistory(post)}
                      className="flex shrink-0 items-center gap-1 rounded-md border border-line bg-surface-2 px-1.5 py-0.5 text-xs font-medium text-accent"
                    >
                      <History size={11} />
                      Edited
                    </button>
                  )}
                </div>
                <p className="mt-0.5 truncate text-sm text-muted">
                  @{post.user?.username} · {formatTimeAgo(post.createdAt)}
                </p>
              </div>
            </div>

            {post.userId === user.uid && (
              <div className="flex shrink-0 items-center">
                <button
                  onClick={() => {
                    setEditingPost(post);
                    setEditContent(post.content);
                    onEditingChange?.(true);
                  }}
                  aria-label="Edit post"
                  className="tap rounded-full text-muted transition-colors duration-100 hover:text-accent"
                >
                  <Edit3 size={18} />
                </button>
                <button
                  onClick={() => setConfirmDelete(post.id)}
                  disabled={isDeleting === post.id}
                  aria-label="Delete post"
                  className="tap rounded-full text-muted transition-colors duration-100 hover:text-danger disabled:opacity-50"
                >
                  <Trash2 size={18} />
                </button>
              </div>
            )}
          </div>

          {post.content && (
            <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-fg">
              {renderContent(post.content)}
            </p>
          )}

          {post.imageUrls && post.imageUrls.length > 0 && (
            <div
              className={cn(
                'relative grid gap-1 overflow-hidden rounded-2xl border border-line',
                post.imageUrls.length === 1 ? 'grid-cols-1' : 'grid-cols-2'
              )}
            >
              {post.imageUrls.map((url, i) => {
                if (i > 3) return null;
                const isLast = i === 3 && post.imageUrls!.length > 4;

                return (
                  <div
                    key={i}
                    onClick={(e) => {
                      e.stopPropagation();
                      setViewingImage(url || '');
                    }}
                    className={cn(
                      'relative cursor-zoom-in overflow-hidden bg-surface-2',
                      post.imageUrls!.length === 1 ? 'aspect-auto max-h-[500px]' : 'aspect-square',
                      post.imageUrls!.length === 3 && i === 0 ? 'col-span-2 aspect-[16/9]' : ''
                    )}
                  >
                    {url ? (
                      <img
                        src={url}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-subtle">
                        <ImageIcon size={24} />
                      </div>
                    )}
                    {isLast && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/70">
                        <span className="text-2xl font-bold text-white">
                          +{post.imageUrls!.length - 4}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {post.type === 'voice' && post.voiceUrl && (
            <div className="rounded-2xl border border-line bg-surface-2 p-4">
              <VoiceMessage url={post.voiceUrl} />
            </div>
          )}

          {post.song && (
            <div className="flex justify-center">
              <ThemeSongCard song={post.song} onPlay={() => recordListenedMusic(post.song!)} />
            </div>
          )}

          <EmojiReactions
            reactions={post.reactions}
            onReact={(emoji) => handleReactPost(post.id, emoji)}
            currentUserId={user.uid}
          />

          <div className="flex items-center justify-between gap-2 border-t border-line pt-2">
            <PostActions
              postId={post.id}
              initialLikes={post.likesCount || 0}
              initialComments={post.commentsCount || 0}
              isLiked={userLikes.has(post.id)}
              onLike={() => handleLike(post.id, post.userId)}
              onShowComments={() => onShowComments(post.id, post.userId)}
              onShare={() => setSharingPost(post)}
            />

            {(post.likesCount || 0) > 0 && post.recentLikers && post.recentLikers.length > 0 && (
              <div className="flex -space-x-2">
                {post.recentLikers.map((liker, i) => (
                  <button
                    key={liker.uid}
                    onClick={() => onUserClick?.(liker.uid)}
                    aria-label={`View ${liker.displayName}'s profile`}
                    className="press rounded-full ring-2 ring-surface"
                    style={{ zIndex: 3 - i }}
                  >
                    <Avatar user={liker} size="xs" />
                  </button>
                ))}
                {post.likesCount > 3 && (
                  <div
                    className="flex h-6 w-6 items-center justify-center rounded-full bg-surface-3 text-xs font-semibold text-muted ring-2 ring-surface"
                  >
                    +{post.likesCount - 3}
                  </div>
                )}
              </div>
            )}
          </div>
        </article>
      ))}

      {/* Pagination sentinel */}
      <div ref={observerTarget} className="flex justify-center">
        {isLoadingMore && !isInitialLoading && (
          <div className="w-full">
            <PostSkeleton />
          </div>
        )}
        {!hasMore && posts.length > 0 && (
          <p className="py-8 text-sm text-subtle">You're all caught up.</p>
        )}
        {!isLoadingMore && hasLoadedOnce && posts.length === 0 && (
          <div className="mx-auto flex max-w-sm flex-col items-center gap-4 py-16 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-surface-2 text-muted">
              <Plus size={26} />
            </div>
            <div className="space-y-1.5">
              <p className="text-base font-semibold text-fg">Your feed is empty</p>
              <p className="text-sm leading-relaxed text-muted">
                Follow some people or write your first post to see something here.
              </p>
            </div>
            <button onClick={onNewPost} className="btn-primary px-6 py-2.5 text-sm">
              Write a post
            </button>
          </div>
        )}
      </div>

      {/* Edit Modal */}
      <AnimatePresence>
        {editingPost && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => {
                setEditingPost(null);
                onEditingChange?.(false);
              }}
              style={{ zIndex: "var(--z-backdrop)" }} className="fixed inset-0 bg-black/85"
            />
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              style={{ zIndex: "var(--z-modal)" }} className="fixed inset-x-0 bottom-0 max-h-[90dvh] h-[70dvh] glass rounded-t-3xl p-6 flex flex-col sm:inset-x-auto sm:left-1/2 sm:bottom-auto sm:top-1/2 sm:h-auto sm:max-h-[80dvh] sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-3xl"
            >
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg font-bold text-fg">Edit post</h2>
                <button
                  onClick={() => {
                    setEditingPost(null);
                    onEditingChange?.(false);
                  }}
                  aria-label="Close"
                  className="tap rounded-full border border-line bg-surface-2 text-muted transition-colors duration-100 hover:text-fg"
                >
                  <X size={20} />
                </button>
              </div>

              <form onSubmit={handleUpdatePost} className="flex flex-1 flex-col sm:min-h-[220px]">
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  className="flex-1 resize-none bg-transparent text-[15px] leading-relaxed text-fg focus:outline-none"
                  placeholder="What's on your mind?"
                  autoFocus
                />

                <div className="flex items-center justify-end border-t border-line pt-4">
                  <button
                    type="submit"
                    disabled={isPosting || !editContent.trim() || editContent === editingPost.content}
                    className="btn-primary px-6 py-2.5 text-sm"
                  >
                    {isPosting ? 'Saving…' : 'Save changes'}
                  </button>
                </div>
              </form>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* History Modal */}
      <AnimatePresence>
        {showHistory && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowHistory(null)}
              style={{ zIndex: "var(--z-backdrop)" }} className="fixed inset-0 bg-black/85"
            />
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              style={{ zIndex: "var(--z-modal)" }} className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[calc(100%-2rem)] max-w-lg max-h-[90dvh] overflow-hidden glass rounded-3xl p-6"
            >
              <div className="flex items-center justify-between mb-5">
                <h2 className="flex items-center gap-2.5 text-lg font-bold text-fg">
                  <History size={20} className="text-accent" />
                  Edit history
                </h2>
                <button
                  onClick={() => setShowHistory(null)}
                  aria-label="Close"
                  className="tap rounded-full border border-line bg-surface-2 text-muted transition-colors duration-100 hover:text-fg"
                >
                  <X size={20} />
                </button>
              </div>

              <div className="max-h-[60vh] overflow-y-auto pr-2 scrollbar-hide">
                <div className="relative space-y-6 border-l border-line pl-6">
                  <div className="relative">
                    <div className="absolute -left-[30px] top-1 h-3 w-3 rounded-full bg-accent ring-4 ring-surface" />
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-accent">
                      Current version
                    </p>
                    <p className="rounded-2xl border border-line bg-surface-2 p-4 text-sm leading-relaxed text-fg">
                      {showHistory.content}
                    </p>
                  </div>

                  {showHistory.editHistory?.slice().reverse().map((entry, i) => (
                    <div key={i} className="relative">
                      <div className="absolute -left-[30px] top-1 h-3 w-3 rounded-full bg-line-strong ring-4 ring-surface" />
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
                        {formatTimeAgo(entry.editedAt)}
                      </p>
                      <p className="rounded-2xl border border-line bg-surface-2 p-4 text-sm leading-relaxed text-muted">
                        {entry.content}
                      </p>
                    </div>
                  ))}

                  <div className="relative">
                    <div className="absolute -left-[30px] top-1 h-3 w-3 rounded-full bg-line-strong ring-4 ring-surface" />
                    <p className="text-xs font-semibold uppercase tracking-wider text-subtle">
                      Created {formatTimeAgo(showHistory.createdAt)}
                    </p>
                  </div>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Confirmation Modal */}
      <AnimatePresence>
        {confirmDelete && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setConfirmDelete(null)}
              style={{ zIndex: "var(--z-backdrop)" }} className="fixed inset-0 bg-black/85"
            />
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              role="alertdialog"
              aria-labelledby="delete-post-title"
              style={{ zIndex: "var(--z-modal)" }} className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[calc(100%-2rem)] max-w-sm glass rounded-3xl p-6 text-center"
            >
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-danger/30 bg-danger/10 text-danger">
                <Trash2 size={26} />
              </div>
              <h2 id="delete-post-title" className="mb-2 text-lg font-bold text-fg">
                Delete this post?
              </h2>
              <p className="mb-6 text-sm leading-relaxed text-muted">
                This permanently removes the post and its comments. It can't be undone.
              </p>
              <div className="flex flex-col gap-2.5">
                <button
                  onClick={() => handleDeletePost(confirmDelete)}
                  className="w-full rounded-full bg-danger py-3 text-sm font-semibold text-black transition-transform duration-100 active:scale-[0.97]"
                >
                  Delete post
                </button>
                <button
                  onClick={() => setConfirmDelete(null)}
                  className="btn-secondary w-full py-3 text-sm"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {viewingImage && (
          <ImageViewer url={viewingImage} onClose={() => setViewingImage(null)} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {sharingPost && (
          <ShareModal 
            post={sharingPost} 
            currentUser={user} 
            onClose={() => setSharingPost(null)} 
          />
        )}
      </AnimatePresence>
    </div>
  );
}
