import React, { useEffect, useRef } from 'react';
import { users as usersApi } from '../lib/db';

interface PresenceTrackerProps {
  userId: string;
}

export function PresenceTracker({ userId }: PresenceTrackerProps) {
  const idleTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const updateIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastUpdateRef = useRef<number>(0);

  const updatePresence = async (status: 'active' | 'idle' | 'offline', force = false) => {
    // Throttle updates to handle 'active' updates at most once every 30 seconds
    const now = Date.now();
    if (!force && status === 'active' && now - lastUpdateRef.current < 30000) {
      return;
    }

    try {
      await usersApi.setPresence(userId, status);
      lastUpdateRef.current = now;
    } catch (err) {
      console.warn('Failed to update presence:', err);
    }
  };

  const resetIdleTimer = () => {
    if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
    
    // Pulse 'active' regularly
    updatePresence('active');

    // After 2 minutes of no activity, set to idle
    idleTimeoutRef.current = setTimeout(() => {
      updatePresence('idle', true); // Force transition to idle
    }, 120000); 
  };

  useEffect(() => {
    if (!userId) return;

    // Force initial status as 'active'
    updatePresence('active', true);

    const events = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart'];
    events.forEach(event => {
      window.addEventListener(event, resetIdleTimer);
    });

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        updatePresence('active', true);
      } else {
        updatePresence('idle', true);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Heartbeat to keep lastActive fresh even during long active sessions
    updateIntervalRef.current = setInterval(() => {
      if (document.visibilityState === 'visible') {
        updatePresence('active');
      }
    }, 60000); // Pulse every minute if visible

    return () => {
      events.forEach(event => {
        window.removeEventListener(event, resetIdleTimer);
      });
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
      if (updateIntervalRef.current) clearInterval(updateIntervalRef.current);
      
      // Best effort on unmount; a closed tab never gets here. The UI falls back
      // to "Active X mins ago" from last_active, which is why that column is
      // stamped on every pulse rather than only on transitions.
      updatePresence('offline');
    };
  }, [userId]);

  return null; // This is a logic-only component
}
