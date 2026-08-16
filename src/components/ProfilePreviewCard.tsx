import React, { useEffect, useState } from 'react';
import { users as usersApi, follows as followsApi } from '../lib/db';
import { User } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import { X, User as UserIcon, Check, Loader2, AtSign } from 'lucide-react';
import { cn } from '../lib/utils';
import { StatusIndicator } from './StatusIndicator';

interface ProfilePreviewCardProps {
  userId: string;
  currentUser: User;
  onClose: () => void;
  onViewProfile: (uid: string) => void;
}

export function ProfilePreviewCard({ userId, currentUser, onClose, onViewProfile }: ProfilePreviewCardProps) {
  const [profile, setProfile] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isFollowing, setIsFollowing] = useState(false);
  const [followingLoading, setFollowingLoading] = useState(false);

  useEffect(() => {
    const fetchProfile = async () => {
      try {
        const [found, following] = await Promise.all([
          usersApi.get(userId),
          followsApi.isFollowing(currentUser.uid, userId),
        ]);
        if (found) {
          setProfile(found);
          setIsFollowing(following);
        }
      } catch (err) {
        console.error('Error fetching profile preview:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchProfile();
  }, [userId, currentUser.uid]);

  const handleFollowToggle = async () => {
    if (!profile || followingLoading) return;
    setFollowingLoading(true);
    try {
      if (isFollowing) {
        await followsApi.unfollow(currentUser.uid, userId);
        setIsFollowing(false);
      } else {
        // follow() is idempotent and raises the notification itself.
        await followsApi.follow(currentUser.uid, userId);

        const { sendPushNotification } = await import('../lib/sendPush');
        sendPushNotification(
          userId,
          'New Follower',
          `${currentUser.displayName} started following you`,
          `/profile?id=${currentUser.uid}`
        );

        setIsFollowing(true);
      }
    } catch (err) {
      console.error('Error toggling follow in preview:', err);
    } finally {
      setFollowingLoading(false);
    }
  };

  return (
    <div style={{ zIndex: "var(--z-backdrop)" }} className="fixed inset-0 flex items-center justify-center p-6">
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="absolute inset-0 bg-black/85"
      />
      
      <motion.div
        initial={{ scale: 0.9, opacity: 0, y: 10 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.9, opacity: 0, y: 10 }}
        className="w-full max-w-[320px] glass border border-line rounded-3xl p-6 shadow-2xl relative overflow-hidden"
      >
        <button 
          onClick={onClose}
          className="absolute top-4 right-4 w-9 h-9 rounded-full bg-surface-2 border border-line flex items-center justify-center text-muted hover:text-fg transition-colors"
        >
          <X size={18} />
        </button>

        {loading ? (
          <div className="py-16 flex flex-col items-center gap-4">
             <Loader2 size={24} className="text-accent animate-spin" />
             <p className="text-xs font-black uppercase tracking-widest text-subtle">Identifying User...</p>
          </div>
        ) : profile ? (
          <div className="flex flex-col items-center">
            <div className="relative mb-5">
              <div className="w-24 h-24 rounded-full border-2 border-line p-1 shadow-2xl">
                <div className="w-full h-full rounded-full bg-surface-2 overflow-hidden relative">
                  {profile.photoURL ? (
                    <img src={profile.photoURL} alt="" className="w-full h-full object-cover" loading="lazy" decoding="async" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-subtle">
                      <UserIcon size={32} />
                    </div>
                  )}
                </div>
              </div>
              <div className="absolute -bottom-1 -right-1">
                <StatusIndicator user={profile} size="sm" className="border-4 border-bg" />
              </div>
            </div>

            <div className="text-center mb-8">
              <h3 className="text-lg font-bold tracking-tight text-white">{profile.displayName}</h3>
              <div className="flex items-center justify-center gap-1 mt-0.5">
                <AtSign size={9} className="text-accent" />
                <p className="text-xs text-accent font-bold uppercase tracking-widest">@{profile.username}</p>
              </div>
              {profile.bio && (
                <p className="text-sm text-muted mt-3 leading-relaxed line-clamp-2 px-2 italic">
                  "{profile.bio}"
                </p>
              )}
            </div>

            <div className="flex flex-col w-full gap-2.5">
              {userId !== currentUser.uid && (
                <button 
                  onClick={handleFollowToggle}
                  disabled={followingLoading}
                  className={cn(
                    "w-full py-3.5 rounded-full text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-colors active:scale-95",
                    isFollowing 
                      ? "bg-surface-2 border border-line text-muted" 
                      : "bg-accent text-white shadow-lg"
                  )}
                >
                  {followingLoading ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : isFollowing ? (
                    <>
                      <Check size={12} />
                      FOLLOWED
                    </>
                  ) : (
                    'Follow'
                  )}
                </button>
              )}

              <button 
                onClick={() => {
                  onViewProfile(userId);
                  onClose();
                }}
                className="w-full py-3.5 bg-surface-2 border border-line text-white text-xs font-black rounded-full tracking-widest uppercase hover:bg-surface-2 transition-colors text-center"
              >
                View Full Profile
              </button>
            </div>
          </div>
        ) : (
          <div className="py-16 flex flex-col items-center gap-4 text-center">
             <div className="w-14 h-14 rounded-full bg-danger/10 flex items-center justify-center text-danger mb-2">
               <X size={28} />
             </div>
             <h3 className="text-md font-bold tracking-tight text-white">Not Found</h3>
             <p className="text-xs font-black uppercase tracking-widest text-subtle">The scanned identity does not exist.</p>
          </div>
        )}
      </motion.div>
    </div>
  );
}
