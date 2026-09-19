import React, { useState, useEffect, useRef } from 'react';
import {
  users as usersApi,
  posts as postsApi,
  likes as likesApi,
  follows as followsApi,
  songs as songsApi,
} from '../lib/db';
import { uploadFile, UploadError } from '../lib/supabase';
import { User, Post } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import { LogOut, Grid, List, Layers, AtSign, X, Trash2, Camera, User as UserIcon, AlignLeft, Loader2, ChevronLeft, ChevronRight, Heart, MessageCircle, QrCode, Download, Share2, Music, Plus } from './icons';
import { cn, formatTimeAgo, describeError } from '../lib/utils';
import { UsersListModal } from './UsersListModal';
import { Avatar } from './Avatar';
import { Skeleton, GridSkeleton } from './Skeleton';
import { Modal, ModalHeader, ModalBody, ModalFooter, ConfirmDialog } from './Modal';
import { useToast } from './ToastContext';
import { QRCodeSVG } from 'qrcode.react';
import { toPng } from 'html-to-image';
import confetti from 'canvas-confetti';
import { ThemeSongCard } from './ThemeSongCard';
import { ThemeSongSearch } from './ThemeSongSearch';
import { ThemeSong } from '../types';
import { buildProfileQr } from '../lib/brand';

interface ProfileViewProps {
  user: User; // Current logged in user
  profileUserId?: string; // ID of the user whose profile we want to view (if different from logged in user)
  onLogout: () => void;
  onBack?: () => void;
  onUserClick?: (uid: string) => void;
  onChatClick?: (uid: string) => void;
  onShowComments?: (postId: string, postUserId: string) => void;
  onEditingChange?: (isEditing: boolean) => void;
}

export function ProfileView({ user: currentUser, profileUserId, onLogout, onBack, onUserClick, onChatClick, onShowComments, onEditingChange }: ProfileViewProps) {
  const [profileUser, setProfileUser] = useState<User | null>(null);
  const [userPosts, setUserPosts] = useState<Post[]>([]);
  const [userLikes, setUserLikes] = useState<Set<string>>(new Set());
  const [fanCount, setFanCount] = useState(0);
  const [circleCount, setCircleCount] = useState(0);
  const [isFollowing, setIsFollowing] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [showQrCode, setShowQrCode] = useState(false);
  const [showMusicSearch, setShowMusicSearch] = useState(false);
  const [editForm, setEditForm] = useState({
    displayName: '',
    bio: '',
    photoURL: '',
    themeSong: undefined as ThemeSong | undefined
  });
  const [isSaving, setIsSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [showUsersModal, setShowUsersModal] = useState<{ title: string; type: 'followers' | 'following' } | null>(null);
  const [viewingPost, setViewingPost] = useState<Post | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [postsLoading, setPostsLoading] = useState(true);

  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [isDownloadingQR, setIsDownloadingQR] = useState(false);
  const [isSharingQR, setIsSharingQR] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const qrCardRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  const recordListenedMusic = async (song: ThemeSong) => {
    try {
      // Firestore copied the whole track into every history row. Now the song
      // is a shared row and history just points at it.
      await songsApi.recordPlay(currentUser.uid, song, 'listened');
    } catch (err) {
      console.error('Error recording listening history:', err);
    }
  };

  const isOwnProfile = !profileUserId || profileUserId === currentUser.uid;
  const targetUserId = profileUserId || currentUser.uid;

  useEffect(() => {
    const isAnyModalOpen = isEditing || !!showUsersModal || !!confirmDelete || !!viewingPost || showMusicSearch;
    onEditingChange?.(isAnyModalOpen);
    return () => onEditingChange?.(false);
  }, [isEditing, showUsersModal, confirmDelete, viewingPost, showMusicSearch, onEditingChange]);

  // Fetch profile user if it's not the current user
  useEffect(() => {
    if (isOwnProfile) {
      setProfileUser(currentUser);
      setEditForm({
        displayName: currentUser.displayName,
        bio: currentUser.bio || '',
        photoURL: currentUser.photoURL || '',
        themeSong: currentUser.themeSong
      });
    } else {
      const fetchProfileUser = async () => {
        try {
          const found = await usersApi.get(targetUserId);
          if (found) setProfileUser(found);
        } catch (err) {
          console.error('Error fetching profile user:', err);
        }
      };
      fetchProfileUser();
    }
  }, [currentUser, profileUserId, isOwnProfile, targetUserId]);

  useEffect(() => {
    let cancelled = false;

    // No client-side visibility filter any more. `posts_select_visible` decides
    // what comes back, so a "followers only" post is not merely hidden — it is
    // never sent to a non-follower.
    const loadPosts = async () => {
      try {
        const list = await postsApi.byUser(targetUserId);
        if (!cancelled) setUserPosts(list);
      } catch (err) {
        console.error('Error loading posts:', err);
      } finally {
        if (!cancelled) setPostsLoading(false);
      }
    };

    setPostsLoading(true);
    loadPosts();
    const unsubscribe = postsApi.subscribeByUser(targetUserId, loadPosts);

    const fetchData = async () => {
      try {
        const [counts, following, liked] = await Promise.all([
          followsApi.counts(targetUserId),
          isOwnProfile ? Promise.resolve(false)
                       : followsApi.isFollowing(currentUser.uid, targetUserId),
          likesApi.byUser(currentUser.uid),
        ]);
        if (cancelled) return;
        setFanCount(counts.followers);
        setCircleCount(counts.following);
        setIsFollowing(following);
        setUserLikes(liked);
      } catch (err) {
        console.error('Error fetching data:', err);
      }
    };
    fetchData();

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [targetUserId, currentUser.uid, isOwnProfile]);

  useEffect(() => {
    if (!isEditing && isOwnProfile) {
      setEditForm({
        displayName: currentUser.displayName,
        bio: currentUser.bio || '',
        photoURL: currentUser.photoURL || '',
        themeSong: currentUser.themeSong
      });
    }
  }, [currentUser, isEditing, isOwnProfile]);

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedImage(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setImagePreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isOwnProfile) return;
    setIsSaving(true);
    try {
      let photoURL = editForm.photoURL;

      if (selectedImage) {
        // Cache-busted path: the avatar URL is public and stable, so reusing
        // `avatars/<uid>` left browsers showing the old image after a change.
        photoURL = await uploadFile(
          'avatars',
          `${currentUser.uid}/${Date.now()}`,
          selectedImage,
          selectedImage.type
        );
      }

      // The track becomes a shared `songs` row; the profile stores its id.
      const themeSongId = editForm.themeSong
        ? await songsApi.upsert(editForm.themeSong)
        : null;

      await usersApi.update(currentUser.uid, {
        displayName: editForm.displayName,
        bio: editForm.bio,
        photoURL,
        themeSongId,
      });
      setProfileUser(prev => prev && {
        ...prev,
        displayName: editForm.displayName,
        bio: editForm.bio,
        photoURL,
        themeSong: editForm.themeSong,
      });
      setIsEditing(false);
      setSelectedImage(null);
      setImagePreview(null);
      toast('Profile updated successfully', 'success');
    } catch (err) {
      toast(err instanceof UploadError ? err.message : 'Failed to update profile', 'error');
      console.error('Error updating profile:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeletePost = async (postId: string) => {
    if (!isOwnProfile) return;
    setIsDeleting(true);
    try {
      // Images, likes, comments and reactions go with it — foreign keys
      // cascade, where Firestore left every one of those orphaned.
      await postsApi.remove(postId);
      setConfirmDelete(null);
      if (viewingPost?.id === postId) setViewingPost(null);
      toast('Post deleted', 'info');
    } catch (err) {
      toast('Failed to delete post', 'error');
      console.error('Error deleting post:', err);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleMentionClick = async (username: string) => {
    try {
      const [target] = await usersApi.byUsernames([username]);
      if (target) onUserClick?.(target.uid);
    } catch (err) {
      console.error('Error fetching mentioned user:', err);
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

  const handleLikePost = async (postId: string, postUserId: string) => {
    const isLiked = userLikes.has(postId);

    setUserLikes(prev => {
      const next = new Set(prev);
      if (isLiked) next.delete(postId); else next.add(postId);
      return next;
    });
    setUserPosts(prev => prev.map(p => p.id === postId
      ? { ...p, likesCount: Math.max(0, (p.likesCount ?? 0) + (isLiked ? -1 : 1)) }
      : p));

    try {
      // No manual counter write: bump_post_likes_count owns likes_count, so it
      // can no longer drift when one of the two writes failed.
      if (isLiked) await likesApi.unlike(postId, currentUser.uid);
      else await likesApi.like(postId, currentUser.uid, postUserId);
    } catch (err) {
      console.error('Error toggling like:', err);
      setUserLikes(prev => {
        const next = new Set(prev);
        if (isLiked) next.add(postId); else next.delete(postId);
        return next;
      });
      setUserPosts(prev => prev.map(p => p.id === postId
        ? { ...p, likesCount: Math.max(0, (p.likesCount ?? 0) + (isLiked ? 1 : -1)) }
        : p));
    }
  };

  const handleDeleteAvatar = async () => {
    if (!isOwnProfile) return;
    setIsSaving(true);
    try {
      await usersApi.update(currentUser.uid, { photoURL: '' });
      setEditForm(prev => ({ ...prev, photoURL: '' }));
      setProfileUser(prev => prev && { ...prev, photoURL: '' });
      setImagePreview(null);
      setSelectedImage(null);
    } catch (err) {
      console.error('Error removing avatar:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleFollowToggle = async () => {
    if (isOwnProfile) return;
    const wasFollowing = isFollowing;

    setIsFollowing(!wasFollowing);
    setFanCount(prev => Math.max(0, prev + (wasFollowing ? -1 : 1)));

    try {
      if (wasFollowing) {
        await followsApi.unfollow(currentUser.uid, targetUserId);
        toast(`Unfollowed @${profileUser?.username}`, 'info');
      } else {
        // The composite primary key makes this idempotent, and follow() raises
        // the notification — a double-tap can no longer create two follow rows.
        await followsApi.follow(currentUser.uid, targetUserId);
        toast(`Following @${profileUser?.username}`, 'success');
      }
      // Following changes which posts RLS will hand over, so the grid has to be
      // refetched — the followers-only ones were never in the client to filter.
      setUserPosts(await postsApi.byUser(targetUserId));
    } catch (err) {
      setIsFollowing(wasFollowing);
      setFanCount(prev => Math.max(0, prev + (wasFollowing ? 1 : -1)));
      toast('Action failed', 'error');
      console.error('Error toggling follow:', err);
    }
  };

  const handleLogoutConfirm = () => {
    setShowLogoutConfirm(false);
    onLogout();
  };

  /**
   * A `data:` URL to a Blob, without fetch().
   *
   * `await fetch(dataUrl)` is the usual one-liner and it is what broke this:
   * the app's CSP sets `connect-src 'self' https://*.supabase.co …` with no
   * `data:` entry, so the browser blocks the request before it starts and the
   * share fails with a bare TypeError. Decoding the base64 by hand touches no
   * network layer, so no CSP directive applies — which is a better fix than
   * widening connect-src to allow `data:` for one button.
   */
  const dataUrlToBlob = (dataUrl: string): Blob => {
    const [header, encoded] = dataUrl.split(',');
    const mime = header.match(/:(.*?);/)?.[1] ?? 'image/png';
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  };

  /**
   * The QR card as a PNG data URL. Shared by saving and sharing, which
   * differ only in what they do with the bytes.
   */
  const renderQRCode = async (): Promise<string> => {
    if (!qrCardRef.current) throw new Error('QR card is not mounted');

    const options = {
      cacheBust: true,
      backgroundColor: '#0c0c10', // Match the card background
      style: {
        transform: 'scale(1)', // Ensure no transforms are active during capture
      },
    };

    // Rendered twice, deliberately. html-to-image inlines the avatar embedded
    // in the QR by loading it into the cloned DOM, and its first pass can
    // resolve before that image has decoded — which yields a truncated data
    // URL, or one with a hole where the avatar should be. The second pass runs
    // against a warm cache and is the one that is kept. It costs a few tens of
    // milliseconds and removes an intermittent failure that only ever showed
    // up on profiles that have a photo.
    await toPng(qrCardRef.current, options);
    const dataUrl = await toPng(qrCardRef.current, options);

    // A failed render does not always throw: it can hand back an empty string
    // or a header with no payload, which then fails much later and much less
    // helpfully — as a corrupt download, or an unreadable clipboard image.
    if (!dataUrl || dataUrl.length < 'data:image/png;base64,'.length + 1) {
      throw new Error('the image came back empty');
    }
    return dataUrl;
  };

  /**
   * Share the code itself, rather than a link to it.
   *
   * There is no profile URL in this app — the router serves three static paths
   * and nothing resolves a username — so a "copy link" would put a dead address
   * on someone's clipboard. The QR image IS the shareable artifact, so that is
   * what gets shared, and the desktop fallback copies the image rather than
   * inventing a URL. See the note in the handover if a real /u/<username>
   * route is wanted later.
   *
   * Three tiers, narrowing as support drops away:
   *   1. navigator.share with the file — the native sheet, phones and Safari
   *   2. the clipboard, as an image — Chrome, Edge and Safari on desktop
   *   3. a download, which is the Save button's job and always works
   */
  const shareQRCode = async () => {
    if (!profileUser) return;
    setIsSharingQR(true);
    try {
      const dataUrl = await renderQRCode();
      const blob = dataUrlToBlob(dataUrl);
      const file = new File([blob], `yappr-${profileUser.username}.png`, { type: 'image/png' });
      const text = `Scan this to follow @${profileUser.username} on Yappr`;

      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: `@${profileUser.username} on Yappr`, text });
        return;
      }

      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        toast('QR code copied — paste it anywhere', 'success');
        return;
      }

      await downloadQRCode();
      toast('Sharing is not available here, so it saved instead', 'success');
    } catch (err) {
      // Dismissing the share sheet rejects with AbortError. That is a choice,
      // not a failure, and must not raise an error toast.
      if ((err as Error)?.name === 'AbortError') return;
      // NotAllowedError from the clipboard means the tab lost focus between
      // the click and the write — worth saying, because retrying works.
      console.error('Error sharing QR:', err);
      toast(
        (err as Error)?.name === 'NotAllowedError'
          ? 'Click the page, then try sharing again'
          : `Couldn't share the QR code — ${describeError(err)}`,
        'error'
      );
    } finally {
      setIsSharingQR(false);
    }
  };

  const downloadQRCode = async () => {
    if (!qrCardRef.current) return;

    setIsDownloadingQR(true);
    try {
      const dataUrl = await renderQRCode();

      // Downloaded from a blob: URL rather than the data: URL directly. A
      // data: href works for small images, but browsers cap how long a URL
      // may be and this one carries a whole PNG — a profile with a photo can
      // push it past the limit, at which point the click silently does
      // nothing. A blob: URL is a short handle to the same bytes.
      const url = URL.createObjectURL(dataUrlToBlob(dataUrl));
      const link = document.createElement("a");
      link.download = `yappr-id-${profileUser?.username || 'user'}.png`;
      link.href = url;
      link.click();
      // Revoked on the next tick: revoking synchronously can race the
      // browser's own read of the blob and produce a zero-byte file.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);

      toast('QR code saved', 'success');
      confetti({
        particleCount: 80,
        spread: 70,
        origin: { y: 0.6 },
        colors: ['#3b82f6', '#60a5fa', '#ffffff']
      });
    } catch (err) {
      console.error('Error downloading QR:', err);
      toast(`Couldn't save the QR code — ${describeError(err)}`, 'error');
    } finally {
      setIsDownloadingQR(false);
    }
  };

  if (!profileUser) {
    return (
      // Mirrors the real layout exactly — horizontal identity row, 80px
      // avatar, single-line stats. It previously drew the old 160px centred
      // avatar, so the page visibly jumped the moment data arrived.
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-4">
          <Skeleton className="h-20 w-20 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-3.5 w-24" />
          </div>
        </div>
        <Skeleton className="h-10 w-full rounded-xl" />
        <GridSkeleton count={6} />
      </div>
    );
  }

  const hasAvatar = !!(profileUser.photoURL && profileUser.photoURL.trim() !== '');

  return (
    // gap-6 → gap-4 between sections. With the identity block now horizontal,
    // 24px gutters left the page reading as three widely separated islands.
    <div className="flex flex-col gap-4">
      <header className="flex min-h-[44px] items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1">
          {onBack && (
            <button
              onClick={onBack}
              aria-label="Back"
              className="tap -ml-2 shrink-0 rounded-full text-muted transition-colors duration-100 hover:text-fg"
            >
              <ChevronLeft size={22} />
            </button>
          )}
          <h1 className="truncate text-xl font-bold tracking-tight text-fg">
            {isOwnProfile ? 'Your profile' : profileUser.displayName}
          </h1>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() => setShowQrCode(true)}
            aria-label="Show profile QR code"
            title="Profile QR code"
            className="tap rounded-full border border-line bg-surface-2 text-muted transition-colors duration-100 hover:text-fg"
          >
            <QrCode size={18} />
          </button>

          {isOwnProfile ? (
            <button
              onClick={() => setShowLogoutConfirm(true)}
              aria-label="Sign out"
              title="Sign out"
              className="tap rounded-full border border-line bg-surface-2 text-danger transition-colors duration-100 hover:bg-danger/10"
            >
              <LogOut size={18} />
            </button>
          ) : (
            <>
              <button
                onClick={() => onChatClick?.(targetUserId)}
                aria-label={`Message ${profileUser.displayName}`}
                title="Message"
                className="tap rounded-full border border-line bg-surface-2 text-muted transition-colors duration-100 hover:text-fg"
              >
                <MessageCircle size={18} />
              </button>
              <button
                onClick={handleFollowToggle}
                aria-pressed={isFollowing}
                className={cn(
                  'h-11 rounded-full px-5 text-sm font-semibold transition-colors duration-100',
                  'active:scale-[0.97]',
                  isFollowing
                    ? 'border border-line bg-surface-2 text-muted hover:text-fg'
                    : 'bg-accent text-white hover:bg-accent-deep'
                )}
              >
                {isFollowing ? 'Following' : 'Follow'}
              </button>
            </>
          )}
        </div>
      </header>

      {/* Identity block.
          Was a centred column: a 160px avatar, then name, then stats, each
          separated by 20px. On a profile with no bio and no posts that is most
          of a screen for four short facts.

          Now a horizontal row — avatar beside the name — which recovers the
          avatar's full height and reads as a header rather than a hero. */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-4">
          <div className="relative shrink-0">
            {isOwnProfile && !hasAvatar ? (
              /* Empty state is the dashed ring plus a single glyph — the camera
                 icon with an "Add photo" caption filled the circle and read as
                 content rather than as a placeholder.

                 The dashed ring alone was too quiet to register as an action,
                 so it now carries the same accent "+" badge the filled avatar
                 uses for "change photo". Two affordances, one obvious: the ring
                 says empty, the badge says you can do something about it. */
              <button
                onClick={() => setIsEditing(true)}
                aria-label="Add a profile photo"
                title="Add photo"
                className="press group/avatar relative flex h-20 w-20 items-center justify-center rounded-full border-2 border-dashed border-line-strong bg-surface-2 text-subtle transition-colors duration-100 hover:border-accent hover:bg-accent/5 hover:text-accent"
              >
                <Camera size={22} />
                <span className="absolute -bottom-0.5 -right-0.5 flex h-7 w-7 items-center justify-center rounded-full border-2 border-bg bg-accent text-white transition-transform duration-100 group-hover/avatar:scale-110">
                  <Plus size={15} strokeWidth={2.5} />
                </span>
              </button>
            ) : (
              <>
                <Avatar user={profileUser} size="2xl" />
                {isOwnProfile && (
                  <button
                    onClick={() => setIsEditing(true)}
                    aria-label="Change profile photo"
                    title="Change photo"
                    className="absolute -bottom-0.5 -right-0.5 flex h-7 w-7 items-center justify-center rounded-full border-2 border-bg bg-accent text-white transition-transform duration-100 active:scale-95"
                  >
                    <Camera size={13} />
                  </button>
                )}
              </>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <h2 className="truncate text-xl font-bold tracking-tight text-fg">
              {profileUser.displayName}
            </h2>
            <p className="truncate text-sm font-medium text-accent">@{profileUser.username}</p>
          </div>

          {isOwnProfile && (
            <button
              onClick={() => setIsEditing(true)}
              className="btn-secondary shrink-0 px-4 py-1.5 text-xs"
            >
              Edit
            </button>
          )}
        </div>

        {profileUser.bio && (
          <p className="text-sm leading-relaxed text-muted">{profileUser.bio}</p>
        )}

        {profileUser.themeSong && (
          <ThemeSongCard
            song={profileUser.themeSong}
            onPlay={() => recordListenedMusic(profileUser.themeSong!)}
          />
        )}

        {/* Stats: number and label on one baseline instead of stacked, so the
            row is a single line of text rather than a 72px card. */}
        <div className="grid grid-cols-3 divide-x divide-line rounded-xl border border-line bg-surface py-2">
          {([
            ['Posts', userPosts.length, null],
            ['Followers', fanCount, { title: 'Followers', type: 'followers' as const }],
            ['Following', circleCount, { title: 'Following', type: 'following' as const }],
          ] as const).map(([label, value, modal]) => {
            const inner = (
              <span className="flex items-baseline justify-center gap-1.5">
                <span className="text-base font-bold leading-none text-fg">{value}</span>
                <span className="text-xs leading-none text-muted">{label}</span>
              </span>
            );
            return modal ? (
              <button
                key={label}
                onClick={() => setShowUsersModal(modal)}
                className="press flex items-center justify-center"
              >
                {inner}
              </button>
            ) : (
              <div key={label} className="flex items-center justify-center">{inner}</div>
            );
          })}
        </div>
      </div>


      {/* Edit Modal */}
      <AnimatePresence>
        {isEditing && (
          <Modal onClose={() => setIsEditing(false)} size="md" labelledBy="edit-profile-title">
            <ModalHeader title="Edit profile" onClose={() => setIsEditing(false)} id="edit-profile-title" />

            <form onSubmit={handleSave} className="flex min-h-0 flex-1 flex-col">
              <ModalBody className="space-y-6">
                {/* Avatar preview sits inside the scrolling body, so it can
                    never push the Save button out of the viewport. */}
                <div className="flex flex-col items-center gap-3">
                  <div className="relative">
                    <div className="flex h-28 w-28 items-center justify-center overflow-hidden rounded-full border border-line bg-surface-2">
                      {(imagePreview || (editForm.photoURL && editForm.photoURL.trim() !== '')) ? (
                        <img
                          src={imagePreview || editForm.photoURL}
                          alt="Profile photo preview"
                          className="h-full w-full object-cover" loading="lazy" decoding="async" />
                      ) : (
                        <UserIcon size={40} className="text-muted" />
                      )}
                    </div>
                    <div className="absolute -bottom-1 -right-1 flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="flex h-9 w-9 items-center justify-center rounded-full border-4 border-surface bg-accent text-white transition-transform duration-100 active:scale-95"
                        title="Upload a photo"
                        aria-label="Upload a photo"
                      >
                        <Camera size={15} />
                      </button>
                      {(imagePreview || (editForm.photoURL && editForm.photoURL.trim() !== '')) && (
                        <button
                          type="button"
                          onClick={handleDeleteAvatar}
                          className="flex h-9 w-9 items-center justify-center rounded-full border-4 border-surface bg-danger text-black transition-transform duration-100 active:scale-95"
                          title="Remove photo"
                          aria-label="Remove photo"
                        >
                          <Trash2 size={15} />
                        </button>
                      )}
                    </div>
                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={handleImageSelect}
                      accept="image/*"
                      className="hidden"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="text-sm font-semibold text-accent hover:text-accent-soft"
                  >
                    {selectedImage ? 'Photo selected' : 'Change photo'}
                  </button>
                </div>

                <div>
                  <label htmlFor="profile-name" className="field-label">Name</label>
                  <input
                    id="profile-name"
                    value={editForm.displayName}
                    placeholder="Your name"
                    onChange={e => setEditForm({ ...editForm, displayName: e.target.value })}
                    className="field"
                  />
                </div>

                <div>
                  <label htmlFor="profile-bio" className="field-label">Bio</label>
                  <textarea
                    id="profile-bio"
                    value={editForm.bio}
                    placeholder="Tell people a bit about yourself"
                    onChange={e => setEditForm({ ...editForm, bio: e.target.value })}
                    rows={3}
                    className="field resize-none leading-relaxed"
                  />
                </div>

                <div>
                  <span className="field-label">Theme song</span>
                  {editForm.themeSong ? (
                    <div className="flex items-center gap-3 rounded-xl border border-line bg-surface-2 p-3">
                      <img
                        src={editForm.themeSong.coverUrl}
                        alt=""
                        className="h-12 w-12 shrink-0 rounded-lg object-cover" loading="lazy" decoding="async" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-fg">{editForm.themeSong.title}</p>
                        <p className="truncate text-sm text-muted">{editForm.themeSong.artist}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowMusicSearch(true)}
                        className="btn-secondary shrink-0 px-3 py-1.5 text-xs"
                      >
                        Change
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditForm({ ...editForm, themeSong: undefined })}
                        aria-label="Remove theme song"
                        className="tap shrink-0 rounded-full text-muted transition-colors duration-100 hover:text-danger"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowMusicSearch(true)}
                      className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-line-strong bg-surface-2 p-5 text-muted transition-colors duration-100 hover:border-accent hover:text-accent"
                    >
                      <Music size={22} />
                      <span className="text-sm font-medium">Choose a song</span>
                    </button>
                  )}
                </div>
              </ModalBody>

              <ModalFooter>
                <button
                  disabled={isSaving || !editForm.displayName.trim()}
                  className="btn-primary flex h-12 w-full items-center justify-center gap-2 text-sm"
                >
                  {isSaving && <Loader2 size={16} className="animate-spin" />}
                  {isSaving ? 'Saving…' : 'Save profile'}
                </button>
              </ModalFooter>
            </form>
          </Modal>
        )}
      </AnimatePresence>

      {/* Posts header. The toggle was `flex-1` on each button, stretching a
          two-word control to the full column width with a large dead zone
          inside each half. It is now sized to its content and paired with a
          count, which gives the row a reason to span the width. */}
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-fg">
          Posts
          {userPosts.length > 0 && (
            <span className="ml-1.5 text-xs font-normal text-muted">{userPosts.length}</span>
          )}
        </h3>

        <div
          role="tablist"
          aria-label="Post layout"
          className="flex shrink-0 gap-0.5 rounded-lg border border-line bg-surface p-0.5"
        >
          {([
            { id: 'grid', label: 'Grid', icon: Grid },
            { id: 'list', label: 'List', icon: List },
          ] as const).map((option) => {
            const Icon = option.icon;
            const isActive = viewMode === option.id;
            return (
              <button
                key={option.id}
                role="tab"
                aria-selected={isActive}
                onClick={() => setViewMode(option.id)}
                // Label hidden below sm but kept for screen readers — an
                // icon-only tab with no accessible name is unusable.
                className={cn(
                  'flex items-center gap-1.5 rounded-[6px] px-2.5 py-1',
                  'text-xs font-semibold transition-colors duration-100',
                  isActive ? 'bg-accent/15 text-accent' : 'text-muted hover:text-fg'
                )}
              >
                <Icon size={14} />
                <span className="sr-only sm:not-sr-only">{option.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {postsLoading ? (
        <GridSkeleton count={6} />
      ) : userPosts.length === 0 ? (
        /* py-16 → py-8. The copy stays; it was only the surrounding void that
           made the page look like it had stopped rendering. */
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-2 text-muted">
            <Grid size={19} />
          </div>
          <p className="text-sm font-semibold text-fg">No posts yet</p>
          <p className="max-w-[260px] text-xs leading-relaxed text-muted">
            {isOwnProfile
              ? 'Posts you write will appear here.'
              : `${profileUser.displayName} hasn't posted anything yet.`}
          </p>
        </div>
      ) : viewMode === 'grid' ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4">
          {userPosts.map((post) => {
            const cover = post.imageUrls?.find(Boolean);

            return (
              <div
                key={post.id}
                role="button"
                tabIndex={0}
                onClick={() => setViewingPost(post)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setViewingPost(post);
                  }
                }}
                className="group relative aspect-square cursor-pointer overflow-hidden rounded-2xl border border-line bg-surface transition-colors duration-100 hover:border-line-strong"
              >
                {cover ? (
                  <>
                    <img
                      src={cover}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="h-full w-full object-cover"
                    />
                    {post.imageUrls && post.imageUrls.filter(Boolean).length > 1 && (
                      <span className="absolute right-2 top-2 rounded-md bg-black/70 p-1 text-white">
                        <Layers size={12} />
                      </span>
                    )}
                  </>
                ) : (
                  /* Text-only posts get a readable card instead of a tiny
                     all-caps grey label cropped mid-word. */
                  <div className="flex h-full w-full flex-col justify-between p-3.5">
                    <p className="line-clamp-5 break-words text-sm leading-relaxed text-fg">
                      {post.content}
                    </p>
                    <div className="flex items-center gap-3 text-xs text-muted">
                      <span className="flex items-center gap-1">
                        <Heart size={12} />
                        {post.likesCount || 0}
                      </span>
                      <span className="flex items-center gap-1">
                        <MessageCircle size={12} />
                        {post.commentsCount || 0}
                      </span>
                    </div>
                  </div>
                )}

                {isOwnProfile && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDelete(post.id);
                    }}
                    aria-label="Delete post"
                    // hover-reveal rather than opacity-0 + group-hover: on a
                    // touch device there is no hover, so this was a delete
                    // control that could never be seen on the devices most of
                    // these posts are read on.
                    className="hover-reveal absolute bottom-2 right-2 flex h-9 w-9 items-center justify-center rounded-full bg-black/70 text-danger transition-colors duration-100"
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <ul className="space-y-3">
          {userPosts.map((post) => {
            const cover = post.imageUrls?.find(Boolean);

            return (
              <li key={post.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setViewingPost(post)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setViewingPost(post);
                    }
                  }}
                  className="flex cursor-pointer gap-4 rounded-2xl border border-line bg-surface p-4 transition-colors duration-100 hover:bg-surface-2"
                >
                  {cover && (
                    <img
                      src={cover}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="h-20 w-20 shrink-0 rounded-xl border border-line object-cover"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-3 break-words text-sm leading-relaxed text-fg">
                      {post.content || 'Untitled post'}
                    </p>
                    <div className="mt-2 flex items-center gap-4 text-xs text-muted">
                      <span>{formatTimeAgo(post.createdAt)}</span>
                      <span className="flex items-center gap-1">
                        <Heart size={12} />
                        {post.likesCount || 0}
                      </span>
                      <span className="flex items-center gap-1">
                        <MessageCircle size={12} />
                        {post.commentsCount || 0}
                      </span>
                    </div>
                  </div>
                  {isOwnProfile && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDelete(post.id);
                      }}
                      aria-label="Delete post"
                      className="tap shrink-0 self-start rounded-full text-muted transition-colors duration-100 hover:text-danger"
                    >
                      <Trash2 size={17} />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* The "About" footer — Privacy Policy and Terms links, plus the
          "You accepted version N" line — is switched off along with the
          consent gates. The documents are still served and still routed at
          /privacy-policy and /terms-of-conditions; nothing links to them from
          inside the app for now. */}

      <AnimatePresence>
        {viewingPost && (
          <Modal onClose={() => setViewingPost(null)} size="lg" labelledBy="view-post-title">
            <div className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-4 sm:px-6">
              <Avatar user={profileUser} size="lg" />
              <div className="min-w-0 flex-1">
                <h3 id="view-post-title" className="truncate text-[15px] font-semibold text-fg">
                  {profileUser.displayName}
                </h3>
                <p className="text-sm text-muted">{formatTimeAgo(viewingPost.createdAt)}</p>
              </div>
              <button
                onClick={() => setViewingPost(null)}
                aria-label="Close"
                className="tap -mr-2 shrink-0 rounded-full text-muted transition-colors duration-100 hover:text-fg"
              >
                <X size={20} />
              </button>
            </div>

            <ModalBody className="space-y-4">
              {viewingPost.imageUrls && viewingPost.imageUrls.length > 0 && (
                <div className="flex snap-x snap-mandatory gap-2 overflow-x-auto rounded-2xl scrollbar-hide">
                  {viewingPost.imageUrls.map((url, i) => url ? (
                    <img
                      key={i}
                      src={url}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="max-h-[45vh] w-full shrink-0 snap-center rounded-2xl border border-line object-contain"
                    />
                  ) : null)}
                </div>
              )}

              {viewingPost.content && (
                <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-fg">
                  {renderContent(viewingPost.content)}
                </p>
              )}
            </ModalBody>

            <ModalFooter>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleLikePost(viewingPost.id, viewingPost.userId)}
                  className={cn(
                    "tap gap-2 rounded-full px-3 transition-colors duration-100",
                    userLikes.has(viewingPost.id) ? "text-danger" : "text-muted hover:text-danger"
                  )}
                >
                  <Heart size={19} fill={userLikes.has(viewingPost.id) ? "currentColor" : "none"} />
                  <span className="text-sm font-semibold">{viewingPost.likesCount || 0}</span>
                </button>
                <button
                  onClick={() => onShowComments?.(viewingPost.id, viewingPost.userId)}
                  className="tap gap-2 rounded-full px-3 text-muted transition-colors duration-100 hover:text-accent"
                >
                  <MessageCircle size={19} />
                  <span className="text-sm font-semibold">{viewingPost.commentsCount || 0}</span>
                </button>
              </div>
            </ModalFooter>
          </Modal>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showUsersModal && (
          <UsersListModal
            title={showUsersModal.title}
            type={showUsersModal.type}
            userId={targetUserId}
            onClose={() => setShowUsersModal(null)}
            onUserClick={onUserClick}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showMusicSearch && (
          <Modal onClose={() => setShowMusicSearch(false)} size="lg" nested>
            <div className="flex min-h-0 flex-1 flex-col p-5 sm:p-6">
              <ThemeSongSearch
                initialSong={editForm.themeSong}
                onClose={() => setShowMusicSearch(false)}
                onSelect={(song) => {
                  setEditForm({ ...editForm, themeSong: song });
                  setShowMusicSearch(false);
                }}
              />
            </div>
          </Modal>
        )}
      </AnimatePresence>

      {/* Delete Confirmation Modal */}
      <AnimatePresence>
        {confirmDelete && (
          <ConfirmDialog
            title="Delete this post?"
            description="It will be removed from your profile and from everyone's feed. This can't be undone."
            confirmLabel={isDeleting ? 'Deleting…' : 'Delete post'}
            destructive
            busy={isDeleting}
            icon={<Trash2 size={26} />}
            onConfirm={() => handleDeletePost(confirmDelete)}
            onCancel={() => setConfirmDelete(null)}
          />
        )}
      </AnimatePresence>

      {/* Logout Confirmation Modal */}
      <AnimatePresence>
        {showLogoutConfirm && (
          <ConfirmDialog
            title="Sign out?"
            description="You'll need to sign back in to see your feed and messages."
            confirmLabel="Sign out"
            destructive
            icon={<LogOut size={26} />}
            onConfirm={onLogout}
            onCancel={() => setShowLogoutConfirm(false)}
          />
        )}
      </AnimatePresence>
      {/* QR Code Modal */}
      <AnimatePresence>
        {showQrCode && (
          <Modal onClose={() => setShowQrCode(false)} size="sm" variant="center" labelledBy="qr-title">
            <ModalHeader title="Your QR code" subtitle="Scan to follow" onClose={() => setShowQrCode(false)} id="qr-title" />

            <ModalBody>
              <div ref={qrCardRef} className="flex flex-col items-center gap-4 bg-surface py-2">
                {/* The code has to stay a high-contrast black-on-white square
                    to remain scannable — that part is not a style choice. So
                    the branding goes around it: an accent ring, a soft glow,
                    and four accent brackets that echo the scanner's frame, so
                    the thing you show and the thing that reads it are visibly
                    the same pair. */}
                <div className="relative rounded-3xl bg-accent/10 p-1.5 ring-1 ring-accent/30">
                  <div className="absolute -inset-2 -z-10 rounded-[28px] bg-accent/10 blur-xl" />
                  <div className="rounded-2xl bg-white p-4">
                    <QRCodeSVG
                      value={buildProfileQr(profileUser.uid)}
                      size={160}
                      level="H"
                      includeMargin={false}
                      imageSettings={profileUser.photoURL ? {
                        src: profileUser.photoURL,
                        height: 36,
                        width: 36,
                        excavate: true,
                        crossOrigin: 'anonymous',
                      } : undefined}
                    />
                  </div>

                  {/* Brackets sit on the ring, clear of the quiet zone the
                      code needs around it. */}
                  {([
                    '-top-px -left-px border-t-2 border-l-2 rounded-tl-2xl',
                    '-top-px -right-px border-t-2 border-r-2 rounded-tr-2xl',
                    '-bottom-px -left-px border-b-2 border-l-2 rounded-bl-2xl',
                    '-bottom-px -right-px border-b-2 border-r-2 rounded-br-2xl',
                  ]).map((corner) => (
                    <span
                      key={corner}
                      aria-hidden
                      className={cn('absolute h-5 w-5 border-accent', corner)}
                    />
                  ))}
                </div>
                <div className="flex items-center gap-2 rounded-full border border-line bg-surface-2 px-3 py-1.5">
                  <Avatar user={profileUser} size="xs" />
                  <span className="text-sm font-medium text-fg">@{profileUser.username}</span>
                </div>
              </div>
            </ModalBody>

            <ModalFooter className="space-y-2">
              {/* Share leads. Handing the code to someone is the reason the
                  modal gets opened; saving a PNG is the rarer, more deliberate
                  act, so it keeps its place but loses the primary styling. */}
              <button
                onClick={shareQRCode}
                disabled={isSharingQR || isDownloadingQR}
                className="btn-primary flex h-11 w-full items-center justify-center gap-2 text-sm"
              >
                {isSharingQR ? <Loader2 size={16} className="animate-spin" /> : <Share2 size={16} />}
                {isSharingQR ? 'Sharing…' : 'Share'}
              </button>
              <button
                onClick={downloadQRCode}
                disabled={isDownloadingQR || isSharingQR}
                className="btn-secondary flex h-11 w-full items-center justify-center gap-2 text-sm"
              >
                {isDownloadingQR ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                {isDownloadingQR ? 'Saving…' : 'Save image'}
              </button>
            </ModalFooter>
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
}
