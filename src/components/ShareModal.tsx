import React, { useState, useEffect } from 'react';
import { Download, Send, Search, Loader2, Check, Users } from 'lucide-react';
import { Avatar } from './Avatar';
import { Modal, ModalHeader, ModalBody, ModalFooter } from './Modal';
import { User, Post, Chat } from '../types';
import { chats as chatsApi, notifications as notificationsApi } from '../lib/db';
import { cn } from '../lib/utils';
import { toPng } from 'html-to-image';
import confetti from 'canvas-confetti';
import { useToast } from './ToastContext';
import { RowSkeleton } from './Skeleton';

interface ShareModalProps {
  post: Post;
  currentUser: User;
  onClose: () => void;
}

export function ShareModal({ post, currentUser, onClose }: ShareModalProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [recentChats, setRecentChats] = useState<Chat[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [shared, setShared] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    const fetchRecentChats = async () => {
      try {
        // Membership is enforced by RLS rather than an array-contains filter,
        // and members come back on the join — so the per-chat lookup for the
        // other person's name and photo below is gone entirely.
        setRecentChats(await chatsApi.list(currentUser.uid));
      } catch (err) {
        console.error('Error fetching recent chats:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchRecentChats();
  }, [currentUser.uid]);

  const handleDownload = async () => {
    const postElement = document.getElementById(`post-${post.id}`);
    if (!postElement) {
      console.error(`Post element not found: post-${post.id}`);
      return;
    }

    setDownloading(true);
    try {
      // Use a small delay to ensure all animations are settled
      await new Promise(resolve => setTimeout(resolve, 100));

      const dataUrl = await toPng(postElement, {
        cacheBust: true,
        backgroundColor: '#050507',
        pixelRatio: 3, // Even higher quality
        style: {
          borderRadius: '40px',
          margin: '0',
          padding: '32px', // Ensure padding is preserved
        },
        // Filter out buttons or other things we don't want in the screenshot if needed
        filter: (node: any) => {
          if (node.tagName === 'BUTTON' && node.innerText === '') return false; // Skip empty icon buttons
          return true;
        }
      });
      
      if (!dataUrl) throw new Error('Failed to generate image data');
      
      const link = document.createElement('a');
      link.download = `sobrang_post_${post.id.substring(0, 5)}.png`;
      link.href = dataUrl;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      confetti({
        particleCount: 150,
        spread: 100,
        origin: { y: 0.6 },
        colors: ['#3b82f6', '#60a5fa', '#ffffff']
      });
      toast('Post saved to gallery', 'success');
    } catch (err) {
      console.error('Error downloading post:', err);
      toast('Failed to save post', 'error');
      // Fallback alert for the user if it's a CORS issue
      if (err instanceof Error && err.message.includes('CORS')) {
        alert('Some images could not be loaded due to security restrictions. Try again in a few seconds.');
      }
    } finally {
      setDownloading(false);
    }
  };

  const shareToChat = async (targetChat: Chat) => {
    try {
      const content = `Shared a post: ${post.content.substring(0, 50)}${post.content.length > 50 ? '...' : ''}`;

      // One insert. The touch_conversation trigger reorders the inbox and
      // fan_out_message_receipts creates the pending receipts — both were
      // separate client writes that could fail independently and leave the
      // conversation showing a stale last message.
      await chatsApi.send({
        conversationId: targetChat.id,
        senderId: currentUser.uid,
        content,
        type: 'post',
        sharedPostId: post.id,
      });

      const others = targetChat.participants.filter(id => id !== currentUser.uid);
      await Promise.all(
        others.map(uid =>
          notificationsApi.create({
            recipientId: uid,
            actorId: currentUser.uid,
            type: 'message',
            conversationId: targetChat.id,
            content: targetChat.type === 'group'
              ? `Shared a post in ${targetChat.name}`
              : 'Shared a post with you',
          })
        )
      );

      setShared(prev => new Set(prev).add(targetChat.id));
      return true;
    } catch (err) {
      console.error('Error sharing post in chat:', err);
      return false;
    }
  };

  /** Sends to every selected conversation, then reports once. */
  const handleSendToSelected = async () => {
    const targets = recentChats.filter(c => selected.has(c.id));
    if (targets.length === 0 || sending) return;

    setSending(true);
    try {
      const results = await Promise.all(targets.map(shareToChat));
      const sent = results.filter(Boolean).length;
      const failed = results.length - sent;

      if (sent > 0) {
        toast(
          sent === 1
            ? `Sent to ${chatNames[targets[0].id] || 'chat'}`
            : `Sent to ${sent} conversations`,
          'success'
        );
      }
      if (failed > 0) toast(`${failed} didn't send`, 'error');

      setSelected(new Set());
    } finally {
      setSending(false);
    }
  };

  const toggleSelected = (chatId: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(chatId) ? next.delete(chatId) : next.add(chatId);
      return next;
    });
  };

  // Derived, not fetched. mapConversation already resolved `otherUser` from the
  // members join, so what used to be an async effect firing a getDoc per direct
  // chat — and re-rendering each time one landed — is now two plain maps.
  const chatNames = React.useMemo(() => {
    const out: Record<string, string> = {};
    for (const chat of recentChats) {
      out[chat.id] = chat.type === 'direct'
        ? (chat as Chat & { otherUser?: User }).otherUser?.displayName ?? 'Unknown'
        : chat.name || 'Group Chat';
    }
    return out;
  }, [recentChats]);

  const chatPhotos = React.useMemo(() => {
    const out: Record<string, string> = {};
    for (const chat of recentChats) {
      out[chat.id] = (chat.type === 'direct'
        ? (chat as Chat & { otherUser?: User }).otherUser?.photoURL
        : chat.photoURL) || '';
    }
    return out;
  }, [recentChats]);

  const filteredChats = recentChats.filter(c => 
    (chatNames[c.id] || '').toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <Modal onClose={onClose} size="md" labelledBy="share-post-title">
      <ModalHeader title="Share post" onClose={onClose} id="share-post-title" />

      <div className="shrink-0 border-b border-line px-5 py-3 sm:px-6">
        <div className="relative">
          <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search conversations"
            aria-label="Search conversations"
            className="field pl-11"
          />
        </div>
      </div>

      <ModalBody className="space-y-2">
        {loading ? (
          <div className="space-y-3">
            <RowSkeleton />
            <RowSkeleton />
            <RowSkeleton />
          </div>
        ) : filteredChats.length > 0 ? (
          filteredChats.map((chat) => {
            const isSelected = selected.has(chat.id);
            const wasSent = shared.has(chat.id);

            return (
              <button
                key={chat.id}
                onClick={() => toggleSelected(chat.id)}
                disabled={wasSent}
                aria-pressed={isSelected}
                className={cn(
                  'flex w-full items-center gap-3 rounded-2xl border p-3 text-left transition-colors duration-100',
                  wasSent
                    ? 'border-line bg-surface-2 opacity-60'
                    : isSelected
                      ? 'border-accent/50 bg-accent/10'
                      : 'border-line bg-surface-2 hover:bg-surface-3'
                )}
              >
                <Avatar
                  size="lg"
                  src={chatPhotos[chat.id]}
                  name={chatNames[chat.id]}
                  fallbackIcon={chat.type === 'group' ? <Users size={18} /> : undefined}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] font-semibold text-fg">
                    {chatNames[chat.id] || 'Loading…'}
                  </div>
                  <div className="truncate text-sm text-muted">
                    {chat.type === 'group'
                      ? `${chat.participants.length} members`
                      : 'Direct message'}
                  </div>
                </div>

                {/* Inline confirmation stays on the row after sending. */}
                {wasSent ? (
                  <span className="flex shrink-0 items-center gap-1.5 text-sm font-semibold text-accent">
                    <Check size={16} />
                    Sent
                  </span>
                ) : (
                  <span
                    className={cn(
                      'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors duration-100',
                      isSelected ? 'border-accent bg-accent text-white' : 'border-line-strong text-transparent'
                    )}
                  >
                    <Check size={14} />
                  </span>
                )}
              </button>
            );
          })
        ) : (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <Search size={30} className="text-muted" />
            <p className="text-sm text-muted">
              {searchTerm ? 'No conversations match that search.' : 'No conversations yet.'}
            </p>
          </div>
        )}
      </ModalBody>

      <ModalFooter className="space-y-2">
        <button
          onClick={handleSendToSelected}
          disabled={selected.size === 0 || sending}
          className="btn-primary flex h-12 w-full items-center justify-center gap-2 text-sm"
        >
          {sending ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              Sending…
            </>
          ) : (
            <>
              <Send size={16} />
              {selected.size > 0
                ? `Send to ${selected.size} ${selected.size === 1 ? 'conversation' : 'conversations'}`
                : 'Send'}
            </>
          )}
        </button>

        {/* Secondary path — same visual weight as a row, below the list. */}
        <button
          onClick={handleDownload}
          disabled={downloading}
          className="btn-secondary flex h-11 w-full items-center justify-center gap-2 text-sm"
        >
          {downloading ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
          Save image to device
        </button>
      </ModalFooter>
    </Modal>
  );
}
