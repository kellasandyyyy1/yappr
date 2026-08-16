import React, { useEffect, useState } from 'react';
import { Download, X, Share, RefreshCw } from 'lucide-react';
import {
  initInstallPrompt,
  onInstallAvailabilityChange,
  promptInstall,
  isRunningStandalone,
  isIosSafari,
  onUpdateAvailable,
  applyUpdate,
} from '../lib/pwa';
import { cn } from '../lib/utils';

const DISMISS_KEY = 'yappr:install-dismissed';

/**
 * Custom install banner, plus the "a new version is ready" prompt.
 *
 * Both live here because they occupy the same slot and must never stack — two
 * banners fighting for the bottom of a phone screen is worse than either alone.
 * The update prompt wins, since a stale build is the more urgent problem.
 *
 * ── iOS ──────────────────────────────────────────────────────────────────────
 * Safari never fires `beforeinstallprompt` and offers no programmatic install:
 * Add to Home Screen is a manual Share-sheet action. A button there would do
 * nothing, so iOS gets instructions instead. Without this branch the install
 * path is simply invisible to every iPhone user, which is most of the audience
 * for a mobile social app.
 */
export function InstallPrompt() {
  const [canInstall, setCanInstall] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [showIosHelp, setShowIosHelp] = useState(false);

  useEffect(() => {
    const teardownEvents = initInstallPrompt();
    const offInstall = onInstallAvailabilityChange(setCanInstall);
    const offUpdate = onUpdateAvailable(() => setUpdateReady(true));
    return () => {
      teardownEvents();
      offInstall();
      offUpdate();
    };
  }, []);

  const dismiss = () => {
    setDismissed(true);
    setShowIosHelp(false);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* private mode — the banner simply returns next visit */
    }
  };

  const handleInstall = async () => {
    if (isIosSafari()) {
      setShowIosHelp(true);
      return;
    }
    const accepted = await promptInstall();
    // On decline the event is spent; hide until next visit rather than showing
    // a button that can no longer do anything.
    if (!accepted) dismiss();
  };

  // Already installed — nothing to offer, and the update prompt is handled
  // inside the installed window too, so it is checked first.
  const installed = isRunningStandalone();

  if (updateReady) {
    return (
      <Banner
        icon={<RefreshCw size={18} className="text-accent" />}
        title="A new version is ready"
        body="Reload to get the latest build."
        action={{ label: 'Reload', onClick: () => void applyUpdate() }}
        onDismiss={() => setUpdateReady(false)}
      />
    );
  }

  if (installed || dismissed) return null;
  // Chromium tells us when the bar is met. iOS never will, so it is offered
  // unconditionally there — gated on not already being installed.
  if (!canInstall && !isIosSafari()) return null;

  if (showIosHelp) {
    return (
      <Banner
        icon={<Share size={18} className="text-accent" />}
        title="Install Yappr"
        body={
          <>
            Tap the <span className="font-semibold text-fg">Share</span> button in Safari,
            then <span className="font-semibold text-fg">Add to Home Screen</span>.
          </>
        }
        onDismiss={dismiss}
      />
    );
  }

  return (
    <Banner
      icon={<Download size={18} className="text-accent" />}
      title="Install Yappr"
      body="Add it to your home screen for a full-screen app and faster launches."
      action={{ label: 'Install', onClick: () => void handleInstall() }}
      onDismiss={dismiss}
    />
  );
}

function Banner({
  icon,
  title,
  body,
  action,
  onDismiss,
}: {
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
  action?: { label: string; onClick: () => void };
  onDismiss: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-label={title}
      className={cn(
        // Sits above the mobile nav bar, and clears the iOS home indicator.
        'fixed inset-x-3 bottom-3 z-[var(--z-toast)] sm:left-auto sm:right-4 sm:w-[360px]',
        'rounded-2xl border border-line bg-surface-2 p-4 shadow-2xl',
        'pb-[max(1rem,env(safe-area-inset-bottom))]'
      )}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0">{icon}</span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold text-fg">{title}</p>
          <p className="mt-0.5 text-sm leading-relaxed text-muted">{body}</p>
          {action && (
            <button
              onClick={action.onClick}
              className="btn-primary mt-3 px-4 py-2 text-sm"
            >
              {action.label}
            </button>
          )}
        </div>
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors duration-100 hover:text-fg"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
