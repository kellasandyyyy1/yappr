import React, { useState, useEffect } from 'react';
import { X, Heart, MessageSquare, Share2 } from 'lucide-react';
import { Modal } from './Modal';
import { User, Post } from '../types';
import { posts as postsApi, likes as likesApi } from '../lib/db';
import { cn } from '../lib/utils';
import { VoiceMessage } from './VoiceMessage';
import { Avatar } from './Avatar';
import { Skeleton } from './Skeleton';

interface PostDetailModalProps {
  postId: string;
  currentUser: User;
  onClose: () => void;
  onCommentClick: (postId: string, userId: string) => void;
  onShareClick: (post: Post) => void;
}

export function PostDetailModal({ postId, currentUser, onClose, onCommentClick, onShareClick }: PostDetailModalProps) {
  const [post, setPost] = useState<Post | null>(null);
  const [postUser, setPostUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [userLikes, setUserLikes] = useState<Set<string>>(new Set());

  // TWO PRE-EXISTING BUGS DIE HERE, both structurally rather than by patching:
  //
  //  1. The like state was read from `likes/${uid}_${postId}`, but Feed,
  //     ProfileView and CommentsModal all *wrote* `${postId}_${uid}`. The
  //     document never existed, so the heart on this screen was always hollow
  //     no matter how many times you had liked the post. There is no composite
  //     document id to get backwards now — likes are a row keyed (post, user).
  //
  //  2. commentsCount counted a top-level `comments` collection that nothing
  //     wrote to (comments lived in the `posts/{id}/comments` subcollection),
  //     so it displayed 0 forever. It now reads the trigger-maintained column
  //     on the post itself.
  useEffect(() => {
    let cancelled = false;

    const fetchPost = async () => {
      try {
        const [found, liked] = await Promise.all([
          postsApi.get(postId),
          likesApi.byUser(currentUser.uid),
        ]);
        if (cancelled) return;
        if (found) {
          setPost(found);
          setPostUser(found.user ?? null);   // author arrives on the join
          if (liked.has(postId)) setUserLikes(new Set([postId]));
        }
      } catch (err) {
        console.error('Error fetching post detail:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchPost();
    const unsubscribe = postsApi.subscribeToPost(postId, setPost);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [postId, currentUser.uid]);

  const commentsCount = post?.commentsCount ?? 0;

  const formatTimeAgo = (timestamp?: any) => {
    if (!timestamp) return 'Just now';
    const date = timestamp?.toDate ? timestamp.toDate() : new Date(timestamp);
    const seconds = Math.floor((new Date().getTime() - date.getTime()) / 1000);
    if (seconds < 60) return 'Just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return date.toLocaleDateString();
  };

  const renderContent = (content: string) => {
    return content.split(/(@\w+)/g).map((part, i) => {
      if (part.startsWith('@')) {
        return <span key={i} className="text-accent font-bold">{part}</span>;
      }
      return part;
    });
  };

  return (
    // The card is the dialog. A separate close-button row used to sit above
    // it inside a full-height `inset-4` box, leaving a tall band of bare
    // backdrop at the top of the sheet.
    <Modal onClose={onClose} size="lg" variant="center">
      <>
        {loading ? (
          <div className="space-y-5 p-6">
            <div className="flex items-center gap-3">
              <Skeleton className="h-12 w-12 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-2.5 w-20" />
              </div>
            </div>
            <div className="space-y-2.5">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-[80%]" />
            </div>
            <Skeleton className="h-12 w-full rounded-2xl" />
          </div>
        ) : post ? (
          <>
            {/* Header row doubles as the close affordance — no dead band. */}
            <div className="flex items-center gap-3 border-b border-line p-4 sm:px-6">
              <Avatar user={postUser} src={post.userPhotoURL} name={post.username} size="lg" showStatus statusUser={postUser} />
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-[15px] font-semibold text-fg">@{post.username}</h3>
                <p className="text-sm text-muted">{formatTimeAgo(post.createdAt)}</p>
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="tap shrink-0 rounded-full text-muted transition-colors duration-100 hover:text-fg"
              >
                <X size={20} />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 scrollbar-hide sm:p-6">
              {post.type === 'voice' && post.voiceUrl ? (
                <VoiceMessage url={post.voiceUrl} />
              ) : (
                <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-fg">
                  {renderContent(post.content)}
                </p>
              )}

              {post.imageUrls && post.imageUrls.map((url, i) => url && (
                <div key={i} className="overflow-hidden rounded-2xl border border-line">
                  <img src={url} alt="" loading="lazy" decoding="async" className="w-full object-cover" />
                </div>
              ))}
            </div>

            <div className="flex items-center gap-2 border-t border-line p-4 sm:px-6">
              <div
                className={cn(
                  "flex h-12 flex-1 items-center justify-center gap-2 rounded-xl border",
                  userLikes.has(post.id)
                    ? "border-danger/30 bg-danger/10 text-danger"
                    : "border-line bg-surface-2 text-muted"
                )}
              >
                <Heart size={19} fill={userLikes.has(post.id) ? "currentColor" : "none"} />
                <span className="text-sm font-semibold">{post.likesCount || 0}</span>
              </div>

              <button
                onClick={() => onCommentClick(post.id, post.userId)}
                className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl border border-accent/30 bg-accent/10 text-accent transition-colors duration-100 hover:bg-accent/20"
              >
                <MessageSquare size={19} />
                <span className="text-sm font-semibold">{commentsCount}</span>
              </button>

              <button
                onClick={() => onShareClick(post)}
                aria-label="Share post"
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-line bg-surface-2 text-muted transition-colors duration-100 hover:text-accent"
              >
                <Share2 size={19} />
              </button>
            </div>
          </>
        ) : (
          <div className="p-12 text-center">
            <p className="text-base font-semibold text-fg">Post not found</p>
            <p className="mt-1 text-sm text-muted">It may have been deleted.</p>
            <button onClick={onClose} className="btn-secondary mt-5 px-6 py-2.5 text-sm">
              Close
            </button>
          </div>
        )}
      </>
    </Modal>
  );
}
