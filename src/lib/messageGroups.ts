/**
 * Grouping rules for the chat transcript.
 *
 * Kept out of ChatView because these are pure decisions about a list of
 * messages, and pure decisions are worth testing directly —
 * scripts/migrate/test-message-clustering.ts exercises them without a browser.
 */

import { Message } from '../types';

/** createdAt arrives either as a Date/ISO string or as a Firestore-style value
 *  with .toDate(); both shapes still reach the chat view. */
export const messageTime = (msg: Message): number => {
  const raw: any = msg?.createdAt;
  if (!raw) return 0;
  const d = raw.toDate ? raw.toDate() : new Date(raw);
  const t = d instanceof Date ? d.getTime() : NaN;
  return Number.isNaN(t) ? 0 : t;
};

export const formatClock = (msg: Message): string => {
  const at = messageTime(msg);
  return at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
};

/** Consecutive messages from one sender collapse into a cluster. Five minutes
 *  is long enough to hold a burst of typing together and short enough that a
 *  reply an hour later still reads as a new turn. */
export const CLUSTER_WINDOW_MS = 5 * 60 * 1000;

/**
 * True when `msg` opens a new run rather than continuing the one `prev` is in.
 *
 * Also answers "does the run end here?" — call it with the *next* message as
 * `msg` and the current one as `prev`. With no next message it returns true,
 * which is what makes the last message of the transcript close its run.
 */
export const startsNewCluster = (msg?: Message, prev?: Message): boolean => {
  if (!msg || !prev) return true;
  if (prev.senderId !== msg.senderId) return true;
  // A reply points somewhere else in the thread, so it reads as its own turn
  // even when the same person sent the message just before it.
  if (msg.replyToId) return true;
  const prevAt = messageTime(prev);
  const at = messageTime(msg);
  // An unsent message has no timestamp yet; keep it attached to the run above
  // rather than letting it jump out on every render until the server replies.
  if (!prevAt || !at) return false;
  return at - prevAt > CLUSTER_WINDOW_MS;
};
