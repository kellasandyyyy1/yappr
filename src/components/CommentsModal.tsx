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
import { X, Send, MessageSquare, Mic, Image as ImageIcon, Loader2, Play, Pause, Square, Volume2, Trash2, AtSign, Heart, Grid } from 'lucide-react';
import { cn, formatTimeAgo } from '../lib/utils';
import { ImageViewer } from './ImageViewer';
import { VoiceMessage } from './VoiceMessage';
import { EmojiReactions } from './EmojiReactions';
import { Avatar } from './Avatar';
import { RowSkeleton } from './Skeleton';
import { Modal, ModalHeader, ConfirmDialog } from './Modal';
import { useToast } from './ToastContext';
import { sendPushNotification } from '../lib/sendPush';

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
        <ModalHeader title="Comments" onClose={onClose} id="comments-title" />

        <div className="min-h-0 flex-1 overflow-y-auto p-8 space-y-8 scrollbar-hide">
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
                <div className="py-12 text-center">
                  <p className="text-subtle font-bold uppercase tracking-widest text-xs">No comments yet.</p>
                </div>
              ) : (
                comments.map((comment) => (
              <div
                key={comment.id}
                className="flex gap-4"
              >
                <button
                  onClick={() => onUserClick?.(comment.userId)}
                  aria-label={`View ${comment.user?.displayName ?? 'user'}'s profile`}
                  className="press shrink-0"
                >
                  <Avatar user={comment.user} size="md" />
                </button>
                <div className="space-y-2 flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0">
                      <button 
                        onClick={() => onUserClick?.(comment.userId)}
                        className="text-xs font-black uppercase tracking-widest hover:text-accent transition-colors truncate max-w-[120px]"
                      >
                        {comment.user?.displayName || 'Anonymous'}
                      </button>
                      <span className="text-xs text-muted uppercase font-bold whitespace-nowrap">{formatTimeAgo(comment.createdAt)}</span>
                    </div>
                    {comment.userId === user.uid && (
                      <button 
                        onClick={() => setConfirmDeleteId(comment.id)}
                        disabled={deletingId === comment.id}
                        className="p-1.5 text-subtle hover:text-danger transition-colors disabled:opacity-50 shrink-0"
                      >
                        {deletingId === comment.id ? (
                          <Loader2 size={10} className="animate-spin" />
                        ) : (
                          <Trash2 size={10} />
                        )}
                      </button>
                    )}
                  </div>
                  
                  <div className="bg-surface-2 border border-line rounded-2xl p-4">
                    {comment.replyToId && (
                      <div className="mb-3 p-2 bg-surface-2 border-l-2 border-accent rounded-lg text-xs space-y-1">
                        <span className="font-black uppercase tracking-widest text-accent">Replying to {comment.replyToSenderName}</span>
                        <p className="truncate italic text-muted">{comment.replyToContent}</p>
                      </div>
                    )}
                    {comment.type === 'image' ? (
                      <div className="space-y-2 cursor-zoom-in" onClick={() => setViewingImage(comment.imageUrl!)}>
                        <img 
                          src={comment.imageUrl} 
                          alt="Comment attachment" 
                          className="rounded-xl w-full max-w-sm object-cover shadow-lg border border-line hover:scale-[1.02] transition-transform duration-150" loading="lazy" decoding="async" />
                        {comment.content !== 'Sent an image' && <p className="text-sm text-fg leading-relaxed font-light break-words">{renderContent(comment.content)}</p>}
                      </div>
                    ) : comment.type === 'voice' ? (
                      <VoiceMessage url={comment.voiceUrl || ''} />
                    ) : (
                      <p className="text-sm text-fg leading-relaxed font-light break-words">{renderContent(comment.content)}</p>
                    )}
                  </div>
                  
                  <div className="pt-1">
                    <EmojiReactions 
                      reactions={comment.reactions} 
                      onReact={(emoji) => handleReactComment(comment.id, emoji)} 
                      currentUserId={user.uid} 
                      isSmall={true}
                    />
                    <button 
                      onClick={() => setReplyingTo(comment)}
                      className="text-xs font-black uppercase tracking-widest text-muted hover:text-accent transition-colors"
                    >
                      Reply
                    </button>
                  </div>
                </div>
              </div>
                ))
              )}
            </>
          )}
        </div>

        <div className="p-8 border-t border-line bg-black/20 shrink-0">
          <AnimatePresence>
            {replyingTo && (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                className="bg-accent/10 border border-accent/20 rounded-2xl p-4 mb-4 flex items-center justify-between"
              >
                <div className="flex-1 overflow-hidden">
                  <span className="text-xs font-black uppercase tracking-widest text-accent block mb-1">Replying to {replyingTo.user?.displayName}</span>
                  <p className="text-sm text-muted truncate italic">{replyingTo.content}</p>
                </div>
                <button onClick={() => setReplyingTo(null)} className="text-subtle hover:text-fg ml-4">
                  <X size={16} />
                </button>
              </motion.div>
            )}
          </AnimatePresence>
          <div className="mb-4">
            {pendingAttachment && (
              <motion.div 
                initial={{ opacity: 0, scale: 0.95, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                className="bg-accent/10 border border-accent/20 p-4 rounded-3xl mb-4 space-y-4"
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
              <div className="flex items-center gap-2 px-4 py-2 bg-accent/10 rounded-full w-fit animate-pulse">
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
                  className="flex items-center justify-between bg-danger/10 border border-danger/20 p-4 rounded-3xl mb-4"
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

          <form onSubmit={handleSubmit} className="flex items-center gap-3 relative">
            <AnimatePresence>
              {showMentions && filteredMentionUsers.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 10, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 10, scale: 0.95 }}
                  className="absolute bottom-full left-0 right-0 z-[100] mb-4 glass border border-line rounded-2xl shadow-2xl overflow-hidden max-h-[300px] overflow-y-auto p-2 flex flex-col gap-1"
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
                className="w-full h-14 bg-surface-2 border border-line rounded-full pl-6 pr-14 text-sm focus:outline-none focus:border-accent/50 focus:bg-surface-3 transition-colors placeholder:text-subtle disabled:opacity-50 shadow-inner"
              />
              <button
                type="submit"
                disabled={!newComment.trim() || isSubmitting || isRecording}
                className="absolute right-1.5 top-1.5 w-11 h-11 rounded-full bg-accent text-white flex items-center justify-center disabled:opacity-20 active:scale-90 transition-colors shadow-lg"
              >
                <Send size={18} className={cn(newComment.trim() && !isSubmitting ? "translate-x-0.5 -translate-y-0.5" : "")} />
              </button>
            </div>
            
            <div className="flex items-center gap-3">
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
                className="w-[52px] h-[52px] rounded-full bg-surface-2 border border-line flex items-center justify-center text-muted hover:text-fg hover:border-line-strong transition-colors active:scale-90 disabled:opacity-20"
              >
                <ImageIcon size={20} />
              </button>
              
              <button
                type="button"
                onMouseDown={startRecording}
                onMouseUp={stopRecording}
                onMouseLeave={cancelRecording}
                disabled={isSendingImage || isSubmitting}
                className={cn(
                  "w-[52px] h-[52px] rounded-full flex items-center justify-center transition-colors active:scale-75 disabled:opacity-20",
                  isRecording ? "bg-danger text-white shadow-lg scale-110" : "bg-surface-2 border border-line text-muted hover:text-fg hover:border-line-strong"
                )}
              >
                <Mic size={20} />
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
