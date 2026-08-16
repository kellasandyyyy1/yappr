import React, { useState, useEffect } from 'react';
import { auth, users as usersApi, chats as chatsApi, notifications as notificationsApi } from './lib/db';
import { registerPushNotifications } from './lib/pushNotifications';
import { pendingTotpChallenge } from './lib/mfa';
import { View, User, Post } from './types';
import { Navbar } from './components/Navbar';
import { Sidebar } from './components/Sidebar';
import { RightRail } from './components/RightRail';
import { Feed } from './components/Feed';
import { AuthView } from './components/AuthView';
import { ChatView } from './components/ChatView';
import { ProfileView } from './components/ProfileView';
import { NotificationsView } from './components/NotificationsView';
import { SearchView } from './components/SearchView';
import { QRScanner } from './components/QRScanner';
import { ProfilePreviewCard } from './components/ProfilePreviewCard';
import { CreatePostModal } from './components/CreatePostModal';
import { CommentsModal } from './components/CommentsModal';
import { PostDetailModal } from './components/PostDetailModal';
import { ShareModal } from './components/ShareModal';
import { PresenceTracker } from './components/PresenceTracker';
import { InstallPrompt } from './components/InstallPrompt';
import { ToastProvider } from './components/ToastContext';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from './lib/utils';
import { LegalPage } from './components/LegalPage';
import { LegalConsentModal } from './components/LegalConsentModal';
import { usePathname, isPublicRoute, normalizePath, navigate } from './lib/router';
import { fetchLegalManifest, needsReconsent } from './lib/legal';
import { parseProfileQr } from './lib/brand';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  // Why the user was returned to the auth screen, when it was not their doing.
  // Without this the bounce is indistinguishable from a failed sign-in.
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [currentView, setCurrentView] = useState<View>('feed');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showCommentsPostId, setShowCommentsPostId] = useState<string | null>(null);
  const [showCommentsPostUserId, setShowCommentsPostUserId] = useState<string>('');
  const [showPostDetailId, setShowPostDetailId] = useState<string | null>(null);
  const [sharingPost, setSharingPost] = useState<Post | null>(null);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [viewingProfileId, setViewingProfileId] = useState<string | null>(null);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [prevUnreadMessages, setPrevUnreadMessages] = useState(0);

  useEffect(() => {
    if (unreadMessages > prevUnreadMessages && currentView !== 'chat') {
      // In a real app, we might want to fetch the sender name here
      // But for now, we'll show a generic notification
    }
    setPrevUnreadMessages(unreadMessages);
  }, [unreadMessages, currentView]);
  const [isEditingPost, setIsEditingPost] = useState(false);
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scannedUserId, setScannedUserId] = useState<string | null>(null);
  const [targetChatUserId, setTargetChatUserId] = useState<string | null>(null);

  // Legal routing + consent state
  const pathname = usePathname();
  const [legalVersion, setLegalVersion] = useState('');
  const [legalUpdated, setLegalUpdated] = useState('');

  const [consentPrompt, setConsentPrompt] = useState(false);

  useEffect(() => {
    fetchLegalManifest().then((manifest) => {
      if (!manifest) return; // fail open — never gate on a failed fetch
      setLegalVersion(manifest.version);
      setLegalUpdated(manifest.lastUpdated);
    });
  }, []);

  // Latch the prompt open rather than deriving visibility from `user` on every
  // render. Firestore applies writes locally before the server confirms them,
  // so a derived condition flips false the instant Accept is clicked — which
  // unmounts the modal and throws away its error state — and then flips back
  // true when a rejected write is rolled back. The result is a modal that
  // silently reappears with the checkbox cleared and no explanation.
  // Only a server-confirmed acceptance clears this.
  useEffect(() => {
    if (needsReconsent(user, legalVersion)) setConsentPrompt(true);
  }, [user, legalVersion]);

  const handleScan = (data: string) => {
    // Accepts both the new `yappr:profile:` prefix and the legacy `privy:`
    // one, so codes generated before the rename keep scanning. See lib/brand.ts.
    const userId = parseProfileQr(data);
    if (userId) {
      setScannedUserId(userId);
      setIsScanning(false);
    } else {
      // Handle regular QR codes or generic formats if needed
      console.log('Generic QR scanned:', data);
    }
  };

  const handlePostClick = async (postId: string) => {
    setShowPostDetailId(postId);
  };

  useEffect(() => {
    // Per-session subscriptions, torn down whenever the signed-in user changes.
    let cleanups: (() => void)[] = [];
    let cancelled = false;

    const teardown = () => {
      for (const fn of cleanups) fn();
      cleanups = [];
    };

    const loadSession = async (userId: string | null) => {
      teardown();

      if (!userId) {
        setUser(null);
        setCurrentView('auth');
        setLoading(false);
        return;
      }

      // A session at aal1 on an account with 2FA enrolled is a challenge
      // ticket, not a sign-in. RLS rejects it (see 0006_require_aal2.sql), so
      // loading a profile would fail and look like a missing account. Hold on
      // the auth screen and let AuthView finish the challenge.
      if (await pendingTotpChallenge()) {
        setUser(null);
        setCurrentView('auth');
        setLoading(false);
        return;
      }

      registerPushNotifications();

      // Profile. Firestore streamed the document; Supabase gives one read plus
      // an UPDATE subscription, which is the same thing for a single row.
      const profile = await usersApi.get(userId);
      if (cancelled) return;

      if (!profile) {
        // A valid session with no profile row. This used to log to the console
        // and drop the user back on the sign-in screen with nothing shown —
        // they had just entered the right password, so it read as the login
        // silently failing, and no amount of retrying could fix it.
        //
        // Try to repair it first. An account created through the app always has
        // both rows (0009), so reaching here means it was made another way —
        // usually the dashboard's "Add user", which stores no metadata.
        const repaired = await usersApi.ensureProfile(userId);
        if (cancelled) return;

        if (repaired) {
          console.warn('[auth] profile row was missing and has been recreated', { userId });
          setUser(repaired);
          setLoading(false);
          return;
        }

        // Not repairable: no username to build a profile from, and one cannot
        // be invented — it is public, unique and permanent. Sign out so the app
        // is not left holding a session it cannot use, and say why.
        console.error('[auth] signed in but no profile row exists and none could be created', { userId });
        await auth.signOut();
        if (cancelled) return;

        setAuthNotice(
          'Your account exists but its profile is incomplete, so there is nothing to sign in to. ' +
          'This happens when an account is created directly in the Supabase dashboard rather than ' +
          'through this form. Create the account here instead, or ask an administrator to add the ' +
          'missing profile record.'
        );
        setUser(null);
        setCurrentView('auth');
        setLoading(false);
        return;
      }

      setUser(profile);
      setLoading(false);

      cleanups.push(usersApi.subscribe(userId, (updated) => setUser(updated)));

      // Unread badges. Both counts are a single indexed COUNT rather than
      // fetching every matching document and measuring the result set.
      const refreshBadges = async () => {
        const [notifCount, messageCount] = await Promise.all([
          notificationsApi.unreadCount(userId),
          chatsApi.unreadCount(userId),
        ]);
        if (cancelled) return;
        setUnreadNotifications(notifCount);
        setUnreadMessages(messageCount);
      };

      await refreshBadges();
      cleanups.push(notificationsApi.subscribe(userId, refreshBadges));
      cleanups.push(chatsApi.subscribeToInbox(refreshBadges));

      // Delivery acknowledgement — the "Delivered" tier. The receipt row
      // already exists (created by the fan_out_message_receipts trigger when
      // the message was inserted); this stamps delivered_at the moment it
      // reaches this client, whether or not the chat is open.
      //
      // Replaces the Firestore collectionGroup listener that had to write
      // arrayUnion(deliveredTo) onto every message document itself.
      const ackDelivery = async () => {
        const pending = await chatsApi.pendingDelivery(userId);
        if (pending.length > 0) await chatsApi.markDelivered(pending, userId);
      };
      await ackDelivery();
      cleanups.push(chatsApi.subscribeToInbox(ackDelivery));
    };

    const unsubscribeAuth = auth.onChange((userId) => {
      void loadSession(userId);
    });

    // onChange does not fire for an already-restored session on first mount.
    void auth.getSession().then((session) => loadSession(session?.user?.id ?? null));

    return () => {
      cancelled = true;
      unsubscribeAuth();
      teardown();
    };
  }, []);

  // Legal pages are public: they render before the auth gate and before the
  // loading spinner, so they're reachable while signed out, while signing in,
  // and by anyone following a direct link.
  if (isPublicRoute(pathname)) {
    return (
      <ToastProvider>
        <LegalPage slug={normalizePath(pathname).slice(1)} onExit={() => navigate('/')} />
      </ToastProvider>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-bg">
        <div
          className="w-8 h-8 rounded-full border-2 border-accent border-t-transparent animate-spin"
          role="status"
          aria-label="Loading Yappr"
        />
      </div>
    );
  }

  // Page transitions: opacity only, 150ms. Fast enough to feel instant,
  // long enough to avoid a hard cut between views.
  const pageMotion = {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: { duration: 0.15, ease: 'easeOut' as const },
  };

  // The feed column stays at a readable measure; profile needs room for a
  // 4-up grid and chat for a two-pane conversation.
  const columnWidth =
    currentView === 'chat'
      ? 'max-w-[880px]'
      : currentView === 'profile'
        ? 'max-w-[760px]'
        : 'max-w-[600px]';

  // The right rail is a companion to browsing views only — chat and profile
  // use the width themselves.
  const showRail = currentView === 'feed' || currentView === 'search' || currentView === 'notifications';

  if (!user || currentView === 'auth') {
    return (
      <ToastProvider>
        <div className="min-h-screen bg-bg text-fg">
          <AuthView
            notice={authNotice}
            onDismissNotice={() => setAuthNotice(null)}
            onAuthSuccess={() => {
              setAuthNotice(null);
              setCurrentView('feed');
            }}
          />
        </div>
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <div className="min-h-screen bg-bg text-fg">
        <PresenceTracker userId={user.uid} />
        <InstallPrompt />

        {/* Material change to the documents: block the app until the user
            makes an explicit, recorded decision. */}
        {consentPrompt && (
          <LegalConsentModal
            uid={user.uid}
            version={legalVersion}
            lastUpdated={legalUpdated}
            onAccepted={() => {
              setConsentPrompt(false);
              setUser({ ...user, termsVersion: legalVersion });
            }}
            onDecline={() => auth.signOut()}
          />
        )}

        {/* Tablet & desktop: persistent left navigation. */}
        <Sidebar
          user={user}
          currentView={currentView}
          onViewChange={(v) => {
            if (v === 'profile') setViewingProfileId(null);
            setTargetChatUserId(null);
            setCurrentView(v);
          }}
          onNewPost={() => setShowCreateModal(true)}
          unreadNotifications={unreadNotifications}
          unreadMessages={unreadMessages}
        />

        {/* Offset for the fixed sidebar: 80px icon rail, 256px expanded. */}
        <div className="sm:pl-20 lg:pl-64">
          <div className="mx-auto flex w-full max-w-[1120px] justify-center gap-8 px-4 sm:px-6 lg:px-8">
            <main
              className={cn(
                'w-full min-w-0 flex-1 pt-6 sm:pt-8',
                'pb-28 sm:pb-12', // room for the mobile bottom bar
                columnWidth
              )}
            >
              <AnimatePresence mode="wait">
            {currentView === 'feed' && user && (
              <motion.div key="feed" {...pageMotion}>
                <Feed
                  user={user} 
                  onNewPost={() => setShowCreateModal(true)} 
                  onProfileClick={() => {
                    setViewingProfileId(null);
                    setCurrentView('profile');
                  }}
                  onUserClick={(uid) => {
                    setViewingProfileId(uid);
                    setCurrentView('profile');
                  }}
                  onShowComments={(postId, postUserId) => {
                    setShowCommentsPostId(postId);
                    setShowCommentsPostUserId(postUserId);
                  }}
                  onEditingChange={setIsEditingPost}
                />
              </motion.div>
            )}
            {currentView === 'search' && user && (
              <motion.div key="search" {...pageMotion}>
                <SearchView
                  user={user}
                  onUserClick={(uid) => {
                    setViewingProfileId(uid);
                    setCurrentView('profile');
                  }}
                  onBack={() => setCurrentView('feed')}
                  onScanClick={() => setIsScanning(true)}
                />
              </motion.div>
            )}
            {currentView === 'chat' && user && (
              <motion.div key="chat" {...pageMotion}>
                <ChatView
                  user={user} 
                  initialUserId={targetChatUserId || undefined}
                  onProfileClick={() => {
                    setViewingProfileId(null);
                    setCurrentView('profile');
                  }}
                  onUserClick={(uid) => {
                    setViewingProfileId(uid);
                    setCurrentView('profile');
                  }}
                  onChatOpenChange={setIsChatOpen}
                  onPostClick={handlePostClick}
                  onBack={() => {
                    setTargetChatUserId(null);
                    setCurrentView('feed');
                  }}
                />
              </motion.div>
            )}
            {currentView === 'profile' && user && (
              <motion.div key="profile" {...pageMotion}>
                <ProfileView
                  user={user} 
                  profileUserId={viewingProfileId || undefined}
                  onLogout={() => auth.signOut()} 
                  onBack={() => {
                    if (viewingProfileId) {
                      setViewingProfileId(null);
                    } else {
                      setCurrentView('feed');
                    }
                  }}
                  onUserClick={(uid) => {
                    setViewingProfileId(uid);
                  }}
                  onChatClick={(uid) => {
                    setTargetChatUserId(uid);
                    setCurrentView('chat');
                  }}
                  onShowComments={(postId, postUserId) => {
                    setShowCommentsPostId(postId);
                    setShowCommentsPostUserId(postUserId);
                  }}
                  onEditingChange={setIsEditingProfile}
                />
              </motion.div>
            )}
            {currentView === 'notifications' && user && (
              <motion.div key="notifications" {...pageMotion}>
                <NotificationsView
                  user={user} 
                  onProfileClick={() => {
                    setViewingProfileId(null);
                    setCurrentView('profile');
                  }}
                  onUserClick={(uid) => {
                    setViewingProfileId(uid);
                    setCurrentView('profile');
                  }}
                  onPostClick={(postId) => {
                    handlePostClick(postId);
                  }}
                  onBack={() => setCurrentView('feed')}
                />
              </motion.div>
            )}
              </AnimatePresence>
            </main>

            {/* Desktop companion column — keeps the freed width in use. */}
            {showRail && (
              <RightRail
                user={user}
                onUserClick={(uid) => {
                  setViewingProfileId(uid);
                  setCurrentView('profile');
                }}
                onProfileClick={() => {
                  setViewingProfileId(null);
                  setCurrentView('profile');
                }}
              />
            )}
          </div>
        </div>

        {/* Mobile-only bottom bar. Hidden at >=640px, where the sidebar owns
            navigation, and while a full-screen surface is open. */}
        {!showCreateModal && !showCommentsPostId && !isChatOpen && !isEditingPost && !isEditingProfile && (
          <Navbar
            currentView={currentView}
            unreadNotifications={unreadNotifications}
            unreadMessages={unreadMessages}
            onViewChange={(v) => {
              if (v === 'profile') setViewingProfileId(null);
              setTargetChatUserId(null);
              setCurrentView(v);
            }}
            onNewPost={() => setShowCreateModal(true)}
          />
        )}

        <AnimatePresence>
          {showCreateModal && user && (
            <CreatePostModal 
              user={user} 
              onClose={() => setShowCreateModal(false)}
              onSuccess={() => {
                setShowCreateModal(false);
                setCurrentView('feed');
              }}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {showCommentsPostId && user && (
            <CommentsModal
              postId={showCommentsPostId}
              postUserId={showCommentsPostUserId}
              user={user}
              onUserClick={(uid) => {
                setShowCommentsPostId(null);
                setViewingProfileId(uid);
                setCurrentView('profile');
              }}
              onClose={() => {
                setShowCommentsPostId(null);
                setShowCommentsPostUserId('');
              }}
            />
          )}

          {sharingPost && user && (
            <ShareModal 
              post={sharingPost} 
              currentUser={user} 
              onClose={() => setSharingPost(null)} 
            />
          )}

          {showPostDetailId && user && (
            <PostDetailModal
              postId={showPostDetailId}
              currentUser={user}
              onClose={() => setShowPostDetailId(null)}
              onCommentClick={(postId, userId) => {
                setShowCommentsPostId(postId);
                setShowCommentsPostUserId(userId);
              }}
              onShareClick={setSharingPost}
            />
          )}

          {isScanning && (
            <QRScanner 
              onScan={handleScan}
              onClose={() => setIsScanning(false)}
            />
          )}

          {scannedUserId && user && (
            <ProfilePreviewCard 
              userId={scannedUserId}
              currentUser={user}
              onClose={() => setScannedUserId(null)}
              onViewProfile={(uid) => {
                setViewingProfileId(uid);
                setCurrentView('profile');
              }}
            />
          )}
        </AnimatePresence>
      </div>
    </ToastProvider>
  );
}
