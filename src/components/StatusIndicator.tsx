import React from 'react';
import { cn, formatTimeAgo } from '../lib/utils';
import { User } from '../types';

interface StatusIndicatorProps {
  user: User | null;
  className?: string;
  showText?: boolean;
  size?: 'sm' | 'md';
}

export function StatusIndicator({ user, className, showText = false, size = 'sm' }: StatusIndicatorProps) {
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    if (!showText) return;
    const interval = setInterval(() => {
      setTick(t => t + 1);
    }, 30000);
    return () => clearInterval(interval);
  }, [showText]);

  if (!user) return null;

  const { status, lastActive } = user;
  
  // Calculate if really offline
  // Handle both Firestore Timestamp and potential primitive number/Date
  let lastActiveMillis = 0;
  if (lastActive) {
    if (typeof lastActive.toMillis === 'function') {
      lastActiveMillis = lastActive.toMillis();
    } else if (lastActive instanceof Date) {
      lastActiveMillis = lastActive.getTime();
    } else if (typeof lastActive === 'number') {
      lastActiveMillis = lastActive;
    } else if (typeof lastActive === 'string') {
      lastActiveMillis = new Date(lastActive).getTime();
    }
  }

  const now = Date.now();
  const diffMinutes = (now - lastActiveMillis) / 60000;
  
  let currentStatus = status || 'offline';
  
  // Force offline if no pulse for a while. 
  // We use a 10 min window for active/idle to be safe against throttling.
  if (currentStatus !== 'offline' && lastActiveMillis > 0 && diffMinutes > 10) {
    currentStatus = 'offline';
  }

  // Also handle cases where currentStatus is 'active' or 'idle' but lastActive results in an empty field
  if (currentStatus !== 'offline' && lastActiveMillis === 0) {
    // If it's a very new user or first pulse hasn't finished
    // we give them the benefit of the doubt for the first minute
  }

  const getStatusColor = () => {
    switch (currentStatus) {
      case 'active': return 'bg-emerald-500';
      case 'idle': return 'bg-amber-500';
      default: return 'bg-surface-3';
    }
  };

  const getStatusText = () => {
    if (currentStatus === 'active') return 'Active now';
    if (currentStatus === 'idle') return 'Idle';
    
    if (lastActiveMillis > 0) {
      return `Active ${formatTimeAgo(lastActiveMillis)}`;
    }
    return 'Offline';
  };

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div 
        className={cn(
          "rounded-full shrink-0", 
          getStatusColor(),
          size === 'sm' ? "w-2 h-2" : "w-2.5 h-2.5"
        )} 
      />
      {showText && (
        <span className={cn(
          "font-medium tracking-tight",
          size === 'sm' ? "text-xs" : "text-xs",
          currentStatus === 'active' ? "text-emerald-400" : "text-muted"
        )}>
          {getStatusText()}
        </span>
      )}
    </div>
  );
}
