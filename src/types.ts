export interface ThemeSong {
  youtubeId: string;
  title: string;
  artist: string;
  coverUrl: string;
  startTime: number; // in seconds
}

export interface User {
  /**
   * Compatibility alias for `id`, kept while the Supabase migration is in
   * progress so component code written against Firebase keeps working.
   * Remove once every file reads `id`. See MIGRATION.md step 7.
   */
  uid: string;
  /** Canonical primary key — matches `public.users.id` / `auth.users.id`. */
  id?: string;
  username: string;
  displayName: string;
  email: string;
  photoURL?: string;
  bio?: string;
  createdAt: number;
  status?: 'active' | 'idle' | 'offline';
  lastActive?: any;
  themeSong?: ThemeSong;
  /** Version of the legal documents this user accepted. */
  termsVersion?: string;
  /** Server timestamp of that acceptance — the compliance record. */
  termsAcceptedAt?: any;
}

export interface EditHistoryEntry {
  content: string;
  editedAt: any;
}

export interface Post {
  id: string;
  userId: string;
  content: string;
  imageUrl?: string;
  voiceUrl?: string;
  /** Public URL in the post-videos bucket. */
  videoUrl?: string;
  /** First-frame poster, so the feed never renders a black rectangle. */
  videoPosterUrl?: string;
  type?: 'text' | 'image' | 'voice' | 'video';
  imageUrls?: string[];
  likesCount: number;
  commentsCount: number;
  createdAt: any;
  user?: User; // Joined in frontend for display
  editHistory?: EditHistoryEntry[];
  recentLikers?: User[];
  reactions?: Record<string, string[]>;
  song?: ThemeSong;
  /** Audience for this post. Absent on older posts, which are public. */
  visibility?: PostVisibility;
}

export type PostVisibility = 'public' | 'followers' | 'private';

export interface Comment {
  id: string;
  postId: string;
  userId: string;
  content: string;
  createdAt: number;
  user?: User;
  type?: 'text' | 'image' | 'voice';
  imageUrl?: string;
  voiceUrl?: string;
  reactions?: Record<string, string[]>;
  replyToId?: string;
  replyToContent?: string;
  replyToSenderName?: string;
}

export interface Message {
  id: string;
  chatId: string;
  senderId: string;
  receiverId?: string; // Optional for groups, or we can just use chatId
  content: string;
  createdAt: number;
  isRead: boolean;
  type?: 'text' | 'image' | 'voice' | 'video' | 'post';
  imageUrl?: string;
  voiceUrl?: string;
  /** `supabase://chat-videos/...` — private bucket, signed on read. */
  videoUrl?: string;
  videoPosterUrl?: string;
  reactions?: Record<string, string[]>;
  replyToId?: string;
  replyToContent?: string;
  replyToSenderName?: string;
  replyToType?: 'text' | 'image' | 'voice' | 'video' | 'post';
  postId?: string;
  readBy?: string[]; // UIDs of users who have opened the message
  /** UIDs whose client has received the message — the "Delivered" tier. */
  deliveredTo?: string[];
}

/** What the sender sees under their own message. */
export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'seen';

export interface Chat {
  id: string;
  type: 'direct' | 'group';
  participants: string[]; // User IDs
  lastMessage?: {
    content: string;
    senderId: string;
    createdAt: any;
    type?: 'text' | 'image' | 'voice' | 'post';
    readBy?: string[];
  };
  name?: string; // For groups
  photoURL?: string; // For groups
  createdBy?: string; // For groups
  admins?: string[]; // For groups
  updatedAt: any;
}

/**
 * Mirrors the `notification_type` enum in Postgres. The two note kinds were
 * added in 0025: an invitation to a note space, and a reminder falling due.
 */
export type NotificationType =
  | 'like' | 'comment' | 'message' | 'follow' | 'reaction' | 'mention'
  | 'note_invite' | 'note_reminder';

export interface Notification {
  id: string;
  toUserId: string;
  type: NotificationType;
  /**
   * A qualifier whose meaning depends on `type`: the medium for a comment,
   * and for a note_invite which direction it is going — 'accepted' is the
   * owner's copy saying someone joined, absent is the invitee's copy asking
   * them to. The column is free text in Postgres; this union is the set the
   * app actually writes.
   */
  subType?: 'text' | 'image' | 'voice' | 'accepted';
  content?: string;
  fromUserId: string;
  referenceId: string;
  /** Set on note_invite and note_reminder. The invite's Accept/Decline acts on
   *  this, so it stays a field of its own rather than sharing referenceId. */
  noteSpaceId?: string;
  noteId?: string;
  postUserId?: string;
  isRead: boolean;
  createdAt: number;
  fromUser?: User;
}

export interface MusicHistory {
  id: string;
  userId: string;
  youtubeId: string;
  title: string;
  artist: string;
  coverUrl: string;
  startTime: number;
  type: 'used' | 'listened';
  createdAt: any;
}

/**
 * `spaces` is the nav destination; `map` is still a view, just no longer one
 * you reach from the bar. Opening a map space from the hub switches to it, and
 * it keeps its own entry here because the map needs a full-height layout that
 * the hub does not.
 */
export type View = 'feed' | 'chat' | 'profile' | 'notifications' | 'search' | 'spaces' | 'map' | 'settings' | 'auth';
