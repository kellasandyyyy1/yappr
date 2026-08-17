import React, { useState, useEffect, useRef } from 'react';
import {
  chats as chatsApi,
  users as usersApi,
  follows as followsApi,
  reactions as reactionsApi,
  uploadFile,
} from '../lib/db';
import { User, Message, Chat } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import { Send, ChevronLeft, Search, Plus, X, UserPlus, Trash2, MessageSquare, Mic, Image as ImageIcon, Loader2, Play, Pause, Square, Volume2, Check, CheckCheck, Clock, Reply, AtSign, Users, MoreVertical, LogOut, Settings as SettingsIcon, Camera, Eye, EyeOff } from 'lucide-react';
import { ImageViewer } from './ImageViewer';
import { VoiceMessage } from './VoiceMessage';
import { EmojiReactions, EmojiPickerButton } from './EmojiReactions';
import { StatusIndicator } from './StatusIndicator';
import { Avatar } from './Avatar';
import { RowSkeleton } from './Skeleton';
import { ConfirmDialog } from './Modal';
import { moderatePreview } from '../lib/moderation';
import { cn, formatTimeAgo } from '../lib/utils';
import { useToast } from './ToastContext';
import { sendPushNotification } from '../lib/sendPush';

import { SharedPostPreview } from './SharedPostPreview';
import { CreateGroupModal } from './CreateGroupModal';

interface ChatViewProps {
  user: User;
  onProfileClick: () => void;
  onUserClick?: (uid: string) => void;
  onChatOpenChange?: (isOpen: boolean) => void;
  onBack?: () => void;
  onPostClick?: (postId: string) => void;
  initialUserId?: string;
}

interface ConversationItemProps {
  currentUser: User;
  chat: Chat;
  onClick: () => void;
}

const ConversationItem: React.FC<ConversationItemProps> = ({ currentUser, chat, onClick }) => {
  const [revealed, setRevealed] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setTick(t => t + 1);
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  // The other participant arrives already joined on the conversation row.
  // Firestore forced a getDoc per row here — an N+1 read on every inbox render.
  const otherUser = (chat as Chat & { otherUser?: User }).otherUser ?? null;

  const lastMessage = chat.lastMessage;
  const isUnread = lastMessage && 
                  lastMessage.senderId !== currentUser.uid && 
                  (!lastMessage.readBy || !lastMessage.readBy.includes(currentUser.uid));

  const displayName = chat.type === 'group' ? chat.name : (otherUser?.displayName || 'Loading…');
  const username = chat.type === 'group' ? `${chat.participants.length} members` : (otherUser ? `@${otherUser.username}` : '');

  const isAttachment = lastMessage?.type === 'image' || lastMessage?.type === 'voice';
  // Previews are moderated because they surface in a list the reader never
  // opted into. The message itself is never altered inside the conversation.
  const preview = isAttachment ? null : moderatePreview(lastMessage?.content);
  const showOriginal = revealed || !preview?.flagged;

  const prefix = lastMessage?.senderId === currentUser.uid ? 'You: ' : '';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        'flex w-full cursor-pointer items-center gap-3 rounded-2xl border p-4 text-left',
        'transition-colors duration-100 hover:bg-surface-2',
        isUnread ? 'border-accent/40 bg-accent/8' : 'border-line bg-surface'
      )}
    >
      {/* One avatar treatment for every conversation, group or direct. */}
      <Avatar
        size="xl"
        src={chat.type === 'group' ? chat.photoURL : otherUser?.photoURL}
        name={chat.type === 'group' ? chat.name : otherUser?.displayName}
        fallbackIcon={chat.type === 'group' ? <Users size={22} /> : undefined}
        showStatus={chat.type === 'direct' && !!otherUser}
        statusUser={otherUser}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="truncate text-[15px] font-semibold text-fg">{displayName}</h3>
          {lastMessage && (
            <span className={cn('shrink-0 text-xs', isUnread ? 'text-accent' : 'text-muted')}>
              {formatTimeAgo(lastMessage.createdAt)}
            </span>
          )}
        </div>

        <div className="mt-0.5 flex items-center gap-2">
          {lastMessage ? (
            <>
              <p
                className={cn(
                  'min-w-0 flex-1 truncate text-sm',
                  isUnread ? 'font-medium text-fg' : 'text-muted',
                  lastMessage.senderId === 'system' && 'italic text-subtle'
                )}
              >
                {prefix}
                {isAttachment
                  ? lastMessage.type === 'image'
                    ? '📷 Photo'
                    : '🎤 Voice message'
                  : showOriginal
                    ? preview?.original
                    : preview?.text}
              </p>

              {preview?.flagged && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setRevealed((v) => !v);
                  }}
                  aria-label={revealed ? 'Hide filtered words' : 'Show filtered words'}
                  title={revealed ? 'Hide filtered words' : 'Show filtered words'}
                  className="flex h-7 shrink-0 items-center gap-1 rounded-full border border-line
                             bg-surface-2 px-2 text-xs font-medium text-muted transition-colors
                             duration-100 hover:text-fg"
                >
                  {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
                  {revealed ? 'Hide' : 'Reveal'}
                </button>
              )}
            </>
          ) : (
            <p className="truncate text-sm text-muted">{username}</p>
          )}
        </div>
      </div>
    </div>
  );
}

export function ChatView({ user, onProfileClick, onUserClick, onChatOpenChange, onBack, onPostClick, initialUserId }: ChatViewProps) {
  const [conversations, setConversations] = useState<Chat[]>([]);
  const [selectedChat, setSelectedChat] = useState<Chat | null>(null);
  const [selectedUser, setSelectedUser] = useState<User | null>(null); // For 1-to-1 chats derived from search
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [otherUserIsTyping, setOtherUserIsTyping] = useState<string[]>([]); // Array of typing user IDs
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showCreateGroupModal, setShowCreateGroupModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [foundUser, setFoundUser] = useState<User | null>(null);
  const [searchError, setSearchError] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [followedUsers, setFollowedUsers] = useState<User[]>([]);
    const [loadingFollowed, setLoadingFollowed] = useState(false);

    useEffect(() => {
      if (!showAddModal) return;
      const fetchFollowed = async () => {
        setLoadingFollowed(true);
        try {
          // One joined query. Firestore read the follow docs and then issued a
          // getDoc per followed user.
          setFollowedUsers(await followsApi.list(user.uid, 'following'));
        } catch (err) {
          console.error('Error fetching followed users:', err);
        } finally {
          setLoadingFollowed(false);
        }
      };
      fetchFollowed();
    }, [showAddModal, user.uid]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmDeleteChat, setConfirmDeleteChat] = useState(false);
  const [isSendingImage, setIsSendingImage] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [pendingAttachment, setPendingAttachment] = useState<{ type: 'image' | 'voice'; url: string } | null>(null);
  const [viewingImage, setViewingImage] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [showGroupDetails, setShowGroupDetails] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [tempGroupName, setTempGroupName] = useState('');
  const [isUpdatingGroup, setIsUpdatingGroup] = useState(false);
  const groupPhotoInputRef = useRef<HTMLInputElement>(null);
  const [memberDetails, setMemberDetails] = useState<Record<string, User>>({});
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isTypingRef = useRef(false);
  const typingChannelRef = useRef<ReturnType<typeof chatsApi.typingChannel> | null>(null);
  // Keyset cursor for older history, replacing Firestore's hard limit(100).
  const [messageCursor, setMessageCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const { toast } = useToast();

  // Notify parent of modal states
  useEffect(() => {
    const isModalOpen = !!selectedChat || showAddModal || showCreateGroupModal || !!confirmDelete;
    onChatOpenChange?.(isModalOpen);
    return () => onChatOpenChange?.(false);
  }, [selectedChat, showAddModal, showCreateGroupModal, confirmDelete, onChatOpenChange]);

  // --- Inbox -----------------------------------------------------------------
  // One query with members and the latest message joined, refreshed when
  // anything in any of my conversations changes. Replaces the array-contains
  // snapshot plus a per-row getDoc for the other participant.
  const refreshConversations = React.useCallback(async () => {
    try {
      setConversations(await chatsApi.list(user.uid));
    } catch (err) {
      console.error('Error loading conversations:', err);
    } finally {
      setLoading(false);
    }
  }, [user.uid]);

  useEffect(() => {
    refreshConversations();
    return chatsApi.subscribeToInbox(refreshConversations);
  }, [refreshConversations]);

  // --- Open conversation: members, history, live updates ----------------------
  useEffect(() => {
    if (!selectedChat) {
      setOtherUserIsTyping([]);
      return;
    }

    const conversationId = selectedChat.id;
    let cancelled = false;

    // Members come from the joined conversation row the inbox already loaded.
    const details: Record<string, User> = {};
    const joined = (selectedChat as Chat & { members?: User[] }).members;
    if (joined) {
      for (const m of joined) if (m.uid !== user.uid) details[m.uid] = m;
      setMemberDetails(details);
    } else {
      // Opened from a deep link rather than the inbox — fetch the members.
      (async () => {
        const fresh = (await chatsApi.list(user.uid)).find((c) => c.id === conversationId);
        const list = (fresh as (Chat & { members?: User[] }) | undefined)?.members ?? [];
        if (cancelled) return;
        const map: Record<string, User> = {};
        for (const m of list) if (m.uid !== user.uid) map[m.uid] = m;
        setMemberDetails(map);
      })();
    }

    // History, oldest-first for rendering.
    (async () => {
      try {
        const page = await chatsApi.messages(conversationId, { limit: 50 });
        if (cancelled) return;
        setMessages(page.messages);
        setMessageCursor(page.nextCursor);
        setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
      } catch (err) {
        console.error('Error loading messages:', err);
      }
    })();

    // Realtime. The delta carries no joins, so db.ts re-reads the row before
    // handing it over — otherwise receipts and reactions would arrive empty.
    const unsubMessages = chatsApi.subscribeToMessages(conversationId, {
      onInsert: (message) => {
        setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
        setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
      },
      onDelete: (id) => setMessages((prev) => prev.filter((m) => m.id !== id)),
    });

    // Typing via Realtime Presence — ephemeral broadcast, zero database writes.
    // The Firestore version wrote a document per keystroke.
    const typing = chatsApi.typingChannel(conversationId, user.uid);
    typing.onTypingChange(setOtherUserIsTyping);
    typingChannelRef.current = typing;

    return () => {
      cancelled = true;
      unsubMessages();
      typing.setTyping(false);
      typing.close();
      typingChannelRef.current = null;
    };
  }, [selectedChat, user.uid]);

  // --- Read receipts ----------------------------------------------------------
  // One call marks every unread receipt in the conversation. Firestore needed a
  // writeBatch rewriting readBy[] on each message document, plus a second write
  // to keep chats/{id}.lastMessage.readBy in sync.
  useEffect(() => {
    if (!selectedChat || messages.length === 0) return;
    const hasUnread = messages.some(
      (m) => m.senderId !== user.uid && !(m.readBy ?? []).includes(user.uid)
    );
    if (!hasUnread) return;

    chatsApi.markRead(selectedChat.id, user.uid).catch((err) => {
      console.error('Error marking messages read:', err);
    });
  }, [messages, selectedChat, user.uid]);

  /**
   * Older history, one page at a time.
   *
   * Firestore capped the listener at limit(100) with no way to go further back
   * — anything older than the hundredth message was simply unreachable. Keyset
   * pagination on created_at has no such ceiling.
   */
  const loadOlderMessages = async () => {
    if (!selectedChat || !messageCursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await chatsApi.messages(selectedChat.id, { cursor: messageCursor, limit: 50 });
      setMessages((prev) => {
        const existing = new Set(prev.map((m) => m.id));
        return [...page.messages.filter((m) => !existing.has(m.id)), ...prev];
      });
      setMessageCursor(page.nextCursor);
    } catch (err) {
      console.error('Error loading older messages:', err);
    } finally {
      setLoadingOlder(false);
    }
  };

  const setLocalTypingStatus = (isTyping: boolean) => {
    if (isTypingRef.current === isTyping) return;
    isTypingRef.current = isTyping;
    typingChannelRef.current?.setTyping(isTyping);
  };

  const handleTyping = (e: React.ChangeEvent<HTMLInputElement>) => {
    setNewMessage(e.target.value);
    
    if (!isTypingRef.current && e.target.value.trim() !== '') {
      setLocalTypingStatus(true);
    }

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);

    typingTimeoutRef.current = setTimeout(() => {
      setLocalTypingStatus(false);
    }, 2500);
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || !selectedChat) return;

    const msg = newMessage;
    setNewMessage('');
    
    // Clear typing status immediately
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    setLocalTypingStatus(false);

    try {
      // No lastMessage write and no updatedAt write: the touch_conversation
      // trigger reorders the inbox and fan_out_message_receipts creates the
      // pending receipts, both inside the same transaction as the insert.
      // Firestore needed two more client writes that could fail independently
      // and leave the inbox showing a stale preview.
      await chatsApi.send({
        conversationId: selectedChat.id,
        senderId: user.uid,
        content: msg,
        type: 'text',
        replyToId: replyingTo?.id ?? null,
      });

      const otherParticipants = selectedChat.participants.filter(pid => pid !== user.uid);
      const pushTitle = selectedChat.type === 'group' ? (selectedChat.name ?? 'Group') : user.displayName;
      otherParticipants.forEach(pid => {
        sendPushNotification(pid, pushTitle, msg, `/chat?id=${selectedChat.id}`);
      });

      setReplyingTo(null);
    } catch (err) {
      console.error('Error sending message:', err);
      toast('Could not send that message', 'error');
    }
  };

  const handleStartDirectChat = async (otherUser: User) => {
    try {
      // Finds the existing thread or creates one. The direct_conversation_keys
      // unique constraint prevents the duplicate threads Firestore allowed when
      // both people opened a chat at the same moment — the old deterministic
      // `${a}_${b}` document id was doing that job client-side.
      const conversationId = await chatsApi.openDirect(user.uid, otherUser.uid);
      const fresh = (await chatsApi.list(user.uid)).find(c => c.id === conversationId);

      if (fresh) setSelectedChat(fresh);
      setShowAddModal(false);
      setFoundUser(null);
      setSearchQuery('');
    } catch (err) {
      console.error('Error opening conversation:', err);
      toast('Could not open that conversation', 'error');
    }
  };

  const handleSearchUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    setSearchError('');
    setFoundUser(null);
    try {
      // Single query across username and email. Firestore needed two round
      // trips because it cannot OR across fields.
      const found = await usersApi.findByHandle(searchQuery.replace('@', ''), user.uid);
      if (found) setFoundUser(found);
      else setSearchError('No one found with that username or email');
    } catch (err) {
      setSearchError('Search failed. Check your connection and try again.');
    } finally {
      setIsSearching(false);
    }
  };

  // Handle initial user ID for direct chat redirection
  useEffect(() => {
    if (initialUserId && !loading) {
      const existingChat = conversations.find(c => 
        c.type === 'direct' && c.participants.includes(initialUserId)
      );
      
      if (existingChat) {
        setSelectedChat(existingChat);
      } else {
        usersApi.get(initialUserId).then((target) => {
          if (target) handleStartDirectChat(target);
        }).catch(err => {
          console.error('Error fetching initial user for chat redirect:', err);
        });
      }
    }
  }, [initialUserId, loading, conversations.length > 0]);

  const handleDeleteMessage = async (messageId: string) => {
    if (!selectedChat) return;
    try {
      await chatsApi.removeMessage(messageId);
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
      setConfirmDelete(null);
    } catch (err) {
      console.error('Error deleting message:', err);
      toast('Could not delete that message', 'error');
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    if (!selectedChat || !selectedChat.admins?.includes(user.uid)) return;
    if (memberId === user.uid) return; // leaving is a separate action

    try {
      // Membership is a row, not an array rewrite. The old version had to
      // read-modify-write both participants[] and admins[], so two admins
      // acting at once could clobber each other.
      await chatsApi.leave(selectedChat.id, memberId);
      await chatsApi.sendSystem(
        selectedChat.id,
        `Removed ${memberDetails[memberId]?.displayName || 'a member'} from the group`
      );
      await refreshConversations();
    } catch (err) {
      console.error('Error removing member:', err);
      toast('Could not remove that member', 'error');
    }
  };

  const handleAddMember = async (targetUser: User) => {
    if (!selectedChat) return;
    if (selectedChat.participants.includes(targetUser.uid)) return;

    try {
      await chatsApi.addMember(selectedChat.id, targetUser.uid);
      await chatsApi.sendSystem(selectedChat.id, `Added ${targetUser.displayName} to the group`);
      await refreshConversations();

      setShowAddModal(false);
      setFoundUser(null);
      setSearchQuery('');
    } catch (err) {
      console.error('Error adding member:', err);
      toast('Could not add that person', 'error');
    }
  };

  const handleDeleteChat = async () => {
    if (!selectedChat) return;
    setIsSubmitting(true);
    try {
      // One delete. ON DELETE CASCADE removes the messages, members, receipts
      // and reactions — the Firestore version had to enumerate every message
      // document and every typing doc into a writeBatch, which silently capped
      // out at 500 operations on a busy conversation.
      await chatsApi.removeConversation(selectedChat.id);
      setSelectedChat(null);
      setConfirmDeleteChat(false);
      await refreshConversations();
    } catch (err) {
      console.error('Error deleting conversation:', err);
      toast('Could not delete that conversation', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLeaveGroup = async () => {
    if (!selectedChat || selectedChat.type !== 'group') return;
    setIsSubmitting(true);
    try {
      const remaining = selectedChat.participants.filter(id => id !== user.uid);

      if (remaining.length === 0) {
        await handleDeleteChat();
        return;
      }

      // Announce before leaving: once the membership row is gone, RLS stops
      // this user inserting into the conversation at all.
      await chatsApi.sendSystem(selectedChat.id, `${user.displayName} left the group`);
      await chatsApi.leave(selectedChat.id, user.uid);

      setSelectedChat(null);
      setConfirmDeleteChat(false);
      await refreshConversations();
    } catch (err) {
      console.error('Error leaving group:', err);
      toast('Could not leave the group', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReactMessage = async (messageId: string, emoji: string) => {
    if (!selectedChat) return;
    const message = messages.find(m => m.id === messageId);
    if (!message) return;

    // Clicking the same emoji clears it, a different one replaces it. Upsert on
    // (message_id, user_id) does both atomically — the old read-modify-write of
    // the whole reactions map could drop a concurrent reaction.
    const alreadyReacted = (message.reactions?.[emoji] ?? []).includes(user.uid);
    const next = alreadyReacted ? null : emoji;

    try {
      await reactionsApi.setOnMessage(messageId, user.uid, next);

      setMessages((prev) => prev.map((m) => {
        if (m.id !== messageId) return m;
        const reactions: Record<string, string[]> = {};
        for (const [key, ids] of Object.entries<string[]>(m.reactions ?? {})) {
          const kept = ids.filter((id) => id !== user.uid);
          if (kept.length > 0) reactions[key] = kept;
        }
        if (next) reactions[next] = [...(reactions[next] ?? []), user.uid];
        return { ...m, reactions };
      }));
    } catch (err) {
      console.error('Error reacting to message:', err);
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedChat) return;

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

  const confirmAndSendAttachment = async () => {
    if (!pendingAttachment || !selectedChat) return;
    setIsSubmitting(true);

    try {
      const type = pendingAttachment.type;

      // Upload the bytes rather than storing the data URL in the row.
      // Firestore held the whole base64 payload inline, which inflated every
      // message read and hit the 1MB document ceiling on larger images.
      //
      // The `chat` bucket is PRIVATE: Firebase download URLs carried an
      // unguessable token, so a public bucket would be strictly weaker. The
      // row stores `supabase://chat/<path>` and readers mint a signed URL.
      const blob = await (await fetch(pendingAttachment.url)).blob();
      const extension = type === 'image' ? (blob.type.split('/')[1] || 'jpg') : 'webm';
      const objectPath = `${selectedChat.id}/${user.uid}-${Date.now()}.${extension}`;
      const storedUrl = await uploadFile('chat', objectPath, blob, blob.type);

      await chatsApi.send({
        conversationId: selectedChat.id,
        senderId: user.uid,
        content: type === 'image' ? 'Sent an image' : 'Voice Message',
        type,
        imageUrl: type === 'image' ? storedUrl : null,
        voiceUrl: type === 'voice' ? storedUrl : null,
        replyToId: replyingTo?.id ?? null,
      });

      const otherParticipants = selectedChat.participants.filter(pid => pid !== user.uid);
      const pushTitle = selectedChat.type === 'group' ? (selectedChat.name ?? 'Group') : user.displayName;
      const pushBody = type === 'image' ? 'Sent an image' : 'Voice Message';
      otherParticipants.forEach(pid => {
        sendPushNotification(pid, pushTitle, pushBody, `/chat?id=${selectedChat.id}`);
      });

      setPendingAttachment(null);
      setReplyingTo(null);
    } catch (err) {
      console.error('Error sending attachment:', err);
      toast('Could not send that attachment', 'error');
    } finally {
      setIsSubmitting(false);
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
            url: reader.result as string
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

  const handleUpdateGroupName = async () => {
    if (!selectedChat || !tempGroupName.trim() || tempGroupName === selectedChat.name) {
      setIsEditingName(false);
      return;
    }
    setIsUpdatingGroup(true);
    const nextName = tempGroupName.trim();
    try {
      // RLS restricts this to admins, so a non-admin's attempt is rejected by
      // the database rather than merely hidden in the UI.
      await chatsApi.updateGroup(selectedChat.id, { name: nextName });
      await chatsApi.sendSystem(
        selectedChat.id,
        `${user.displayName} changed group name to "${nextName}"`
      );
      setSelectedChat({ ...selectedChat, name: nextName });
      await refreshConversations();
      setIsEditingName(false);
    } catch (err) {
      console.error('Error renaming group:', err);
      toast('Could not rename the group', 'error');
    } finally {
      setIsUpdatingGroup(false);
    }
  };

  const handleUpdateGroupPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedChat) return;

    setIsUpdatingGroup(true);
    try {
      // Uploaded, not inlined as base64. Group photos go to the public
      // `posts` bucket since they render next to every inbox row.
      const objectPath = `groups/${selectedChat.id}-${Date.now()}`;
      const photoURL = await uploadFile('posts', objectPath, file, file.type);

      await chatsApi.updateGroup(selectedChat.id, { photoUrl: photoURL });
      await chatsApi.sendSystem(selectedChat.id, `${user.displayName} changed group photo`);
      setSelectedChat({ ...selectedChat, photoURL });
      await refreshConversations();
    } catch (err) {
      console.error('Error updating group photo:', err);
      toast('Could not update the group photo', 'error');
    } finally {
      setIsUpdatingGroup(false);
    }
  };

  if (selectedChat) {
    const isGroup = selectedChat.type === 'group';
    const otherUserId = selectedChat.participants.find(id => id !== user.uid);
    const otherUser = isGroup ? null : (otherUserId ? memberDetails[otherUserId] : null);
    const recipients = selectedChat.participants.filter(id => id !== user.uid);

    /**
     * Four real states, each backed by data we actually store:
     *   sending   — no server timestamp yet, the write is still in flight
     *   sent      — written to the database, no recipient client has it yet
     *   delivered — a recipient's client acknowledged receipt (App.tsx)
     *   seen      — a recipient opened the conversation (readBy)
     */
    const statusOf = (msg: Message) => {
      if (!msg.createdAt) {
        return { label: 'Sending', tone: 'muted' as const, icon: <Clock size={12} /> };
      }

      const seenBy = (msg.readBy || []).filter(id => id !== user.uid && recipients.includes(id));
      if (seenBy.length > 0) {
        return {
          label: isGroup ? `Seen by ${seenBy.length}` : 'Seen',
          tone: 'accent' as const,
          icon: <CheckCheck size={12} />,
        };
      }

      const gotBy = (msg.deliveredTo || []).filter(id => id !== user.uid && recipients.includes(id));
      if (gotBy.length > 0) {
        return {
          label: isGroup ? `Delivered to ${gotBy.length}` : 'Delivered',
          tone: 'muted' as const,
          icon: <CheckCheck size={12} />,
        };
      }

      return { label: 'Sent', tone: 'muted' as const, icon: <Check size={12} /> };
    };

    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        // Full-screen on mobile; inset past the fixed sidebar at >=640px so
        // navigation stays reachable while a conversation is open.
        style={{ zIndex: 'var(--z-fullscreen)' }}
        className="fixed inset-0 flex flex-col bg-bg p-4 pb-6 sm:left-20 sm:p-6 lg:left-64"
      >
        <div className="mb-5 flex items-center gap-3">
          <button
            onClick={() => {
              setSelectedChat(null);
              setShowGroupDetails(false);
            }}
            aria-label="Back to conversations"
            className="tap shrink-0 rounded-full text-muted transition-colors duration-100 hover:text-fg"
          >
            <ChevronLeft size={22} />
          </button>

          <div
            onClick={() => isGroup && setShowGroupDetails(!showGroupDetails)}
            className={cn(
              "flex min-w-0 items-center gap-3 rounded-full p-1 pr-4 transition-colors duration-100",
              isGroup ? "cursor-pointer hover:bg-surface-2" : "cursor-default"
            )}
          >
             <Avatar
               size="lg"
               src={isGroup ? selectedChat.photoURL : otherUser?.photoURL}
               name={isGroup ? selectedChat.name : otherUser?.displayName}
               fallbackIcon={isGroup ? <Users size={20} /> : undefined}
             />
             <div className="min-w-0 text-left">
               <h3 className="truncate text-[15px] font-semibold text-fg">
                 {isGroup ? selectedChat.name : (otherUser?.displayName || 'Loading…')}
               </h3>
               <div className="flex h-4 items-center gap-1.5">
                 {otherUserIsTyping.length > 0 ? (
                   <span className="text-sm font-medium text-accent">
                     {isGroup ? `${otherUserIsTyping.length} typing…` : 'Typing…'}
                   </span>
                 ) : isGroup ? (
                   <span className="text-sm text-muted">{selectedChat.participants.length} members</span>
                 ) : otherUser ? (
                   <StatusIndicator user={otherUser} showText={true} />
                 ) : null}
               </div>
             </div>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {isGroup && (
              <button
                onClick={() => setShowGroupDetails(!showGroupDetails)}
                aria-label="Group details"
                title="Group details"
                className={cn(
                  "tap rounded-full border transition-colors duration-100",
                  showGroupDetails ? "border-accent bg-accent text-white" : "border-line bg-surface-2 text-muted hover:text-fg"
                )}
              >
                <Users size={18} />
              </button>
            )}
            <button
              onClick={() => setConfirmDeleteChat(true)}
              aria-label={isGroup ? "Leave group" : "Delete conversation"}
              title={isGroup ? "Leave group" : "Delete conversation"}
              className="tap rounded-full border border-line bg-surface-2 text-danger transition-colors duration-100 hover:bg-danger/10"
            >
              {isGroup ? <LogOut size={18} /> : <Trash2 size={18} />}
            </button>
          </div>
        </div>

        {/* min-h-0 is load-bearing, not tidying.
            A flex item defaults to `min-height: auto`, which refuses to shrink
            below its content. Once a conversation grew past the viewport this
            pane expanded to fit every message instead of scrolling, which
            pushed the composer off the bottom of the screen and left the
            conversation looking unreachable. Short chats hid the bug entirely,
            because the content still fitted. */}
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* Compact rhythm: 12px between date groups, 2px between consecutive
              bubbles. Was 24px everywhere, which turned a short exchange into a
              mostly-empty column. */}
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 pt-2 scrollbar-hide">
            {messageCursor && (
              <div className="flex justify-center">
                <button
                  onClick={loadOlderMessages}
                  disabled={loadingOlder}
                  className="btn-secondary px-3 py-1.5 text-xs"
                >
                  {loadingOlder ? 'Loading…' : 'Load older messages'}
                </button>
              </div>
            )}

            {/* An open conversation with no history rendered as a black void —
                no spinner, no message, nothing to distinguish "empty" from
                "broken". Verified against the database: the conversation really
                did have zero messages, so this is the correct state, it simply
                had no representation. */}
            {messages.length === 0 && !messageCursor && (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-2 text-muted">
                  <MessageSquare size={20} />
                </div>
                <p className="text-sm font-semibold text-fg">No messages yet</p>
                <p className="max-w-[240px] text-xs leading-relaxed text-muted">
                  Say hello to {selectedUser?.displayName ?? 'them'} — your messages will appear here.
                </p>
              </div>
            )}

            {Object.entries(
              messages.reduce((groups: { [key: string]: Message[] }, msg) => {
                const date = msg.createdAt ? new Date((msg.createdAt as any).toDate ? (msg.createdAt as any).toDate() : msg.createdAt) : new Date();
                const dateKey = date.toDateString();
                if (!groups[dateKey]) groups[dateKey] = [];
                groups[dateKey].push(msg);
                return groups;
              }, {})
            ).map(([dateStr, dateMessages]) => (
              <div key={dateStr} className="space-y-0.5">
                <div className="flex items-center gap-3 pb-2 pt-1">
                  <div className="h-px flex-1 bg-line" />
                  <span className="whitespace-nowrap text-[11px] font-medium uppercase tracking-wide text-subtle">
                    {(() => {
                      const date = new Date(dateStr);
                      const today = new Date();
                      const yesterday = new Date();
                      yesterday.setDate(yesterday.getDate() - 1);
                      if (date.toDateString() === today.toDateString()) return 'Today';
                      if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
                      return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
                    })()}
                  </span>
                  <div className="h-px flex-1 bg-line" />
                </div>

                {(dateMessages as Message[]).map((msg) => {
                  const isMe = msg.senderId === user.uid;
                  const sender = isMe ? user : memberDetails[msg.senderId];
                  const status = statusOf(msg);
                  const hasReactions =
                    !!msg.reactions &&
                    Object.values(msg.reactions).some((ids) => ids.length > 0);

                  return (
                    <div
                      key={msg.id}
                      className={cn(
                        // min-w-0 is what stops a long shared-post preview or an
                        // unbroken URL from pushing the bubble past the viewport.
                        //
                        // group/msg lives here, not on the bubble row: the
                        // timestamp is a SIBLING of that row, so a group scoped
                        // to the row would never match it and the metadata
                        // would stay invisible on hover.
                        "group/msg flex min-w-0 max-w-[85%] flex-col",
                        isMe ? "ml-auto items-end" : "mr-auto items-start"
                      )}
                    >
                      {!isMe && isGroup && (
                        <span className="mb-0.5 ml-7 text-xs font-medium text-muted">
                          {sender?.displayName || 'Unknown user'}
                        </span>
                      )}

                      <div className={cn(
                        "relative flex min-w-0 max-w-full items-end gap-1.5",
                        isMe ? "flex-row-reverse" : "flex-row"
                      )}>
                        {!isMe && <Avatar user={sender} size="xs" />}

                        <div className="relative min-w-0 max-w-full">
                          {/* leading-snug rather than leading-relaxed: at this
                              bubble width relaxed adds a visible gap between
                              every line and roughly a third to the height. */}
                          <div className={cn(
                            "relative overflow-hidden rounded-2xl text-sm leading-snug",
                            "min-w-0 max-w-full break-words [overflow-wrap:anywhere]",
                            isMe
                              ? "rounded-br-md bg-accent text-white"
                              : "rounded-bl-md border border-line bg-surface-2 text-fg",
                            msg.type === 'image' ? "p-1" : "px-3 py-1.5"
                          )}>
                            {msg.replyToId && (
                              <div className={cn(
                                "mb-2 flex flex-col gap-0.5 rounded-lg border-l-2 p-2 text-xs",
                                isMe ? "border-white/40 bg-black/20" : "border-accent/50 bg-surface-3"
                              )}>
                                <span className={cn("flex items-center gap-1 font-semibold", isMe ? "text-white/80" : "text-muted")}>
                                  <MessageSquare size={10} /> {msg.replyToSenderName}
                                </span>
                                <p className={cn("truncate italic", isMe ? "text-white/70" : "text-muted")}>
                                  {msg.replyToType === 'image' ? '📷 Photo' : msg.replyToType === 'voice' ? '🎤 Voice' : msg.replyToContent}
                                </p>
                              </div>
                            )}
                            {msg.type === 'image' && msg.imageUrl ? (
                              <div className="cursor-zoom-in space-y-2" onClick={() => setViewingImage(msg.imageUrl!)}>
                                <img src={msg.imageUrl} alt="Shared photo" className="w-full max-w-full rounded-xl object-cover" loading="lazy" decoding="async" />
                                {msg.content !== 'Sent an image' && <p className="px-2 pb-1">{msg.content}</p>}
                              </div>
                            ) : msg.type === 'voice' ? (
                              <VoiceMessage url={msg.voiceUrl || ''} isMe={isMe} />
                            ) : (
                              <p className="min-w-0">{msg.content}</p>
                            )}

                            {msg.postId && (
                              <SharedPostPreview postId={msg.postId} isMe={isMe} onClick={() => onPostClick?.(msg.postId!)} />
                            )}
                          </div>

                          {/* Hover actions, including the reaction trigger —
                              keeping it here means nothing floats under short
                              bubbles when there is nothing to react with. */}
                          <div className={cn(
                            "absolute top-1/2 flex -translate-y-1/2 items-center gap-1 opacity-0 transition-opacity duration-100 focus-within:opacity-100 group-hover/msg:opacity-100",
                            isMe ? "right-full mr-2" : "left-full ml-2"
                          )}>
                            <EmojiPickerButton onReact={(emoji) => handleReactMessage(msg.id, emoji)} />
                            <button
                              onClick={() => setReplyingTo(msg)}
                              aria-label="Reply"
                              title="Reply"
                              className="flex h-8 w-8 items-center justify-center rounded-full border border-line bg-surface-3 text-muted transition-colors duration-100 hover:text-fg"
                            >
                              <Reply size={14} />
                            </button>
                            {isMe && (
                              <button
                                onClick={() => setConfirmDelete(msg.id)}
                                aria-label="Delete message"
                                title="Delete message"
                                className="flex h-8 w-8 items-center justify-center rounded-full border border-line bg-surface-3 text-muted transition-colors duration-100 hover:text-danger"
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Reaction chips sit in normal flow directly under the
                          bubble, so they never stack awkwardly on short ones. */}
                      {hasReactions && (
                        <div className={cn("mt-0.5 flex", isMe ? "mr-0 justify-end" : "ml-7 justify-start")}>
                          <EmojiReactions
                            reactions={msg.reactions}
                            onReact={(emoji) => handleReactMessage(msg.id, emoji)}
                            currentUserId={user.uid}
                            isSmall
                            hideAddButton
                          />
                        </div>
                      )}

                      {/* Metadata row.
                          Previously every message carried a full-size timestamp
                          AND a spelled-out delivery status, so a one-word reply
                          was mostly chrome. Now: 10px subtle text, revealed on
                          hover or focus, and the status collapses to its icon
                          with the label kept in the tooltip and for screen
                          readers. `h-3.5` reserves the row so bubbles do not
                          shift on hover. */}
                      <div
                        className={cn(
                          "mt-0.5 flex h-3.5 items-center gap-1 text-[10px] leading-none",
                          "opacity-0 transition-opacity duration-100",
                          "group-hover/msg:opacity-100 group-focus-within/msg:opacity-100",
                          isMe ? "mr-0 justify-end" : "ml-7 justify-start"
                        )}
                      >
                        <span className="text-subtle">
                          {msg.createdAt
                            ? new Date((msg.createdAt as any).toDate ? (msg.createdAt as any).toDate() : msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                            : 'Sending…'}
                        </span>
                        {isMe && status && (
                          <span
                            className={cn(
                              "flex items-center",
                              status.tone === 'accent' ? "text-accent" : "text-subtle"
                            )}
                            title={status.label}
                          >
                            {status.icon}
                            <span className="sr-only">{status.label}</span>
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          <AnimatePresence>
            {showGroupDetails && isGroup && (
              <motion.div 
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                className="absolute inset-y-0 right-0 z-30 flex w-72 max-w-[85%] flex-col overflow-y-auto border-l border-line bg-surface p-6"
              >
                <div className="mb-10 flex flex-col items-center text-center">
                  <div className="relative group/group-photo mb-6">
                    <div className="w-24 h-24 rounded-2xl border-2 border-line overflow-hidden bg-surface-2 shadow-2xl">
                      {selectedChat.photoURL ? (
                        <img src={selectedChat.photoURL} alt="" className="w-full h-full object-cover" loading="lazy" decoding="async" />
                      ) : (
                        <div className="w-full h-full bg-surface-3 flex items-center justify-center">
                          <Users size={32} className="text-muted" />
                        </div>
                      )}
                    </div>
                    {selectedChat.admins?.includes(user.uid) && (
                      <>
                        <input 
                          type="file" 
                          ref={groupPhotoInputRef}
                          className="hidden"
                          accept="image/*"
                          onChange={handleUpdateGroupPhoto}
                        />
                        <button 
                          onClick={() => groupPhotoInputRef.current?.click()}
                          className="absolute -bottom-2 -right-2 w-10 h-10 rounded-2xl bg-accent text-white flex items-center justify-center shadow-xl transition-transform active:scale-95"
                        >
                          <Camera size={16} />
                        </button>
                      </>
                    )}
                  </div>
                  
                  {isEditingName ? (
                    <div className="w-full space-y-3">
                      <input 
                        autoFocus
                        value={tempGroupName}
                        onChange={(e) => setTempGroupName(e.target.value)}
                        onBlur={handleUpdateGroupName}
                        onKeyDown={(e) => e.key === 'Enter' && handleUpdateGroupName()}
                        className="w-full bg-surface-2 border border-line rounded-xl px-4 py-2 text-center text-sm font-bold text-white focus:outline-none focus:border-accent uppercase tracking-tight"
                      />
                      <div className="flex justify-center gap-2">
                        <button onClick={handleUpdateGroupName} className="text-xs font-black text-accent uppercase tracking-widest">Save</button>
                        <button onClick={() => setIsEditingName(false)} className="text-xs font-black text-subtle uppercase tracking-widest">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3">
                      <h4 className="text-sm font-bold text-white uppercase tracking-tight">{selectedChat.name}</h4>
                      {selectedChat.admins?.includes(user.uid) && (
                        <button 
                          onClick={() => {
                            setTempGroupName(selectedChat.name);
                            setIsEditingName(true);
                          }}
                          className="text-subtle hover:text-fg transition-colors"
                        >
                          <SettingsIcon size={12} />
                        </button>
                      )}
                    </div>
                  )}
                  <p className="text-sm font-medium text-subtle mt-2">Group chat</p>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto space-y-4 pr-2 scrollbar-hide">
                  <h5 className="text-xs font-black uppercase tracking-widest text-accent mb-2">Authenticated Members</h5>
                   {[user, ...Object.values(memberDetails)].map((u: User) => (
                      <div key={u.uid} className="flex items-center gap-3 p-3 rounded-2xl bg-surface-2 border border-line relative group/member">
                        <div className="w-8 h-8 rounded-full overflow-hidden flex-shrink-0 border border-line bg-surface-2">
                          {u.photoURL ? <img src={u.photoURL} alt="" className="w-full h-full object-cover" loading="lazy" decoding="async" /> : <div className="w-full h-full bg-surface-2 flex items-center justify-center text-subtle"><AtSign size={12} /></div>}
                        </div>
                        <div className="flex-1 overflow-hidden">
                           <h5 className="text-xs font-bold text-white truncate">{u.displayName}</h5>
                           <p className="text-xs font-bold uppercase tracking-widest text-subtle">@{u.username}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          {selectedChat.admins?.includes(u.uid) && (
                            <span className="text-xs font-black text-accent border border-accent/30 px-1 py-0.5 rounded uppercase">Admin</span>
                          )}
                          {selectedChat.admins?.includes(user.uid) && u.uid !== user.uid && (
                            <button 
                              onClick={() => handleRemoveMember(u.uid)}
                              className="opacity-0 group-hover/member:opacity-100 p-1.5 rounded-full hover:bg-danger/20 text-danger hover:text-danger transition-colors"
                              title="Remove Member"
                            >
                              <X size={12} />
                            </button>
                          )}
                        </div>
                     </div>
                   ))}
                </div>
                {selectedChat.admins?.includes(user.uid) && (
                  <button 
                    onClick={() => setShowAddModal(true)}
                    className="mt-8 w-full py-4 rounded-full bg-accent text-sm font-medium text-white flex items-center justify-center gap-2 hover:bg-accent-deep shadow-lg transition-colors active:scale-95"
                  >
                    <UserPlus size={14} /> Add Identities
                  </button>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="mt-4 flex flex-col gap-4">
          <AnimatePresence>
            {replyingTo && (
              <motion.div 
                initial={{ y: 10, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: 10, opacity: 0 }}
                className="bg-surface-2 border border-line rounded-2xl p-4 flex items-center gap-4 relative overflow-hidden"
              >
                <div className="absolute left-0 top-0 bottom-0 w-1 bg-accent" />
                <div className="flex-1 overflow-hidden ml-2">
                  <span className="text-xs font-black uppercase tracking-widest text-accent block mb-1">
                    Replying to {replyingTo.senderId === user.uid ? 'Yourself' : selectedUser.displayName}
                  </span>
                  <p className="text-sm text-muted truncate italic tracking-tight">
                    {replyingTo.type === 'image' ? 'Image Attachment' : replyingTo.type === 'voice' ? 'Voice Message' : replyingTo.content}
                  </p>
                </div>
                <button 
                  onClick={() => setReplyingTo(null)}
                  className="w-8 h-8 rounded-full bg-surface-2 flex items-center justify-center text-muted hover:text-fg transition-colors"
                >
                  <X size={14} />
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          {isSendingImage && (
            <div className="flex items-center gap-2 px-4 py-2 bg-accent/10 rounded-full w-fit animate-pulse">
              <Loader2 className="w-3 h-3 text-accent animate-spin" />
              <span className="text-xs font-black uppercase tracking-widest text-accent">Sending Image...</span>
            </div>
          )}
          
          <AnimatePresence>
            {isRecording && (
              <motion.div 
                initial={{ y: 10, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: 10, opacity: 0 }}
                className="flex items-center gap-4 px-6 py-4 bg-danger/10 border border-danger/20 rounded-3xl w-full"
              >
                <div className="flex items-center gap-3 flex-1">
                  <div className="w-2 h-2 rounded-full bg-danger animate-pulse" />
                  <span className="text-xs font-black uppercase tracking-widest text-danger">Recording Audio...</span>
                  <span className="text-xs font-mono font-bold text-danger ml-auto">{formatDuration(recordingTime)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <button 
                    onClick={cancelRecording}
                    className="px-4 py-2 text-xs font-black text-muted hover:text-fg uppercase tracking-widest transition-colors"
                  >
                    Discard
                  </button>
                  <button 
                    onClick={stopRecording}
                    className="w-10 h-10 rounded-full bg-danger flex items-center justify-center text-white shadow-lg active:scale-90 transition-transform"
                  >
                    <Square size={16} fill="currentColor" />
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex items-center gap-3">
            <div className="flex-1 bg-surface-2 border border-line p-2 pl-6 rounded-3xl flex items-center gap-2">
              <input 
                value={newMessage}
                onChange={handleTyping}
                placeholder={isRecording ? "SILENCE TO SEND..." : "MESSAGE..."}
                disabled={isRecording || !!pendingAttachment}
                className="flex-1 bg-transparent py-3 text-xs font-bold tracking-widest uppercase focus:outline-none placeholder:text-subtle disabled:opacity-50"
                onKeyDown={(e) => e.key === 'Enter' && handleSendMessage(e)}
              />
              <div className="flex items-center gap-1">
                <input 
                  type="file" 
                  ref={fileInputRef} 
                  className="hidden" 
                  accept="image/*"
                  onChange={handleImageUpload}
                />
                {!isRecording && !pendingAttachment && (
                  <>
                    <button 
                      type="button" 
                      onClick={() => fileInputRef.current?.click()}
                      className="w-10 h-10 rounded-full hover:bg-surface-2 flex items-center justify-center text-muted hover:text-fg transition-colors"
                    >
                      <ImageIcon size={18} />
                    </button>
                    <button 
                      type="button" 
                      onClick={startRecording}
                      className="w-10 h-10 rounded-full hover:bg-surface-2 flex items-center justify-center text-muted hover:text-fg transition-colors"
                    >
                      <Mic size={18} />
                    </button>
                  </>
                )}
              </div>
            </div>
            
            {/* At rest the button stays a solid, readable accent — it used to
                drop to 20% opacity, which read as broken rather than disabled. */}
            <button
              onClick={handleSendMessage}
              disabled={(!newMessage.trim() && !isSendingImage) || isRecording || !!pendingAttachment}
              aria-label="Send message"
              title="Send message"
              className="btn-primary flex h-12 w-12 shrink-0 items-center justify-center"
            >
              <Send size={19} />
            </button>
          </div>
        </div>

        {/* Action Confirmation */}
        <AnimatePresence>
          {viewingImage && (
            <ImageViewer url={viewingImage} onClose={() => setViewingImage(null)} />
          )}
        </AnimatePresence>
        <AnimatePresence>
          {pendingAttachment && (
            <>
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setPendingAttachment(null)}
                style={{ zIndex: "var(--z-backdrop)" }} className="fixed inset-0 bg-black/85"
              />
              <motion.div
                initial={{ scale: 0.9, opacity: 0, y: 20 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.9, opacity: 0, y: 20 }}
                style={{ zIndex: "var(--z-modal)" }} className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[calc(100%-2rem)] max-w-sm max-h-[90dvh] overflow-y-auto glass rounded-3xl p-6 space-y-5"
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-semibold text-white">Preview</h3>
                  <button onClick={() => setPendingAttachment(null)} className="text-subtle hover:text-fg transition-colors">
                    <X size={20} />
                  </button>
                </div>

                <div className="bg-black/40 rounded-3xl overflow-hidden min-h-[160px] flex items-center justify-center p-6 border border-line">
                  {pendingAttachment.type === 'image' && pendingAttachment.url ? (
                    <img src={pendingAttachment.url} alt="Selection" className="max-h-60 rounded-2xl shadow-xl" loading="lazy" decoding="async" />
                  ) : pendingAttachment.type === 'voice' ? (
                    <VoiceMessage url={pendingAttachment.url} isMe={true} />
                  ) : (
                    <div className="text-subtle uppercase font-black text-xs tracking-widest">Invalid Attachment</div>
                  )}
                </div>

                <div className="flex flex-col gap-3">
                  <button 
                    onClick={confirmAndSendAttachment}
                    disabled={isSubmitting}
                    className="w-full py-5 bg-accent text-white text-xs font-black rounded-full tracking-[0.3em] shadow-lg active:scale-95 transition-colors flex items-center justify-center gap-3 uppercase"
                  >
                    {isSubmitting ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                    Confirm & Send
                  </button>
                  <button 
                    onClick={() => setPendingAttachment(null)}
                    disabled={isSubmitting}
                    className="w-full py-5 bg-surface-2 text-muted text-xs font-black rounded-full tracking-[0.3em] hover:bg-surface-3 transition-colors uppercase"
                  >
                    Discard
                  </button>
                </div>
              </motion.div>
            </>
          )}

          {confirmDelete && (
            <ConfirmDialog
              title="Delete this message?"
              description="It will be removed for everyone in this conversation."
              confirmLabel="Delete message"
              destructive
              icon={<Trash2 size={26} />}
              onConfirm={() => handleDeleteMessage(confirmDelete)}
              onCancel={() => setConfirmDelete(null)}
            />
          )}

          {/* Deleting a whole conversation always goes through this step. */}
          {confirmDeleteChat && (
            <ConfirmDialog
              title={isGroup ? 'Leave this group?' : 'Delete this conversation?'}
              description={
                isGroup
                  ? "You'll stop receiving messages from this group, and the other members will be told you left."
                  : 'Every message in this chat will be permanently deleted. This cannot be undone.'
              }
              confirmLabel={
                isSubmitting
                  ? isGroup ? 'Leaving…' : 'Deleting…'
                  : isGroup ? 'Leave group' : 'Delete conversation'
              }
              destructive
              busy={isSubmitting}
              icon={isGroup ? <LogOut size={26} /> : <Trash2 size={26} />}
              onConfirm={isGroup ? handleLeaveGroup : handleDeleteChat}
              onCancel={() => setConfirmDeleteChat(false)}
            />
          )}
        </AnimatePresence>
      </motion.div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1">
          {onBack && (
            <button
              onClick={onBack}
              aria-label="Back to feed"
              className="tap -ml-2 rounded-full text-muted transition-colors duration-100 hover:text-fg sm:hidden"
            >
              <ChevronLeft size={22} />
            </button>
          )}
          <h1 className="truncate text-2xl font-bold tracking-tight text-fg">Messages</h1>
        </div>

        {/* Both actions carry a visible text label — the two bare icons were
            indistinguishable without one. */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowAddModal(true)}
            title="Start a new direct message"
            className="press flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors duration-100 hover:bg-accent-deep"
          >
            <MessageSquare size={16} />
            New chat
          </button>
          <button
            onClick={() => setShowCreateGroupModal(true)}
            title="Create a group conversation"
            className="press flex items-center gap-2 rounded-full border border-line bg-surface-2 px-4 py-2 text-sm font-semibold text-fg transition-colors duration-100 hover:bg-surface-3"
          >
            <Users size={16} />
            New group
          </button>
        </div>
      </header>

      <div className="space-y-3">
        {loading ? (
          <>
            <RowSkeleton />
            <RowSkeleton />
            <RowSkeleton />
            <RowSkeleton />
          </>
        ) : conversations.length > 0 ? (
          conversations.map((chatItem: Chat) => (
            <ConversationItem
              key={chatItem.id}
              currentUser={user}
              chat={chatItem}
              onClick={() => setSelectedChat(chatItem)}
            />
          ))
        ) : (
          <div className="flex flex-col items-center gap-3 py-20 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-surface-2 text-muted">
              <MessageSquare size={26} />
            </div>
            <p className="text-base font-semibold text-fg">No messages yet</p>
            <p className="max-w-xs text-sm leading-relaxed text-muted">
              Start a conversation and it will appear here.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => setShowAddModal(true)}
                className="btn-primary px-5 py-2.5 text-sm"
              >
                New chat
              </button>
              <button
                onClick={() => setShowCreateGroupModal(true)}
                className="btn-secondary px-5 py-2.5 text-sm"
              >
                New group
              </button>
            </div>
          </div>
        )}
      </div>

      <AnimatePresence>
        {showCreateGroupModal && (
          <CreateGroupModal 
            user={user}
            onClose={() => setShowCreateGroupModal(false)}
            onCreated={(chat) => {
              setSelectedChat(chat);
              setShowCreateGroupModal(false);
            }}
          />
        )}
      </AnimatePresence>

      {/* Add User Modal */}
      <AnimatePresence>
        {showAddModal && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowAddModal(false)}
              style={{ zIndex: "var(--z-backdrop)" }} className="fixed inset-0 bg-black/85"
            />
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              style={{ zIndex: "var(--z-modal)" }} className="fixed inset-x-0 bottom-0 max-h-[90dvh] h-[60dvh] glass rounded-t-3xl p-6 flex flex-col sm:inset-x-auto sm:left-1/2 sm:top-1/2 sm:bottom-auto sm:w-full sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-3xl"
            >
              <div className="flex items-center justify-between mb-8">
                <h2 className="text-lg font-bold text-fg">New conversation</h2>
                <button 
                  onClick={() => {
                    setShowAddModal(false);
                    setSearchQuery('');
                    setFoundUser(null);
                    setSearchError('');
                  }}
                  className="w-10 h-10 rounded-full bg-surface-2 border border-line flex items-center justify-center text-muted"
                >
                  <X size={18} />
                </button>
              </div>

              <form onSubmit={handleSearchUser} className="relative mb-8">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Username or email"
                  className="field pr-12"
                />
                <button 
                  type="submit"
                  disabled={isSearching}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-accent disabled:opacity-50"
                >
                  <Search size={20} />
                </button>
              </form>

              <div className="min-h-0 flex-1 overflow-y-auto space-y-4 pr-1 scrollbar-hide">
                {isSearching ? (
                  <div className="space-y-3"><RowSkeleton /><RowSkeleton /></div>
                ) : foundUser ? (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="p-4 rounded-3xl bg-accent/10 border border-accent/20 flex items-center gap-4"
                  >
                    <Avatar user={foundUser} size="lg" />
                    <div className="flex-1 min-w-0 text-left">
                      <h4 className="truncate text-[15px] font-semibold text-fg">{foundUser.displayName}</h4>
                      <p className="truncate text-sm text-muted">@{foundUser.username}</p>
                    </div>
                    <button 
                      onClick={() => (selectedChat?.type === 'group') ? handleAddMember(foundUser) : handleStartDirectChat(foundUser)}
                      className="w-12 h-12 rounded-2xl bg-accent flex items-center justify-center text-white shadow-lg active:scale-90 transition-transform"
                    >
                      <UserPlus size={20} />
                    </button>
                  </motion.div>
                ) : (
                  <>
                    <div className="px-1 mb-2 flex items-center justify-between">
                      <span className="text-sm font-semibold text-muted">People you follow</span>
                      {loadingFollowed && <Loader2 size={12} className="animate-spin text-subtle" />}
                    </div>
                    
                    <div className="space-y-3">
                      {followedUsers.length > 0 ? (
                        followedUsers.map((u) => (
                          <button 
                            key={u.uid}
                            onClick={() => (selectedChat?.type === 'group') ? handleAddMember(u) : handleStartDirectChat(u)}
                            className="w-full p-4 rounded-2xl bg-surface-2 border border-line flex items-center gap-4 hover:bg-surface-3 hover:border-line transition-colors text-left group"
                          >
                            <Avatar user={u} size="md" />
                            <div className="flex-1 min-w-0">
                              <h4 className="truncate text-[15px] font-semibold text-fg">{u.displayName}</h4>
                              <p className="truncate text-sm text-muted">@{u.username}</p>
                            </div>
                            <div className="w-8 h-8 rounded-xl bg-surface-2 flex items-center justify-center text-subtle group-hover:bg-accent-deep group-hover:text-fg transition-colors">
                              <MessageSquare size={14} />
                            </div>
                          </button>
                        ))
                      ) : !loadingFollowed && !searchError && (
                        <div className="py-12 text-center text-muted">
                          <Users size={32} className="mx-auto mb-3" />
                          <p className="mx-auto max-w-xs text-sm leading-relaxed text-muted">Search for someone by username or email to start a conversation.</p>
                        </div>
                      )}

                      {searchError && (
                        <div className="px-6 py-8 text-center text-sm leading-relaxed text-danger">
                          {searchError}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
