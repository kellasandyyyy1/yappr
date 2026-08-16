import React, { useState, useEffect } from 'react';
import { notifications as notificationsApi } from '../lib/db';
import { User, Notification } from '../types';
import { Heart, MessageCircle, UserPlus, CheckCircle2, Bell, ChevronLeft, Smile, AtSign } from 'lucide-react';
import { formatTimeAgo, cn } from '../lib/utils';
import { Avatar } from './Avatar';
import { NotificationSkeleton } from './Skeleton';

interface NotificationsViewProps {
  user: User;
  onProfileClick: () => void;
  onUserClick?: (uid: string) => void;
  onPostClick?: (postId: string) => void;
  onBack?: () => void;
}

export function NotificationsView({ user, onProfileClick, onUserClick, onPostClick, onBack }: NotificationsViewProps) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  const handleNotificationClick = (notif: Notification) => {
    markAsRead(notif.id);
    if (onPostClick && notif.referenceId && ['like', 'comment', 'mention', 'reaction'].includes(notif.type)) {
      onPostClick(notif.referenceId);
    } else if (onUserClick) {
      onUserClick(notif.fromUserId);
    }
  };

  // Periodic tick to refresh "X mins ago" labels
  useEffect(() => {
    const interval = setInterval(() => {
      setTick(t => t + 1);
    }, 30000); // Every 30 seconds
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        // Actors arrive on the join. Firestore issued a getDoc per distinct
        // sender on every snapshot, including ones already on screen.
        const list = await notificationsApi.list(user.uid);
        if (cancelled) return;
        // Message notifications belong to the chat badge, not this list.
        setNotifications(list.filter(n => n.type !== 'message'));
      } catch (error) {
        console.error('Error loading notifications:', error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    const unsubscribe = notificationsApi.subscribe(user.uid, load);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [user.uid]);

  const markAsRead = async (id: string) => {
    setNotifications(prev => prev.map(n => (n.id === id ? { ...n, isRead: true } : n)));
    try {
      await notificationsApi.markRead(id);
    } catch (err) {
      console.error(err);
    }
  };

  const markAllRead = async () => {
    if (notifications.length === 0) return;
    setNotifications(prev => prev.map(n => ({ ...n, isRead: true })));
    try {
      // One indexed UPDATE, not one write per unread row.
      await notificationsApi.markAllRead(user.uid);
    } catch (err) {
      console.error(err);
    }
  };

  // Likes keep their red heart (it reads as the like action itself, not as a
  // second accent); everything else is the one blue accent.
  const icons: Record<string, React.ReactNode> = {
    like: <Heart className="text-danger" size={15} fill="currentColor" />,
    comment: <MessageCircle className="text-accent" size={15} />,
    follow: <UserPlus className="text-accent" size={15} />,
    message: <MessageCircle className="text-accent" size={15} />,
    reaction: <Smile className="text-accent" size={15} />,
    mention: <AtSign className="text-accent" size={15} />,
  };

  const getNotificationLabel = (notif: Notification) => {
    switch (notif.type) {
      case 'like': return 'liked your post';
      case 'follow': return 'started following you';
      case 'message': return 'sent you a message';
      case 'reaction': return `reacted ${notif.content || ''} to your post`;
      case 'mention': return 'mentioned you in a post';
      case 'comment':
        if (notif.subType === 'voice') return 'sent a voice note on your post';
        if (notif.subType === 'image') return 'shared an image on your post';
        return `commented: ${notif.content || 'on your post'}`;
      default: return 'interacted with you';
    }
  };

  const unreadCount = notifications.filter((n) => !n.isRead).length;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2">
          {onBack && (
            <button
              onClick={onBack}
              aria-label="Back to feed"
              className="tap -ml-2 rounded-full text-muted transition-colors duration-100 hover:text-fg sm:hidden"
            >
              <ChevronLeft size={22} />
            </button>
          )}
          <h1 className="truncate text-2xl font-bold tracking-tight text-fg">Notifications</h1>
        </div>

        <button
          onClick={markAllRead}
          disabled={unreadCount === 0}
          className="press flex shrink-0 items-center gap-2 rounded-full border border-line bg-surface-2 px-4 py-2 text-sm font-semibold text-accent transition-colors duration-100 hover:bg-surface-3 disabled:opacity-50"
        >
          <CheckCircle2 size={16} />
          <span className="hidden sm:inline">Mark all read</span>
        </button>
      </header>

      <div className="space-y-3">
        {loading ? (
          <>
            <NotificationSkeleton />
            <NotificationSkeleton />
            <NotificationSkeleton />
            <NotificationSkeleton />
          </>
        ) : notifications.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-20 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-surface-2 text-muted">
              <Bell size={26} />
            </div>
            <p className="text-base font-semibold text-fg">No notifications yet</p>
            <p className="max-w-xs text-sm leading-relaxed text-muted">
              Likes, comments and new followers will show up here.
            </p>
          </div>
        ) : (
          notifications.map((notif) => (
            <div
              key={notif.id}
              role="button"
              tabIndex={0}
              onClick={() => handleNotificationClick(notif)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleNotificationClick(notif);
                }
              }}
              className={cn(
                'flex cursor-pointer items-center gap-3 rounded-2xl border p-4',
                'transition-colors duration-100 hover:bg-surface-2',
                notif.isRead ? 'border-line bg-surface' : 'border-accent/30 bg-accent/8'
              )}
            >
              <div className="relative shrink-0">
                <Avatar user={notif.fromUser} size="lg" />
                <span
                  className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full border border-line bg-bg"
                >
                  {icons[notif.type]}
                </span>
              </div>

              <div className="min-w-0 flex-1">
                <p className="text-sm leading-snug text-muted">
                  <button
                    className="font-semibold text-fg transition-colors duration-100 hover:text-accent"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (onUserClick) onUserClick(notif.fromUserId);
                    }}
                  >
                    {notif.fromUser?.displayName ?? 'Someone'}
                  </button>{' '}
                  {getNotificationLabel(notif)}
                </p>
                <p className="mt-1 text-sm text-subtle">{formatTimeAgo(notif.createdAt)}</p>
              </div>

              {!notif.isRead && (
                <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-accent" aria-label="Unread" />
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
