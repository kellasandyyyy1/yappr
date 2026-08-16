import React, { useState, useEffect } from 'react';
import { posts as postsApi } from '../lib/db';
import { Post } from '../types';
import { MessageSquare, Heart, Volume2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { Avatar } from './Avatar';

interface SharedPostPreviewProps {
  postId: string;
  isMe: boolean;
  onClick: () => void;
}

export function SharedPostPreview({ postId, isMe, onClick }: SharedPostPreviewProps) {
  const [post, setPost] = useState<Post | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchPost = async () => {
      try {
        // Returns null both when the post is gone and when RLS will not show it
        // to this viewer — a private post forwarded into a chat now renders the
        // unavailable state instead of leaking its contents.
        setPost(await postsApi.get(postId));
      } catch (err) {
        console.error('Error fetching shared post preview:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchPost();
  }, [postId]);

  if (loading) {
    return (
      <div className={cn(
        "mt-2 h-20 w-full max-w-full animate-pulse rounded-xl",
        isMe ? "bg-black/25" : "bg-surface-3"
      )} />
    );
  }

  if (!post) {
    return (
      <div className={cn(
        "mt-2 w-full max-w-full rounded-xl p-3 text-sm italic",
        isMe ? "bg-black/25 text-white/70" : "bg-surface-3 text-muted"
      )}>
        This post is no longer available
      </div>
    );
  }

  return (
    // `min-w-0` + `max-w-full` + anywhere-wrapping keep the embed inside the
    // bubble's 85% column; without them a long quoted post pushed the whole
    // message past the right edge of the viewport.
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "mt-2 flex w-full min-w-0 max-w-full flex-col gap-2 rounded-xl border border-line p-3 text-left transition-colors duration-100 active:scale-[0.99]",
        isMe ? "bg-black/25 hover:bg-black/35" : "bg-surface-3 hover:bg-surface-2"
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {/* The author comes from the join now, not from denormalised
            userPhotoURL / username columns that went stale on a rename. */}
        <Avatar user={post.user} size="xs" />
        <span className={cn("truncate text-xs font-semibold", isMe ? "text-white/80" : "text-muted")}>
          @{post.user?.username ?? 'unknown'}
        </span>
      </div>

      {post.type === 'voice' ? (
        <span className={cn("flex items-center gap-1.5 text-sm font-medium", isMe ? "text-white/90" : "text-accent")}>
          <Volume2 size={14} />
          Voice post
        </span>
      ) : (
        post.content && (
          <p
            className={cn(
              "line-clamp-3 min-w-0 text-sm leading-relaxed [overflow-wrap:anywhere]",
              isMe ? "text-white/90" : "text-fg"
            )}
          >
            {post.content}
          </p>
        )
      )}

      {post.imageUrls && post.imageUrls.length > 0 && post.imageUrls[0] && (
        <div className="h-24 w-full overflow-hidden rounded-lg border border-line">
          <img src={post.imageUrls[0]} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" />
        </div>
      )}

      <div className={cn("flex items-center gap-3 border-t pt-2 text-xs", isMe ? "border-white/20 text-white/70" : "border-line text-muted")}>
        <span className="flex items-center gap-1">
          <Heart size={12} />
          {post.likesCount || 0}
        </span>
        <span className="flex items-center gap-1">
          <MessageSquare size={12} />
          View post
        </span>
      </div>
    </button>
  );
}
