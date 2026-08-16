import React from 'react';
import { PenSquare } from 'lucide-react';
import { View } from '../types';
import { cn } from '../lib/utils';
import { NAV_ITEMS } from './Sidebar';

interface NavbarProps {
  currentView: View;
  onViewChange: (view: View) => void;
  onNewPost: () => void;
  unreadNotifications?: number;
  unreadMessages?: number;
}

/**
 * Mobile-only bottom navigation (<640px). At tablet and above <Sidebar />
 * replaces it entirely.
 *
 * Solid background rather than backdrop-filter: blurring everything scrolling
 * underneath forced a full-viewport repaint on every frame of every scroll.
 */
export function Navbar({
  currentView,
  onViewChange,
  onNewPost,
  unreadNotifications = 0,
  unreadMessages = 0,
}: NavbarProps) {
  const countFor = (id: string) =>
    id === 'chat' ? unreadMessages : id === 'notifications' ? unreadNotifications : 0;

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] sm:hidden"
      aria-label="Primary"
    >
      <div className="mx-auto flex max-w-md items-center justify-around px-2">
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
              aria-label={item.label}
              className={cn(
                'tap relative flex-1 flex-col gap-1 rounded-lg py-2',
                'transition-colors duration-100',
                isActive ? 'text-accent' : 'text-muted active:text-fg'
              )}
            >
              <span className="relative flex items-center justify-center">
                <Icon size={22} strokeWidth={isActive ? 2.4 : 2} />
                {count > 0 && (
                  <span
                    className="absolute -right-2 -top-1 flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold leading-none text-white"
                  >
                    {count > 99 ? '99+' : count}
                  </span>
                )}
              </span>
              <span className="text-[10px] font-semibold leading-none">{item.label}</span>
            </button>
          );
        })}

        {/* Compose is a nav item here too — no separate floating button. */}
        <button
          onClick={onNewPost}
          aria-label="New post"
          className="tap ml-1 h-11 w-11 shrink-0 rounded-full bg-accent text-white transition-transform duration-100 active:scale-95"
        >
          <PenSquare size={20} />
        </button>
      </div>
    </nav>
  );
}
