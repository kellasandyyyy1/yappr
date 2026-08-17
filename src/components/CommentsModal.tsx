import React, { useState, useEffect, useRef } from 'react';
import {
  posts as postsApi,
  comments as commentsApi,
  likes as likesApi,
  reactions as reactionsApi,
  follows as followsApi,
  users as usersApi,
  notifications as notificationsApi,
} from '../lib/db';
import { uploadFile, UploadError } from '../lib/supabase';
import { User, Comment, Post } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import { X, Send, MessageSquare, Mic, Image as ImageIcon, Loader2, Play, Pause, Square, Volume2, Trash2, AtSign, Heart, Grid, CornerDownRight } from 'lucide-react';
import { cn, formatTimeAgo } from '../lib/utils';
import { ImageViewer } from './ImageViewer';
import { VoiceMessage } from './VoiceMessage';
import { Avatar } from './Avatar';
import { RowSkeleton } from './Skeleton';
import { Modal, ModalHeader, ConfirmDialog } from './Modal';
import { useToast } from './ToastContext';
import { sendPushNotification } from '../lib/sendPush';

/** A comment "like" is a heart reaction. comment_reactions holds one row per
 *  (comment, user), so liking is the same write path as any other reaction —
 *  no second table, and the two can never disagree. */
const LIKE_EMOJI = '❤️';

interface CommentsModalProps {
  postId: string;
  postUserId: string;
  user: User;
  onClose: () => void;
  onUserClick?: (uid: string) => void;
}

export function CommentsModal({ postId, postUserId, user, onClose, onUserClick }: CommentsModalProps) {
  const [post, setPost] = useState<Post | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [userLikes, setUserLikes] = useState<Set<string>>(new Set());
  const [tick, setTick] = useState(0);

  // Periodic tick to refresh "X mins ago" labels
  useEffect(() => {
    const interval = setInterval(() => {
      setTick(t => t + 1);
    }, 30000); 
    return () => clearInterval(interval);
  }, []);

  const [newComment, setNewComment] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  // Distinguishes "the fetch failed" from "there are no comments".
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSendingImage, setIsSendingImage] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [pendingAttachment, setPendingAttachment] = useState<{ type: 'image' | 'voice'; url: string; blob?: Blob } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [viewingImage, setViewingImage] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<Comment | null>(null);
  const [mentionableUsers, setMentionableUsers] = useState<User[]>([]);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionSearch, setMentionSearch] = useState('');
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  // The post row carries likes_count and comments_count as trigger-maintained
  // columns, so one subscription replaces the two that streamed every like and
  // comment document purely to measure the result size.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const [fresh, liked] = await Promise.all([
        postsApi.get(postId),
        likesApi.byUser(user.uid),
      ]);
      if (cancelled) return;
      if (fresh) setPost(fresh);
      setUserLikes(liked);
    })();

    const unsubPost = postsApi.subscribeToPost(postId, setPost);

    return () => {
      cancelled = true;
      unsubPost();
    };
  }, [postId, user.uid]);

  const realTimeLikesCount = post?.likesCount ?? 0;

  // The loaded thread is the truth once it arrives; until then the post's
  // trigger-maintained count stands in, so the header never flashes "(0)" on a
  // thread that has comments. Null while both are unknown — the header then
  // shows no count rather than a wrong one.
  const commentCount = loading
    ? (post?.commentsCount ?? null)
    : loadError
      ? (post?.commentsCount ?? null)
      : comments.length;

  // Comments, with authors and reactions joined. Firestore issued a getDoc per
  // distinct commenter on every snapshot.
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const list = await commentsApi.list(postId);
        if (cancelled) return;
        setComments(list);
        setLoadError(null);
      } catch (error) {
        // A failed fetch is NOT an empty thread, and conflating them is what
        // made a broken query look like missing data: the post card showed a
        // comment count while the modal confidently reported none. Record the
        // failure so the empty state is only ever shown for a thread that is
        // genuinely empty.
        console.error('Error loading comments:', error);
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    const unsub = commentsApi.subscribe(postId, load);

    return () => {
      cancelled = true;
      unsub();
    };
  }, [postId]);

  useEffect(() => {
    const fetchMentionableUsers = async () => {
      try {
        setMentionableUsers(await followsApi.mentionable(user.uid));
      } catch (err) {
        console.error('Error fetching mentionable users:', err);
      }
    };
    fetchMentionableUsers();
  }, [user.uid]);

  const filteredMentionUsers = mentionableUsers.filter(f => 
    f.username.toLowerCase().includes(mentionSearch) || 
    f.displayName.toLowerCase().includes(mentionSearch)
  ).slice(0, 8);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setNewComment(val);

    const cursorPosition = e.target.selectionStart || 0;
    const textBeforeCursor = val.slice(0, cursorPosition);
    const words = textBeforeCursor.split(/\s/);
    const lastWord = words[words.length - 1];

    if (lastWord.startsWith('@')) {
      const search = lastWord.slice(1).toLowerCase();
      setMentionSearch(search);
      setShowMentions(true);
      setActiveMentionIndex(0);
    } else {
      setShowMentions(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (showMentions && filteredMentionUsers.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveMentionIndex(prev => (prev + 1) % filteredMentionUsers.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveMentionIndex(prev => (prev - 1 + filteredMentionUsers.length) % filteredMentionUsers.length);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(filteredMentionUsers[activeMentionIndex]);
      } else if (e.key === 'Escape') {
        setShowMentions(false);
      }
    }
  };

  const insertMention = (targetUser: User) => {
    const cursorPosition = inputRef.current?.selectionStart || 0;
    const textBeforeCursor = newComment.slice(0, cursorPosition);
    const textAfterCursor = newComment.slice(cursorPosition);
    
    const words = textBeforeCursor.split(/\s/);
    words[words.length - 1] = `@${targetUser.username} `;
    
    const nextComment = words.join(' ') + textAfterCursor;
    setNewComment(nextComment);
    setShowMentions(false);
    
    if (inputRef.current) {
      inputRef.current.focus();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newComment.trim() || isSubmitting) return;

    const body = newComment.trim();
    setIsSubmitting(true);
    try {
      // `comments_count_sync` maintains posts.comments_count, and add() raises
      // the author notification — neither is the component's job any more.
      await commentsApi.add({
        postId,
        userId: user.uid,
        content: body,
        type: 'text',
        replyToId: replyingTo?.id ?? null,
        postAuthorId: postUserId,
      });

      if (user.uid !== postUserId) {
        sendPushNotification(
          postUserId,
          'New Comment',
          `${user.displayName} commented on your post`,
          `/post/${postId}`
        );
      }

      await notifyMentions(body);

      setNewComment('');
      setReplyingTo(null);
      toast('Comment posted', 'success');
    } catch (err) {
      toast('Failed to post comment', 'error');
      console.error('Error posting comment:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  /** One query for every @name in the text, instead of one query per name. */
  const notifyMentions = async (text: string) => {
    const matches = text.match(/@([\w-]+)/g);
    if (!matches) return;

    const mentioned = await usersApi.byUsernames(matches.map(m => m.slice(1)));
    await Promise.all(
      mentioned
        .filter(target => target.uid !== user.uid)
        .map(async (target) => {
          await notificationsApi.create({
            recipientId: target.uid,
            actorId: user.uid,
            type: 'mention',
            postId,
          });
          sendPushNotification(
            target.uid,
            'You were mentioned',
            `${user.displayName} mentioned you in a comment`,
            `/post/${postId}`
          );
        })
    );
  };

  const handleDeleteComment = async (commentId: string) => {
    try {
      setDeletingId(commentId);
      await commentsApi.remove(commentId);
      toast('Comment removed', 'info');
    } catch (err) {
      toast('Failed to remove comment', 'error');
      console.error('Error removing comment:', err);
    } finally {
      setDeletingId(null);
    }
  };

  const handleReactComment = async (commentId: string, emoji: string) => {
    try {
      const comment = comments.find(c => c.id === commentId);
      if (!comment) return;

      // One row per (comment, user) — the old read-modify-write of a whole
      // reactions map dropped concurrent reactions from other users.
      const wasAlreadyThere = (comment.reactions?.[emoji] || []).includes(user.uid);
      const next = wasAlreadyThere ? null : emoji;

      // `comment_reactions` carries no post_id, so Realtime cannot filter it to
      // this post — applied locally instead of streamed. Other people's
      // reactions land on the next list refresh.
      setComments(prev => prev.map(c => {
        if (c.id !== commentId) return c;
        const map: Record<string, string[]> = {};
        const entries = Object.entries((c.reactions || {}) as Record<string, string[]>);
        for (const [key, uids] of entries) {
          const kept = uids.filter(id => id !== user.uid);
          if (kept.length) map[key] = kept;
        }
        if (next) map[next] = [...(map[next] || []), user.uid];
        return { ...c, reactions: map };
      }));

      await reactionsApi.setOnComment(commentId, user.uid, next);

      if (user.uid !== comment.userId && !wasAlreadyThere) {
        await notificationsApi.create({
          recipientId: comment.userId,
          actorId: user.uid,
          type: 'reaction',
          postId,
          content: emoji,
        });

        sendPushNotification(
          comment.userId,
          'New Reaction',
          `${user.displayName} reacted ${emoji} to your comment`,
          `/post/${postId}`
        );
      }
    } catch (err) {
      console.error('Error reacting to comment:', err);
    }
  };

  /** The heart button. Delegates to the reaction path so a like and an emoji
   *  reaction stay mutually exclusive, matching what the table enforces. */
  const handleToggleLike = (commentId: string) => handleReactComment(commentId, LIKE_EMOJI);

  const confirmAndSendAttachment = async () => {
    if (!pendingAttachment) return;
    setIsSubmitting(true);

    try {
      const type = pendingAttachment.type;

      // Uploaded to Storage rather than written inline. The preview URL is a
      // base64 data URL; a long voice note as one of those blew past
      // Firestore's 1MB document ceiling and failed the write outright.
      const blob = pendingAttachment.blob ?? await (await fetch(pendingAttachment.url)).blob();
      const extension = type === 'image' ? (blob.type.split('/')[1] || 'jpg') : 'webm';
      const objectPath = `comments/${postId}/${user.uid}-${Date.now()}.${extension}`;
      const url = await uploadFile('posts', objectPath, blob, blob.type);

      await commentsApi.add({
        postId,
        userId: user.uid,
        content: type === 'image' ? 'Sent an image' : 'Voice Message',
        type,
        imageUrl: type === 'image' ? url : null,
        voiceUrl: type === 'voice' ? url : null,
        replyToId: replyingTo?.id ?? null,
        postAuthorId: postUserId,
        notifyContent: type === 'image' ? 'Shared an image' : 'Sent a voice note',
      });

      if (user.uid !== postUserId) {
        sendPushNotification(
          postUserId,
          'New Comment',
          `${user.displayName} sent a ${type} comment on your post`,
          `/post/${postId}`
        );
      }
      setPendingAttachment(null);
      setReplyingTo(null);
      toast('Attachment shared', 'success');
    } catch (err) {
      toast(err instanceof UploadError ? err.message : 'Failed to share attachment', 'error');
      console.error('Error sharing attachment:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || isSubmitting) return;

    setIsSendingImage(true);
    try {
      const reader = new FileReader();
      reader.onloadend = () => {
        setPendingAttachment({
          type: 'image',
          url: reader.result as string
        });
      };
      reader.readAsDataURL(file);
    } catch (err) {
      console.error('Error reading image:', err);
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onloadend = () => {
          setPendingAttachment({
            type: 'voice',
            url: reader.result as string,
            blob: audioBlob
          });
        };
        reader.readAsDataURL(audioBlob);
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
      setRecordingTime(0);
      timerRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
    } catch (err: any) {
      console.error('Mic error:', err);
      let errorMessage = 'Could not access microphone. Ensure no other app is using it.';
      
      const isPermissionError = err.name === 'NotAllowedError' || 
                               err.name === 'PermissionDeniedError' || 
                               err.message?.toLowerCase().includes('permission') ||
                               err.message?.toLowerCase().includes('dismissed');

      if (isPermissionError) {
        errorMessage = 'Microphone access denied or dismissed. Please allow access in your browser settings or try opening the app in a new tab.';
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        errorMessage = 'No microphone found on this device.';
      }
      
      toast(errorMessage, 'error');
      setIsRecording(false);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (timerRef.current) clearInterval(timerRef.current);
    }
  };

  const cancelRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.onstop = () => {
        if (timerRef.current) clearInterval(timerRef.current);
        audioChunksRef.current = [];
      };
      setIsRecording(false);
    }
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleMentionClick = async (username: string) => {
    try {
      const [target] = await usersApi.byUsernames([username]);
      if (target) onUserClick?.(target.uid);
    } catch (err) {
      console.error('Error fetching mentioned user:', err);
    }
  };

  const handleLikePost = async (targetPostId: string, pUserId: string) => {
    const isLiked = userLikes.has(targetPostId);

    // Optimistic — the button used to sit unresponsive until two sequential
    // writes came back. `bump_post_likes_count` owns likes_count now, so the
    // subscription corrects the number a moment later either way.
    setUserLikes(prev => {
      const next = new Set(prev);
      if (isLiked) next.delete(targetPostId); else next.add(targetPostId);
      return next;
    });
    setPost(prev => prev && {
      ...prev,
      likesCount: Math.max(0, (prev.likesCount ?? 0) + (isLiked ? -1 : 1)),
    });

    try {
      if (isLiked) {
        await likesApi.unlike(targetPostId, user.uid);
      } else {
        await likesApi.like(targetPostId, user.uid, pUserId);
        if (user.uid !== pUserId) {
          sendPushNotification(
            pUserId,
            'New Like',
            `${user.displayName} liked your post`,
            `/post/${targetPostId}`
          );
        }
      }
    } catch (err) {
      console.error('Error toggling like:', err);
      setUserLikes(prev => {
        const next = new Set(prev);
        if (isLiked) next.add(targetPostId); else next.delete(targetPostId);
        return next;
      });
      setPost(prev => prev && {
        ...prev,
        likesCount: Math.max(0, (prev.likesCount ?? 0) + (isLiked ? 1 : -1)),
      });
    }
  };

  const renderContent = (content: string) => {
    const parts = content.split(/(@[\w-]+)/g);
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

  return (
    <Modal onClose={onClose} size="lg" labelledBy="comments-title" className="sm:h-[80vh]">
      <>
        {/* The count matches the one on the post card, so opening the modal
            confirms what the card promised instead of leaving the reader to
            count rows. Driven by the loaded thread once it arrives, falling
            back to the post's stored count while it loads. */}
        <ModalHeader
          title={`Comments${commentCount === null ? '' : ` (${commentCount})`}`}
          onClose={onClose}
          id="comments-title"
        />

        {/* Was p-8 with space-y-8: 32px of padding and 32px between comments
            meant a single comment sat in the middle of a mostly empty modal.
            Comments are now densely stacked, like the chat transcript. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-5">
          {loading ? (
            <div className="space-y-3">
              <RowSkeleton />
              <RowSkeleton />
              <RowSkeleton />
            </div>
          ) : (
            <>
              {loadError ? (
                /* Checked before the empty state. A failed fetch used to fall
                   through to "No comments yet" — a confident claim about data
                   that never arrived, and the reason a broken query read as
                   missing content. */
                <div className="mx-auto max-w-sm rounded-xl border border-danger/30 bg-danger/10 px-4 py-4 text-center">
                  <p className="text-sm font-semibold text-danger">Couldn't load comments</p>
                  <p className="mt-1.5 text-xs leading-relaxed text-danger/90">{loadError}</p>
                </div>
              ) : comments.length === 0 ? (
                <div className="py-10 text-center">
                  <p className="text-sm text-muted">No comments yet.</p>
                  <p className="mt-1 text-xs text-subtle">Be the first to say something.</p>
                </div>
              ) : (
                <ul className="divide-y divide-line/60">
                  {comments.map((comment) => {
                    const hearts = comment.reactions?.[LIKE_EMOJI] ?? [];
                    const likedByMe = hearts.includes(user.uid);
                    // Reactions other than the heart still exist on older
                    // comments; they stay visible and removable rather than
                    // being orphaned by the switch to a like button.
                    const otherReactions = Object.entries(
                      (comment.reactions ?? {}) as Record<string, string[]>
                    ).filter(([emoji, uids]) => emoji !== LIKE_EMOJI && uids.length > 0);

                    return (
                      <li key={comment.id} className="group/comment flex gap-2.5 py-2.5 first:pt-0.5">
                        <button
                          onClick={() => onUserClick?.(comment.userId)}
                          aria-label={`View ${comment.user?.displayName ?? 'user'}'s profile`}
                          className="press mt-0.5 shrink-0"
                        >
                          <Avatar user={comment.user} size="sm" />
                        </button>

                        <div className="min-w-0 flex-1">
                          {/* Byline, then the comment body as plain text.
                              The body used to sit in a bordered, rounded,
                              filled box — the same shape as the composer
                              directly below it — so a posted comment looked
                              like a text field waiting to be typed in. Read
                              only content gets no chrome at all now; the
                              avatar and byline are what mark where one
                              comment ends and the next begins. */}
                          <div className="flex items-baseline gap-2">
                            <button
                              onClick={() => onUserClick?.(comment.userId)}
                              className="truncate text-[13px] font-semibold text-fg transition-colors hover:text-accent"
                            >
                              {comment.user?.displayName || 'Anonymous'}
                            </button>
                            <span className="whitespace-nowrap text-[11px] text-subtle">
                              {formatTimeAgo(comment.createdAt)}
                            </span>
                            {comment.userId === user.uid && (
                              <button
                                onClick={() => setConfirmDeleteId(comment.id)}
                                disabled={deletingId === comment.id}
                                aria-label="Delete comment"
                                title="Delete comment"
                                className="ml-auto shrink-0 p-1 text-subtle opacity-0 transition-opacity hover:text-danger focus-visible:opacity-100 group-hover/comment:opacity-100 disabled:opacity-50"
                              >
                                {deletingId === comment.id ? (
                                  <Loader2 size={12} className="animate-spin" />
                                ) : (
                                  <Trash2 size={12} />
                                )}
                              </button>
                            )}
                          </div>

                          {comment.replyToId && (
                            <p className="mt-0.5 flex items-center gap-1 text-[11px] text-subtle">
                              <CornerDownRight size={10} className="shrink-0" />
                              <span className="shrink-0">{comment.replyToSenderName}</span>
                              <span className="truncate italic opacity-70">{comment.replyToContent}</span>
                            </p>
                          )}

                          {comment.type === 'image' ? (
                            <div className="mt-1 cursor-zoom-in space-y-1.5" onClick={() => setViewingImage(comment.imageUrl!)}>
                              <img
                                src={comment.imageUrl}
                                alt="Comment attachment"
                                className="w-full max-w-[220px] rounded-lg border border-line object-cover"
                                loading="lazy" decoding="async" />
                              {comment.content !== 'Sent an image' && (
                                <p className="text-[13px] leading-snug text-fg break-words">{renderContent(comment.content)}</p>
                              )}
                            </div>
                          ) : comment.type === 'voice' ? (
                            <div className="mt-1 max-w-[260px]">
                              <VoiceMessage url={comment.voiceUrl || ''} />
                            </div>
                          ) : (
                            <p className="mt-0.5 text-[13px] leading-snug text-fg break-words">
                              {renderContent(comment.content)}
                            </p>
                          )}

                          {/* One compact action row — "♥ 2 · Reply" — echoing
                              the post card's own action row. Previously the
                              only affordance here was a bare smiley from the
                              emoji picker, which read as decoration rather
                              than as "like this". */}
                          <div className="mt-1 flex items-center gap-2 text-[11px]">
                            <button
                              onClick={() => handleToggleLike(comment.id)}
                              aria-pressed={likedByMe}
                              aria-label={likedByMe ? 'Remove like' : 'Like comment'}
                              className={cn(
                                "flex items-center gap-1 rounded-full py-0.5 font-medium transition-colors",
                                likedByMe ? "text-danger" : "text-subtle hover:text-fg"
                              )}
                            >
                              <Heart size={13} className={cn(likedByMe && "fill-current")} />
                              {hearts.length > 0 && <span className="tabular-nums">{hearts.length}</span>}
                            </button>

                            <span aria-hidden="true" className="text-subtle/50">·</span>

                            <button
                              onClick={() => setReplyingTo(comment)}
                              className="font-medium text-subtle transition-colors hover:text-fg"
                            >
                              Reply
                            </button>

                            {otherReactions.length > 0 && (
                              <span className="ml-1 flex items-center gap-1">
                                {otherReactions.map(([emoji, uids]) => (
                                  <button
                                    key={emoji}
                                    onClick={() => handleReactComment(comment.id, emoji)}
                                    aria-pressed={uids.includes(user.uid)}
                                    className={cn(
                                      "flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 transition-colors",
                                      uids.includes(user.uid)
                                        ? "border-accent/40 bg-accent/10 text-fg"
                                        : "border-line text-muted hover:text-fg"
                                    )}
                                  >
                                    <span>{emoji}</span>
                                    <span className="tabular-nums">{uids.length}</span>
                                  </button>
                                ))}
                              </span>
                            )}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </div>

        <div className="shrink-0 border-t border-line bg-black/20 px-4 py-3 sm:px-5">
          {/* Was a full-width card repeating the target's name and the whole
              text of the comment being replied to — a duplicate of the thread
              already on screen a few pixels above. A chip is enough: it names
              the target, and dismisses. */}
          <AnimatePresence>
            {replyingTo && (
              <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 4 }}
                className="mb-2 flex w-fit max-w-full items-center gap-1.5 rounded-full border border-accent/25 bg-accent/10 py-1 pl-2.5 pr-1 text-[11px]"
              >
                <CornerDownRight size={11} className="shrink-0 text-accent" />
                <span className="truncate text-muted">
                  Replying to <span className="font-medium text-fg">{replyingTo.user?.displayName}</span>
                </span>
                <button
                  onClick={() => setReplyingTo(null)}
                  aria-label="Cancel reply"
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-subtle transition-colors hover:text-fg"
                >
                  <X size={12} />
                </button>
              </motion.div>
            )}
          </AnimatePresence>
          {/* No margin of its own — each child below carries its own spacing,
              so this contributes nothing to the composer's height when there is
              no attachment and no recording in progress. */}
          <div>
            {pendingAttachment && (
              <motion.div 
                initial={{ opacity: 0, scale: 0.95, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                className="bg-accent/10 border border-accent/20 p-3 rounded-2xl mb-2 space-y-3"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-black tracking-widest text-accent uppercase">Confirm {pendingAttachment.type}</span>
                  <button onClick={() => setPendingAttachment(null)} className="text-muted hover:text-fg">
                    <X size={16} />
                  </button>
                </div>
                
                <div className="bg-black/20 rounded-2xl overflow-hidden min-h-[100px] flex items-center justify-center p-4">
                  {pendingAttachment.type === 'image' ? (
                    <img src={pendingAttachment.url} alt="To send" className="max-h-40 rounded-xl" loading="lazy" decoding="async" />
                  ) : (
                    <VoiceMessage url={pendingAttachment.url} />
                  )}
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={() => setPendingAttachment(null)}
                    className="flex-1 px-4 py-3 bg-surface-2 text-xs font-black tracking-widest text-muted rounded-2xl hover:bg-surface-3 transition-colors uppercase"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmAndSendAttachment}
                    disabled={isSubmitting}
                    className="flex-1 px-4 py-3 bg-accent text-xs font-black tracking-widest text-white rounded-2xl shadow-lg active:scale-95 transition-colors uppercase flex items-center justify-center gap-2"
                  >
                    {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                    Send Now
                  </button>
                </div>
              </motion.div>
            )}

            {isSendingImage && (
              <div className="mb-2 flex w-fit animate-pulse items-center gap-2 rounded-full bg-accent/10 px-3 py-1.5">
                <Loader2 className="w-3 h-3 text-accent animate-spin" />
                <span className="text-xs font-black uppercase tracking-widest text-accent">Sending Image...</span>
              </div>
            )}
            
            <AnimatePresence>
              {isRecording && (
                <motion.div 
                  initial={{ opacity: 0, scale: 0.9, y: 10 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.9, y: 10 }}
                  className="mb-2 flex items-center justify-between rounded-2xl border border-danger/20 bg-danger/10 p-3"
                >
                  <div className="flex items-center gap-4">
                    <div className="w-3 h-3 rounded-full bg-danger animate-pulse" />
                    <span className="text-sm font-black tracking-widest text-danger">{formatDuration(recordingTime)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button 
                      onClick={cancelRecording}
                      className="w-10 h-10 rounded-full bg-surface-2 flex items-center justify-center text-muted hover:text-danger hover:bg-danger/10 transition-colors"
                    >
                      <Trash2 size={18} />
                    </button>
                    <button 
                      onClick={stopRecording}
                      className="w-10 h-10 rounded-full bg-danger flex items-center justify-center text-white shadow-lg active:scale-95"
                    >
                      <Square size={16} fill="currentColor" />
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <form onSubmit={handleSubmit} className="relative flex items-center gap-2">
            <AnimatePresence>
              {showMentions && filteredMentionUsers.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 10, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 10, scale: 0.95 }}
                  className="absolute bottom-full left-0 right-0 z-[100] mb-2 glass border border-line rounded-2xl shadow-2xl overflow-hidden max-h-[300px] overflow-y-auto p-2 flex flex-col gap-1"
                >
                  <div className="px-4 py-2 flex items-center justify-between border-b border-line mb-1">
                    <div className="flex items-center gap-2">
                       <AtSign size={12} className="text-accent" />
                       <span className="text-sm font-medium text-muted">Mention someone</span>
                    </div>
                    {mentionSearch && (
                      <span className="text-xs font-bold text-subtle">"{mentionSearch}"</span>
                    )}
                  </div>
                  {filteredMentionUsers.map((f, i) => (
                    <button
                      key={f.uid}
                      type="button"
                      onClick={() => insertMention(f)}
                      onMouseEnter={() => setActiveMentionIndex(i)}
                      className={cn(
                        "w-full p-2 rounded-2xl flex items-center gap-3 transition-colors text-left group/mention",
                        activeMentionIndex === i ? "bg-accent text-white" : "hover:bg-surface-2"
                      )}
                    >
                      <Avatar user={f} size="md" />
                      <div className="min-w-0">
                        <div className={cn(
                          "text-sm font-bold truncate",
                          activeMentionIndex === i ? "text-white" : "text-fg"
                        )}>{f.displayName}</div>
                        <div className={cn(
                          "text-xs font-medium",
                          activeMentionIndex === i ? "text-fg" : "text-accent"
                        )}>@{f.username}</div>
                      </div>
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
            <div className="relative flex-1 group">
              <input
                ref={inputRef}
                value={newComment}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder={isRecording ? "Recording..." : "Add a comment..."}
                disabled={isRecording || isSendingImage}
                className="h-11 w-full rounded-full border border-line bg-surface-2 pl-4 pr-12 text-sm transition-colors placeholder:text-subtle focus:border-accent/50 focus:bg-surface-3 focus:outline-none disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={!newComment.trim() || isSubmitting || isRecording}
                className="absolute right-1 top-1 flex h-9 w-9 items-center justify-center rounded-full bg-accent text-white transition-colors active:scale-90 disabled:opacity-20"
              >
                <Send size={16} className={cn(newComment.trim() && !isSubmitting ? "translate-x-0.5 -translate-y-0.5" : "")} />
              </button>
            </div>
            
            <div className="flex items-center gap-2">
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleImageUpload} 
                className="hidden" 
                accept="image/*"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isRecording || isSendingImage || isSubmitting}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line bg-surface-2 text-muted transition-colors hover:border-line-strong hover:text-fg active:scale-90 disabled:opacity-20"
              >
                <ImageIcon size={18} />
              </button>
              
              <button
                type="button"
                onMouseDown={startRecording}
                onMouseUp={stopRecording}
                onMouseLeave={cancelRecording}
                disabled={isSendingImage || isSubmitting}
                className={cn(
                  "flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors active:scale-75 disabled:opacity-20",
                  isRecording ? "scale-110 bg-danger text-white" : "border border-line bg-surface-2 text-muted hover:border-line-strong hover:text-fg"
                )}
              >
                <Mic size={18} />
              </button>
            </div>
          </form>
        </div>
      </>

      <AnimatePresence>
        {confirmDeleteId && (
          <ConfirmDialog
            title="Delete this comment?"
            description="It will be removed for everyone."
            confirmLabel="Delete comment"
            destructive
            icon={<Trash2 size={26} />}
            onConfirm={() => {
              handleDeleteComment(confirmDeleteId);
              setConfirmDeleteId(null);
            }}
            onCancel={() => setConfirmDeleteId(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {viewingImage && (
          <ImageViewer url={viewingImage} onClose={() => setViewingImage(null)} />
        )}
      </AnimatePresence>
    </Modal>
  );
}
