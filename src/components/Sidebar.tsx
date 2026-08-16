import React from 'react';
import { Home, MessageCircle, Bell, User as UserIcon, Search, PenSquare } from 'lucide-react';
import { View, User } from '../types';
import { cn } from '../lib/utils';
import { Avatar } from './Avatar';
import { Logo } from './Logo';

export interface NavItem {
  id: Extract<View, 'feed' | 'search' | 'chat' | 'notifications' | 'profile'>;
  icon: typeof Home;
  label: string;
}

/** Shared by the desktop sidebar and the mobile bottom bar so the two
 *  never drift apart. */
export const NAV_ITEMS: NavItem[] = [
  { id: 'feed', icon: Home, label: 'Feed' },
  { id: 'search', icon: Search, label: 'Explore' },
  { id: 'chat', icon: MessageCircle, label: 'Messages' },
  { id: 'notifications', icon: Bell, label: 'Notifications' },
  { id: 'profile', icon: UserIcon, label: 'Profile' },
];

interface SidebarProps {
  user: User;
  currentView: View;
  onViewChange: (view: View) => void;
  onNewPost: () => void;
  unreadNotifications?: number;
  unreadMessages?: number;
}

/**
 * Persistent left navigation for tablet (>=640px, icon rail) and desktop
 * (>=1024px, icons + labels). Hidden on mobile, where <Navbar /> takes over.
 */
export function Sidebar({
  user,
  currentView,
  onViewChange,
  onNewPost,
  unreadNotifications = 0,
  unreadMessages = 0,
}: SidebarProps) {
  const countFor = (id: NavItem['id']) =>
    id === 'chat' ? unreadMessages : id === 'notifications' ? unreadNotifications : 0;

  return (
    <aside
      className="fixed inset-y-0 left-0 z-40 hidden w-20 flex-col border-r border-line bg-bg px-3 py-6 sm:flex lg:w-64 lg:px-4"
      aria-label="Primary"
    >
      {/* Brand. The rail is 80px collapsed and 256px at lg, so the wordmark is
          dropped in the collapsed state and the icon carries the brand alone —
          it is legible at 28px where five letters would not be. */}
      <div className="mb-8 flex items-center justify-center lg:justify-start lg:px-3">
        <Logo size="md" iconOnly className="lg:hidden" />
        <Logo size="md" className="hidden lg:flex" />
      </div>

      <nav className="flex flex-1 flex-col gap-1">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = currentView === item.id;
          const count = countFor(item.id);

          return (
            <button
              key={item.id}
              id={`nav-item-${item.id}`}
              onClick={() => onViewChange(item.id)}
              aria-current={isActive ? 'page' : undefined}
              title={item.label}
              className={cn(
                'group relative flex min-h-[48px] items-center gap-4 rounded-xl px-3',
                'transition-colors duration-100',
                'justify-center lg:justify-start',
                isActive
                  ? 'bg-accent/12 text-accent'
                  : 'text-muted hover:bg-surface-2 hover:text-fg'
              )}
            >
              <span className="relative flex items-center justify-center">
                <Icon size={22} strokeWidth={isActive ? 2.4 : 2} />
                {count > 0 && (
                  <span
                    className="absolute -right-2 -top-1.5 flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold leading-none text-white"
                  >
                    {count > 99 ? '99+' : count}
                  </span>
                )}
              </span>
              <span className="hidden text-[15px] font-semibold lg:inline">{item.label}</span>
              {count > 0 && (
                <span className="sr-only">
                  {count} unread {item.label.toLowerCase()}
                </span>
              )}
            </button>
          );
        })}

        {/* Compose lives in the nav rather than as a floating button. */}
        <button
          onClick={onNewPost}
          title="New post"
          className="btn-primary mt-4 flex min-h-[48px] items-center justify-center gap-2 px-3 lg:px-5"
        >
          <PenSquare size={20} />
          <span className="hidden text-sm lg:inline">New post</span>
        </button>
      </nav>

      {/* Account */}
      <button
        onClick={() => onViewChange('profile')}
        className="press mt-4 flex min-h-[48px] items-center gap-3 rounded-xl px-2 transition-colors duration-100 hover:bg-surface-2 justify-center lg:justify-start"
        title={`Signed in as ${user.displayName}`}
      >
        <Avatar user={user} size="md" />
        <span className="hidden min-w-0 flex-1 text-left lg:block">
          <span className="block truncate text-sm font-semibold text-fg">
            {user.displayName}
          </span>
          <span className="block truncate text-xs text-muted">@{user.username}</span>
        </span>
      </button>
    </aside>
  );
}
