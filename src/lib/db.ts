import { supabase, resolveStorageUrl, uploadFile } from './supabase';
import type { User, Post, Comment, Message, Chat, Notification, ThemeSong, MusicHistory } from '../types';
import type { RealtimeChannel } from '@supabase/supabase-js';

/**
 * Data-access layer over Supabase.
 *
 * Components talk to this, never to `supabase.from(...)` directly. Three
 * reasons that matters here:
 *
 *  1. **Shape compatibility.** Postgres returns snake_case rows with `id`;
 *     the app's components are written against camelCase objects with `uid`.
 *     Mapping at this boundary means converting a component is a change to its
 *     data calls, not a rewrite of its JSX.
 *
 *  2. **Realtime is not onSnapshot.** Firestore re-ran your whole query and
 *     handed back a result set. Supabase Realtime pushes single-row deltas
 *     with a one-column server-side filter. Every subscription helper below
 *     encapsulates that difference so callers get "here is the new row" and
 *     merge it themselves, which is the only pattern that actually works.
 *
 *  3. **Joins replace fan-out.** Firestore forced N+1 reads to attach an
 *     author to a post. Postgres does it in the same query.
 *
 * NOTE ON `uid`: rows are mapped to include BOTH `id` and `uid` with the same
 * value. `uid` is a compatibility alias so existing components keep working
 * during the migration; it should be removed once every file is converted.
 */

// =============================================================================
// Realtime channels
// =============================================================================

/**
 * Creates a `postgres_changes` channel with a topic nothing else can claim.
 *
 * ── THE BUG THIS FIXES ───────────────────────────────────────────────────────
 * These helpers used fixed topics — `inbox`, `posts:new`, `user:<id>`. Two
 * subscribers asking for the same topic get the SAME underlying channel, and
 * once a channel has been `subscribe()`d, binding another listener to it
 * throws:
 *
 *     cannot add 'postgres_changes' callbacks for realtime after 'subscribe()'
 *
 * which aborts the caller and takes the screen down with it. `inbox` had three
 * simultaneous subscribers: two in App.tsx (badges, delivery receipts) and one
 * in ChatView.
 *
 * React StrictMode made it worse and non-obvious. It runs every effect twice in
 * development — mount, clean up, mount again — and `removeChannel()` is async,
 * so the first channel is still being torn down when the second claims the
 * topic. That is why it looked intermittent and only in dev.
 *
 * A per-instance suffix removes both. The topic is a client-side identifier
 * only; the server binds on the filter, so uniqueness costs nothing.
 *
 * NOT for Presence. A presence channel's topic is how peers find each other —
 * `typingChannel` must keep its shared, deterministic name.
 */
let channelSeq = 0;
function changesChannel(prefix: string): RealtimeChannel {
  channelSeq += 1;
  return supabase.channel(`${prefix}#${channelSeq}`);
}

// =============================================================================
// Row → app-object mappers
// =============================================================================

type Row = Record<string, any>;

function mapSong(row: Row | null | undefined): ThemeSong | undefined {
  if (!row) return undefined;
  return {
    youtubeId: row.youtube_id,
    title: row.title,
    artist: row.artist ?? '',
    coverUrl: row.cover_url ?? '',
    startTime: row.start_time ?? 0,
  };
}

export function mapUser(row: Row | null | undefined): User | undefined {
  if (!row) return undefined;
  return {
    uid: row.id,
    id: row.id,
    username: row.username,
    displayName: row.display_name ?? row.username,
    email: row.email ?? '',
    photoURL: row.photo_url ?? '',
    bio: row.bio ?? '',
    createdAt: row.created_at,
    status: row.status ?? 'offline',
    lastActive: row.last_active,
    themeSong: mapSong(row.theme_song),
    termsVersion: row.terms_version ?? undefined,
    termsAcceptedAt: row.terms_accepted_at ?? undefined,
  } as User;
}

/** Collapses the reaction rows for one target back into the `{emoji: uid[]}`
 *  map the existing components render. */
function mapReactions(rows: Row[] | null | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const row of rows ?? []) {
    (out[row.emoji] ??= []).push(row.user_id);
  }
  return out;
}

export function mapPost(row: Row): Post {
  const images = (row.post_images ?? [])
    .slice()
    .sort((a: Row, b: Row) => a.position - b.position)
    .map((i: Row) => i.url);

  return {
    id: row.id,
    userId: row.user_id,
    content: row.content ?? '',
    type: row.type ?? 'text',
    visibility: row.visibility ?? 'public',
    imageUrls: images,
    imageUrl: images[0],
    voiceUrl: row.voice_url ?? undefined,
    likesCount: row.likes_count ?? 0,
    commentsCount: row.comments_count ?? 0,
    createdAt: row.created_at,
    user: mapUser(row.users ?? row.author),
    song: mapSong(row.songs ?? row.song),
    reactions: mapReactions(row.post_reactions),
    editHistory: (row.post_edits ?? []).map((e: Row) => ({
      content: e.previous_content,
      editedAt: e.edited_at,
    })),
  } as Post;
}

export function mapComment(row: Row): Comment {
  return {
    id: row.id,
    postId: row.post_id,
    userId: row.user_id,
    content: row.content ?? '',
    type: row.type ?? 'text',
    imageUrl: row.image_url ?? undefined,
    voiceUrl: row.voice_url ?? undefined,
    replyToId: row.reply_to_id ?? undefined,
    createdAt: row.created_at,
    user: mapUser(row.users),
    reactions: mapReactions(row.comment_reactions),
  } as Comment;
}

export function mapMessage(row: Row): Message {
  return {
    id: row.id,
    chatId: row.conversation_id,
    senderId: row.sender_id ?? 'system',
    content: row.content ?? '',
    type: row.type ?? 'text',
    imageUrl: row.image_url ?? undefined,
    voiceUrl: row.voice_url ?? undefined,
    replyToId: row.reply_to_id ?? undefined,
    postId: row.shared_post_id ?? undefined,
    createdAt: row.created_at,
    // Receipts arrive as rows; components expect uid arrays.
    readBy: (row.message_receipts ?? [])
      .filter((r: Row) => r.read_at)
      .map((r: Row) => r.user_id),
    deliveredTo: (row.message_receipts ?? [])
      .filter((r: Row) => r.delivered_at)
      .map((r: Row) => r.user_id),
    reactions: mapReactions(row.message_reactions),
  } as Message;
}

export function mapConversation(row: Row, currentUserId: string): Chat {
  const members: Row[] = row.conversation_members ?? [];
  const last = Array.isArray(row.messages) ? row.messages[0] : row.last_message;

  return {
    id: row.id,
    type: row.type,
    participants: members.map((m) => m.user_id),
    admins: members.filter((m) => m.role === 'admin').map((m) => m.user_id),
    name: row.name ?? undefined,
    photoURL: row.photo_url ?? undefined,
    createdBy: row.created_by ?? undefined,
    updatedAt: row.updated_at,
    lastMessage: last
      ? {
          content: last.content ?? '',
          senderId: last.sender_id ?? 'system',
          createdAt: last.created_at,
          type: last.type ?? 'text',
          readBy: (last.message_receipts ?? [])
            .filter((r: Row) => r.read_at)
            .map((r: Row) => r.user_id),
        }
      : undefined,
    // Not part of the Firestore shape, but every inbox row needs it and the
    // join already has it — avoids a per-row lookup in ConversationItem.
    otherUser: row.type === 'direct'
      ? mapUser(members.find((m) => m.user_id !== currentUserId)?.users)
      : undefined,
    // Full member list, so opening a conversation needs no extra round trip.
    members: members.map((m) => mapUser(m.users)).filter(Boolean) as User[],
  } as Chat & { otherUser?: User; members?: User[] };
}

// =============================================================================
// Select fragments — kept here so a shape change is one edit, not twenty
// =============================================================================

const USER_FIELDS = 'id, username, display_name, email, photo_url, bio, status, last_active, created_at, terms_version, terms_accepted_at';
const USER_WITH_SONG = `${USER_FIELDS}, theme_song:songs(*)`;

const POST_SELECT = `
  id, user_id, content, type, visibility, voice_url, likes_count, comments_count, created_at,
  users!posts_user_id_fkey(${USER_FIELDS}),
  songs(*),
  post_images(position, url),
  post_reactions(user_id, emoji),
  post_edits(previous_content, edited_at)
`;

const MESSAGE_SELECT = `
  id, conversation_id, sender_id, content, type, image_url, voice_url,
  reply_to_id, shared_post_id, created_at,
  message_receipts(user_id, delivered_at, read_at),
  message_reactions(user_id, emoji)
`;

// =============================================================================
// Auth
// =============================================================================

export const auth = {
  async getSession() {
    const { data } = await supabase.auth.getSession();
    return data.session;
  },

  /** Mirrors Firebase's onAuthStateChanged. Returns an unsubscribe function. */
  onChange(callback: (userId: string | null) => void): () => void {
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      callback(session?.user?.id ?? null);
    });
    return () => data.subscription.unsubscribe();
  },

  async signIn(email: string, password: string) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  },

  /**
   * Creates the account. The `public.users` profile row is created by the
   * `on_auth_user_created` trigger in the same transaction, from the metadata
   * passed here — see 0009_profile_on_signup.sql.
   *
   * Do not follow this with a client-side profile insert. With email
   * confirmation enabled there is no session yet, so that insert runs
   * unauthenticated and RLS rejects it, leaving an account with no profile.
   */
  async signUp(email: string, password: string, profile: {
    username: string; displayName: string; termsVersion?: string;
  }) {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          username: profile.username,
          display_name: profile.displayName,
          terms_version: profile.termsVersion ?? '',
        },
      },
    });
    if (error) throw error;
    return data;
  },

  async signOut() {
    await supabase.auth.signOut();
  },

  async resetPassword(email: string, redirectTo: string) {
    return supabase.auth.resetPasswordForEmail(email, { redirectTo });
  },
};

// =============================================================================
// Users
// =============================================================================

export const users = {
  async get(id: string): Promise<User | undefined> {
    const { data } = await supabase.from('users').select(USER_WITH_SONG).eq('id', id).maybeSingle();
    return mapUser(data);
  },

  /** Live profile subscription — replaces onSnapshot on the user document. */
  subscribe(id: string, onChange: (user: User) => void): () => void {
    const channel = changesChannel(`user:${id}`)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'users', filter: `id=eq.${id}` },
        (payload) => {
          const mapped = mapUser(payload.new as Row);
          if (mapped) onChange(mapped);
        })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  },

  async createProfile(profile: {
    id: string; username: string; displayName: string; email: string;
    termsVersion?: string;
  }) {
    const { error } = await supabase.from('users').insert({
      id: profile.id,
      username: profile.username,
      display_name: profile.displayName,
      email: profile.email,
      terms_version: profile.termsVersion ?? null,
      terms_accepted_at: profile.termsVersion ? new Date().toISOString() : null,
    });
    if (error) throw error;
  },

  /**
   * Recovers an account whose profile row is missing.
   *
   * Signup creates both rows in one transaction (0009), so this should never
   * fire for an account made through the app. It fires for accounts created
   * some other way — most often the Supabase dashboard's "Add user", which
   * writes no `raw_user_meta_data` and therefore skips the trigger. Without
   * this, such an account authenticates successfully and is then rejected by
   * the app forever, with no way for the user to fix it.
   *
   * Runs as the signed-in user, so `users_insert_own` (id = auth.uid()) is
   * satisfied — no elevated privileges involved, and it can only ever create
   * the caller's own row.
   *
   * Returns null when there is nothing safe to build a profile from. A username
   * is not guessable: it is public, unique, and permanent, so inventing one
   * from an email address would hand someone a handle they never chose.
   */
  async ensureProfile(userId: string): Promise<User | null> {
    const existing = await users.get(userId);
    if (existing) return existing;

    const { data: authData } = await supabase.auth.getUser();
    const authUser = authData.user;
    if (!authUser || authUser.id !== userId) return null;

    const meta = (authUser.user_metadata ?? {}) as Record<string, unknown>;
    const username = typeof meta.username === 'string' ? meta.username.trim() : '';
    if (!username) return null; // nothing to recover from — caller must explain

    const displayName =
      typeof meta.display_name === 'string' && meta.display_name.trim()
        ? meta.display_name.trim()
        : username;

    const { error } = await supabase.from('users').insert({
      id: userId,
      username,
      display_name: displayName,
      email: authUser.email ?? '',
    });
    if (error) {
      console.error('[auth] could not repair missing profile', error.message);
      return null;
    }
    return (await users.get(userId)) ?? null;
  },

  async update(id: string, patch: {
    displayName?: string; bio?: string; photoURL?: string | null;
    themeSongId?: string | null; termsVersion?: string;
  }) {
    const row: Row = {};
    if (patch.displayName !== undefined) row.display_name = patch.displayName;
    if (patch.bio !== undefined) row.bio = patch.bio;
    if (patch.photoURL !== undefined) row.photo_url = patch.photoURL;
    if (patch.themeSongId !== undefined) row.theme_song_id = patch.themeSongId;
    // terms_accepted_at is deliberately absent: the users_stamp_consent_time
    // trigger sets it from the server clock, and the column is not granted to
    // this role. A compliance record dated by the client is not a record.
    if (patch.termsVersion !== undefined) row.terms_version = patch.termsVersion;
    const { error } = await supabase.from('users').update(row).eq('id', id);
    if (error) throw error;
  },

  async setPresence(id: string, status: 'active' | 'idle' | 'offline') {
    await supabase.from('users')
      .update({ status, last_active: new Date().toISOString() })
      .eq('id', id);
  },

  /**
   * Substring search. Firestore could not do this — SearchView fetched 100
   * users and filtered in the browser. This is a real indexed query against
   * the trigram indexes, so it scales and returns the whole matching set.
   */
  async search(term: string, excludeId: string, limit = 20): Promise<User[]> {
    const pattern = `%${term.replace(/[%_]/g, '\\$&')}%`;
    const { data } = await supabase
      .from('users')
      .select(USER_FIELDS)
      .or(`username.ilike.${pattern},display_name.ilike.${pattern}`)
      .neq('id', excludeId)
      .limit(limit);
    return (data ?? []).map(mapUser).filter(Boolean) as User[];
  },

  /**
   * Exact lookup by username or email, for "start a conversation with…".
   *
   * Firestore needed two separate queries because it cannot OR across fields;
   * Postgres does it in one.
   */
  async findByHandle(term: string, excludeId: string): Promise<User | null> {
    const needle = term.trim().toLowerCase();
    if (!needle) return null;
    const { data } = await supabase
      .from('users')
      .select(USER_FIELDS)
      .or(`username.eq.${needle},email.eq.${needle}`)
      .neq('id', excludeId)
      .limit(1)
      .maybeSingle();
    return mapUser(data) ?? null;
  },

  /**
   * The `users_username_check` constraint, mirrored for client-side validation.
   *
   * Kept identical to the database on purpose: signup writes the profile row
   * inside the same transaction as the auth account, so a violation rolls the
   * whole signup back and GoTrue reports only "Database error saving new user"
   * — no code, no column, no hint. Catching it here turns that dead end into a
   * specific message before the request is ever sent.
   */
  USERNAME_PATTERN: /^[a-z0-9_]{3,30}$/,

  /** Null when the handle is usable, or a reason string when it is not. */
  async usernameProblem(username: string): Promise<string | null> {
    // Format is checked locally so an obviously-bad handle costs no round trip.
    if (!users.USERNAME_PATTERN.test(username)) {
      return 'Usernames must be 3–30 characters: lowercase letters, numbers and underscores only.';
    }

    // Uniqueness goes through the `username_available` RPC, NOT a select.
    //
    // A `select count(*) from users where username = ...` looks equivalent and
    // is worthless here: at signup the caller is still `anon`, `users_select`
    // is `to authenticated`, and RLS hides every row — so the count is always
    // zero and every username reports as free. That was verified against a
    // handle that definitely existed. The RPC is SECURITY DEFINER, so it sees
    // the row.
    const { data, error } = await supabase.rpc('username_available', { candidate: username });

    // Fail open on a network or permission error: the database constraint is
    // still the real guard, and blocking signup because a convenience check
    // could not run would be worse than letting the server reject it.
    if (error) {
      console.warn('[auth] username availability check failed', error.message);
      return null;
    }
    return data === false ? 'That username is already taken.' : null;
  },

  /**
   * Resolves @mentions to users in one round trip.
   *
   * Firestore ran a separate equality query per username because it has no
   * `in` over a collection scan; Postgres takes the whole list at once.
   */
  async byUsernames(names: string[]): Promise<User[]> {
    const unique = [...new Set(names.map((n) => n.toLowerCase()))].filter(Boolean);
    if (unique.length === 0) return [];
    const { data } = await supabase
      .from('users')
      .select(USER_FIELDS)
      .in('username', unique);
    return (data ?? []).map(mapUser).filter(Boolean) as User[];
  },

  /** Suggestions: people the viewer does not already follow. */
  async suggestions(viewerId: string, limit = 8): Promise<User[]> {
    const { data: following } = await supabase
      .from('follows').select('following_id').eq('follower_id', viewerId);
    const exclude = [viewerId, ...(following ?? []).map((f: Row) => f.following_id)];

    const { data } = await supabase
      .from('users')
      .select(USER_FIELDS)
      .not('id', 'in', `(${exclude.join(',')})`)
      .limit(limit);
    return (data ?? []).map(mapUser).filter(Boolean) as User[];
  },
};

// =============================================================================
// Follows
// =============================================================================

export const follows = {
  async following(userId: string): Promise<Set<string>> {
    const { data } = await supabase.from('follows').select('following_id').eq('follower_id', userId);
    return new Set((data ?? []).map((r: Row) => r.following_id));
  },

  async counts(userId: string): Promise<{ followers: number; following: number }> {
    const [{ count: followers }, { count: following }] = await Promise.all([
      supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', userId),
      supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', userId),
    ]);
    return { followers: followers ?? 0, following: following ?? 0 };
  },

  async isFollowing(followerId: string, targetId: string): Promise<boolean> {
    const { count } = await supabase.from('follows')
      .select('*', { count: 'exact', head: true })
      .eq('follower_id', followerId).eq('following_id', targetId);
    return (count ?? 0) > 0;
  },

  /** Idempotent thanks to the composite PK — the duplicate-follow bug that
   *  Firestore's addDoc allowed cannot happen. */
  async follow(followerId: string, targetId: string) {
    const { error } = await supabase.from('follows')
      .upsert({ follower_id: followerId, following_id: targetId }, { onConflict: 'follower_id,following_id' });
    if (error) throw error;
    await notifications.create({ recipientId: targetId, actorId: followerId, type: 'follow' });
  },

  async unfollow(followerId: string, targetId: string) {
    const { error } = await supabase.from('follows')
      .delete().eq('follower_id', followerId).eq('following_id', targetId);
    if (error) throw error;
  },

  /**
   * People you can @mention: everyone you follow plus everyone who follows you.
   *
   * Two queries and a client-side union — Firestore did the same but then
   * issued a getDoc per id on top, which was the expensive part.
   */
  async mentionable(userId: string): Promise<User[]> {
    const [following, followers] = await Promise.all([
      follows.list(userId, 'following'),
      follows.list(userId, 'followers'),
    ]);
    const seen = new Map<string, User>();
    for (const u of [...following, ...followers]) {
      if (u.uid !== userId) seen.set(u.uid, u);
    }
    return [...seen.values()];
  },

  async list(userId: string, kind: 'followers' | 'following'): Promise<User[]> {
    const column = kind === 'followers' ? 'following_id' : 'follower_id';
    const joined = kind === 'followers' ? 'follower' : 'following';
    const { data } = await supabase
      .from('follows')
      .select(`${joined}:users!follows_${joined}_id_fkey(${USER_FIELDS})`)
      .eq(column, userId);
    return (data ?? []).map((r: Row) => mapUser(r[joined])).filter(Boolean) as User[];
  },
};

// =============================================================================
// Posts
// =============================================================================

export interface FeedPage {
  posts: Post[];
  /** Pass back as `cursor` to fetch the next page. Null when exhausted. */
  nextCursor: string | null;
}

/** Fills in `recentLikers` for a page of posts using a single query. */
async function attachRecentLikers(list: Post[], perPost = 3): Promise<void> {
  const ids = list.filter((p) => (p.likesCount ?? 0) > 0).map((p) => p.id);
  if (ids.length === 0) return;

  const { data } = await supabase
    .from('likes')
    .select(`post_id, created_at, users(${USER_FIELDS})`)
    .in('post_id', ids)
    .order('created_at', { ascending: false });

  const byPost = new Map<string, User[]>();
  for (const row of (data ?? []) as Row[]) {
    const bucket = byPost.get(row.post_id) ?? [];
    if (bucket.length < perPost) {
      const user = mapUser(row.users);
      if (user) bucket.push(user);
      byPost.set(row.post_id, bucket);
    }
  }
  for (const post of list) post.recentLikers = byPost.get(post.id) ?? [];
}

export const posts = {
  /**
   * Feed page, newest first.
   *
   * Keyset pagination on created_at replaces Firestore's `startAfter(doc)`
   * cursors, and the whole thing is one query instead of Feed.tsx's current
   * five parallel chunked `in` queries plus an N+1 author fetch.
   *
   * RLS handles visibility, so a followers-only post from someone you do not
   * follow is filtered by the database rather than by the client.
   */
  async feed(viewerId: string, opts: { cursor?: string | null; limit?: number } = {}): Promise<FeedPage> {
    const limit = opts.limit ?? 15;

    const { data: followingRows } = await supabase
      .from('follows').select('following_id').eq('follower_id', viewerId);
    const authors = [viewerId, ...(followingRows ?? []).map((r: Row) => r.following_id)];

    let query = supabase
      .from('posts')
      .select(POST_SELECT)
      .in('user_id', authors)
      .order('created_at', { ascending: false })
      .limit(limit + 1);

    if (opts.cursor) query = query.lt('created_at', opts.cursor);

    const { data, error } = await query;
    if (error) throw error;

    let rows = data ?? [];

    // Discovery fallback, matching the current behaviour for new accounts.
    if (rows.length === 0 && !opts.cursor && authors.length < 5) {
      let discovery = supabase
        .from('posts').select(POST_SELECT)
        .eq('visibility', 'public')
        .order('created_at', { ascending: false })
        .limit(limit + 1);
      if (opts.cursor) discovery = discovery.lt('created_at', opts.cursor);
      rows = (await discovery).data ?? [];
    }

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const mapped = page.map(mapPost);

    // Recent likers for the avatar stack. One query for the whole page rather
    // than the per-post fetch the Firestore version did (15 posts × 3 likers
    // was up to 45 extra reads per page).
    await attachRecentLikers(mapped);

    return {
      posts: mapped,
      nextCursor: hasMore ? page[page.length - 1].created_at : null,
    };
  },

  async byUser(userId: string, limit = 21): Promise<Post[]> {
    const { data, error } = await supabase
      .from('posts').select(POST_SELECT)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []).map(mapPost);
  },

  async get(id: string): Promise<Post | null> {
    const { data } = await supabase.from('posts').select(POST_SELECT).eq('id', id).maybeSingle();
    return data ? mapPost(data) : null;
  },

  /** Any change to one author's posts — insert, edit, delete. A profile grid is
   *  small enough that refetching the page beats merging deltas by hand. */
  subscribeByUser(userId: string, onChange: () => void): () => void {
    const channel = changesChannel(`posts:user:${userId}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'posts', filter: `user_id=eq.${userId}` },
        () => onChange())
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  },

  async create(input: {
    userId: string; content: string; type?: 'text' | 'image' | 'voice';
    visibility?: 'public' | 'followers' | 'private';
    imageUrls?: string[]; voiceUrl?: string | null; songId?: string | null;
  }): Promise<string> {
    const { data, error } = await supabase.from('posts').insert({
      user_id: input.userId,
      content: input.content,
      type: input.type ?? 'text',
      visibility: input.visibility ?? 'public',
      voice_url: input.voiceUrl ?? null,
      song_id: input.songId ?? null,
    }).select('id').single();
    if (error) throw error;

    if (input.imageUrls?.length) {
      const { error: imageError } = await supabase.from('post_images').insert(
        input.imageUrls.map((url, position) => ({ post_id: data.id, position, url }))
      );
      if (imageError) throw imageError;
    }
    return data.id;
  },

  /** Records the previous text in post_edits, then updates — one round trip
   *  each, mirroring the arrayUnion(editHistory) the Firestore version did. */
  async update(id: string, previousContent: string, newContent: string) {
    const { error: historyError } = await supabase.from('post_edits')
      .insert({ post_id: id, previous_content: previousContent });
    if (historyError) throw historyError;

    const { error } = await supabase.from('posts').update({ content: newContent }).eq('id', id);
    if (error) throw error;
  },

  async remove(id: string) {
    const { error } = await supabase.from('posts').delete().eq('id', id);
    if (error) throw error;
  },

  /**
   * Live updates for one post row — counters, content, visibility.
   *
   * Firestore had to stream the whole likes and comments collections just to
   * measure their size; the counters are columns here, maintained by trigger,
   * so a single row subscription carries them.
   */
  subscribeToPost(postId: string, onChange: (post: Post) => void): () => void {
    const channel = changesChannel(`post:${postId}`)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'posts', filter: `id=eq.${postId}` },
        async () => {
          const full = await posts.get(postId);
          if (full) onChange(full);
        })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  },

  /** New posts from people you follow. Realtime cannot filter on `in`, so the
   *  author check happens client-side after the row arrives. */
  subscribeToNew(authorIds: Set<string>, onInsert: (post: Post) => void): () => void {
    const channel = changesChannel('posts:new')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'posts' },
        async (payload) => {
          const row = payload.new as Row;
          if (!authorIds.has(row.user_id)) return;
          // The delta has no joined author, so re-read the full shape.
          const full = await posts.get(row.id);
          if (full) onInsert(full);
        })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  },
};

// =============================================================================
// Likes and reactions
// =============================================================================

export const likes = {
  async byUser(userId: string): Promise<Set<string>> {
    const { data } = await supabase.from('likes').select('post_id').eq('user_id', userId);
    return new Set((data ?? []).map((r: Row) => r.post_id));
  },

  /** No counter write: the likes_count trigger owns it. */
  async like(postId: string, userId: string, postAuthorId: string) {
    const { error } = await supabase.from('likes')
      .upsert({ post_id: postId, user_id: userId }, { onConflict: 'post_id,user_id' });
    if (error) throw error;

    if (postAuthorId !== userId) {
      await notifications.create({
        recipientId: postAuthorId, actorId: userId, type: 'like', postId,
      });
    }
  },

  async unlike(postId: string, userId: string) {
    const { error } = await supabase.from('likes')
      .delete().eq('post_id', postId).eq('user_id', userId);
    if (error) throw error;
  },

  async recentLikers(postId: string, limit = 3): Promise<User[]> {
    const { data } = await supabase
      .from('likes')
      .select(`users(${USER_FIELDS})`)
      .eq('post_id', postId)
      .order('created_at', { ascending: false })
      .limit(limit);
    return (data ?? []).map((r: Row) => mapUser(r.users)).filter(Boolean) as User[];
  },
};

export const reactions = {
  /** One reaction per user per target — upsert replaces the read-modify-write
   *  of the old `{emoji: [uid]}` map, which could lose concurrent reactions. */
  async setOnPost(postId: string, userId: string, emoji: string | null) {
    if (emoji === null) {
      await supabase.from('post_reactions').delete().eq('post_id', postId).eq('user_id', userId);
      return;
    }
    const { error } = await supabase.from('post_reactions')
      .upsert({ post_id: postId, user_id: userId, emoji }, { onConflict: 'post_id,user_id' });
    if (error) throw error;
  },

  async setOnComment(commentId: string, userId: string, emoji: string | null) {
    if (emoji === null) {
      await supabase.from('comment_reactions').delete().eq('comment_id', commentId).eq('user_id', userId);
      return;
    }
    const { error } = await supabase.from('comment_reactions')
      .upsert({ comment_id: commentId, user_id: userId, emoji }, { onConflict: 'comment_id,user_id' });
    if (error) throw error;
  },

  async setOnMessage(messageId: string, userId: string, emoji: string | null) {
    if (emoji === null) {
      await supabase.from('message_reactions').delete().eq('message_id', messageId).eq('user_id', userId);
      return;
    }
    const { error } = await supabase.from('message_reactions')
      .upsert({ message_id: messageId, user_id: userId, emoji }, { onConflict: 'message_id,user_id' });
    if (error) throw error;
  },
};

// =============================================================================
// Comments
// =============================================================================

export const comments = {
  async list(postId: string): Promise<Comment[]> {
    const { data, error } = await supabase
      .from('comments')
      .select(`id, post_id, user_id, content, type, image_url, voice_url, reply_to_id, created_at,
               users(${USER_FIELDS}), comment_reactions(user_id, emoji)`)
      .eq('post_id', postId)
      .order('created_at', { ascending: false });
    if (error) throw error;

    const list = (data ?? []).map(mapComment);

    // Firestore stored `replyToContent` / `replyToSenderName` denormalised on
    // every reply, so an edited or deleted parent left a stale quote behind.
    // The parent is already in this result set, so derive the preview instead.
    const byId = new Map(list.map((c) => [c.id, c]));
    for (const c of list) {
      if (!c.replyToId) continue;
      const parent = byId.get(c.replyToId);
      const target = c as Comment & { replyToContent?: string; replyToSenderName?: string };
      target.replyToSenderName = parent?.user?.displayName ?? 'Anonymous';
      target.replyToContent = !parent
        ? 'Comment removed'
        : parent.type === 'image' ? 'Image'
        : parent.type === 'voice' ? 'Voice Message'
        : parent.content;
    }
    return list;
  },

  async add(input: {
    postId: string; userId: string; content: string;
    type?: 'text' | 'image' | 'voice'; imageUrl?: string | null;
    voiceUrl?: string | null; replyToId?: string | null; postAuthorId: string;
    notifyContent?: string;
  }): Promise<string> {
    const type = input.type ?? 'text';
    const { data, error } = await supabase.from('comments').insert({
      post_id: input.postId, user_id: input.userId, content: input.content,
      type, image_url: input.imageUrl ?? null,
      voice_url: input.voiceUrl ?? null, reply_to_id: input.replyToId ?? null,
    }).select('id').single();
    if (error) throw error;

    // create() is a no-op when author and commenter are the same person.
    await notifications.create({
      recipientId: input.postAuthorId, actorId: input.userId,
      type: 'comment', subtype: type, postId: input.postId,
      content: (input.notifyContent ?? input.content).slice(0, 100),
    });
    return data.id;
  },

  async remove(id: string) {
    const { error } = await supabase.from('comments').delete().eq('id', id);
    if (error) throw error;
  },

  subscribe(postId: string, onChange: () => void): () => void {
    const channel = changesChannel(`comments:${postId}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'comments', filter: `post_id=eq.${postId}` },
        () => onChange())
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  },
};

// =============================================================================
// Conversations and messages
// =============================================================================

export const chats = {
  async list(userId: string): Promise<Chat[]> {
    const { data, error } = await supabase
      .from('conversations')
      .select(`
        id, type, name, photo_url, created_by, created_at, updated_at,
        conversation_members(user_id, role, last_read_at, users(${USER_FIELDS})),
        messages(id, content, sender_id, type, created_at, message_receipts(user_id, read_at))
      `)
      .order('updated_at', { ascending: false })
      .limit(50);
    if (error) throw error;

    // Keep only the newest message per conversation for the inbox preview.
    for (const row of data ?? []) {
      if (Array.isArray((row as Row).messages)) {
        (row as Row).messages = (row as Row).messages
          .sort((a: Row, b: Row) => (a.created_at < b.created_at ? 1 : -1))
          .slice(0, 1);
      }
    }
    return (data ?? []).map((row) => mapConversation(row, userId));
  },

  /** One conversation in the same shape `list()` produces, so a caller that
   *  just created a group can select it without waiting for an inbox refresh. */
  async get(conversationId: string, userId: string): Promise<Chat | null> {
    const { data, error } = await supabase
      .from('conversations')
      .select(`
        id, type, name, photo_url, created_by, created_at, updated_at,
        conversation_members(user_id, role, last_read_at, users(${USER_FIELDS})),
        messages(id, content, sender_id, type, created_at, message_receipts(user_id, read_at))
      `)
      .eq('id', conversationId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;

    if (Array.isArray((data as Row).messages)) {
      (data as Row).messages = (data as Row).messages
        .sort((a: Row, b: Row) => (a.created_at < b.created_at ? 1 : -1))
        .slice(0, 1);
    }
    return mapConversation(data, userId);
  },

  async messages(conversationId: string, opts: { cursor?: string | null; limit?: number } = {}) {
    const limit = opts.limit ?? 50;
    let query = supabase
      .from('messages').select(MESSAGE_SELECT)
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(limit + 1);
    if (opts.cursor) query = query.lt('created_at', opts.cursor);

    const { data, error } = await query;
    if (error) throw error;

    const rows = data ?? [];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      // Oldest-first for rendering; the query is newest-first for the cursor.
      messages: page.map(mapMessage).reverse(),
      nextCursor: hasMore ? page[page.length - 1].created_at : null,
    };
  },

  async send(input: {
    conversationId: string; senderId: string; content: string;
    type?: 'text' | 'image' | 'voice' | 'post';
    imageUrl?: string | null; voiceUrl?: string | null;
    replyToId?: string | null; sharedPostId?: string | null;
  }): Promise<string> {
    // No lastMessage write and no updatedAt write — the touch_conversation
    // trigger handles inbox ordering, and fan_out_message_receipts creates the
    // pending receipts. Both used to be separate client writes that could fail
    // independently and leave the inbox stale.
    const { data, error } = await supabase.from('messages').insert({
      conversation_id: input.conversationId,
      sender_id: input.senderId,
      content: input.content,
      type: input.type ?? 'text',
      image_url: input.imageUrl ?? null,
      voice_url: input.voiceUrl ?? null,
      reply_to_id: input.replyToId ?? null,
      shared_post_id: input.sharedPostId ?? null,
    }).select('id').single();
    if (error) throw error;
    return data.id;
  },

  async removeMessage(messageId: string) {
    const { error } = await supabase.from('messages').delete().eq('id', messageId);
    if (error) throw error;
  },

  /** Marks everything in the conversation read for this user. */
  async markRead(conversationId: string, userId: string) {
    const now = new Date().toISOString();
    await supabase.from('conversation_members')
      .update({ last_read_at: now })
      .eq('conversation_id', conversationId).eq('user_id', userId);

    const { data: ids } = await supabase.from('messages')
      .select('id').eq('conversation_id', conversationId);
    if (!ids?.length) return;

    await supabase.from('message_receipts')
      .update({ read_at: now, delivered_at: now })
      .eq('user_id', userId)
      .is('read_at', null)
      .in('message_id', ids.map((m: Row) => m.id));
  },

  /** Receipts addressed to this user that have not been acknowledged yet. */
  async pendingDelivery(userId: string, limit = 200): Promise<string[]> {
    const { data } = await supabase
      .from('message_receipts')
      .select('message_id')
      .eq('user_id', userId)
      .is('delivered_at', null)
      .limit(limit);
    return (data ?? []).map((r: Row) => r.message_id);
  },

  /** Delivery acknowledgement — the "Delivered" tier. */
  async markDelivered(messageIds: string[], userId: string) {
    if (messageIds.length === 0) return;
    await supabase.from('message_receipts')
      .update({ delivered_at: new Date().toISOString() })
      .eq('user_id', userId).is('delivered_at', null).in('message_id', messageIds);
  },

  async unreadCount(userId: string): Promise<number> {
    const { count } = await supabase.from('message_receipts')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId).is('read_at', null);
    return count ?? 0;
  },

  /**
   * Live messages for one conversation.
   *
   * `filter` is a single server-side equality — the one case Realtime supports
   * well. The delta carries no joins, so the row is re-read to get receipts
   * and reactions before handing it to the caller.
   */
  subscribeToMessages(
    conversationId: string,
    handlers: { onInsert?: (m: Message) => void; onDelete?: (id: string) => void }
  ): () => void {
    const channel = changesChannel(`messages:${conversationId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` },
        async (payload) => {
          const { data } = await supabase.from('messages')
            .select(MESSAGE_SELECT).eq('id', (payload.new as Row).id).maybeSingle();
          if (data) handlers.onInsert?.(mapMessage(data));
        })
      .on('postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` },
        (payload) => handlers.onDelete?.((payload.old as Row).id))
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  },

  /** Inbox ordering changes. Any message anywhere bumps a conversation. */
  subscribeToInbox(onChange: () => void): () => void {
    const channel = changesChannel('inbox')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversations' }, () => onChange())
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, () => onChange())
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  },

  /**
   * Typing indicators via Realtime Presence, not a table.
   *
   * The Firestore version wrote a document per keystroke. Presence is
   * ephemeral broadcast state — no database writes at all.
   */
  typingChannel(conversationId: string, userId: string): {
    channel: RealtimeChannel;
    setTyping: (isTyping: boolean) => void;
    onTypingChange: (cb: (userIds: string[]) => void) => void;
    close: () => void;
  } {
    const channel = supabase.channel(`typing:${conversationId}`, {
      config: { presence: { key: userId } },
    });

    let listener: ((ids: string[]) => void) | null = null;

    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState<{ typing: boolean }>();
      const typing = Object.entries(state)
        .filter(([id, metas]) => id !== userId && metas.some((m) => m.typing))
        .map(([id]) => id);
      listener?.(typing);
    });

    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') void channel.track({ typing: false });
    });

    return {
      channel,
      setTyping: (isTyping: boolean) => { void channel.track({ typing: isTyping }); },
      onTypingChange: (cb) => { listener = cb; },
      close: () => { void supabase.removeChannel(channel); },
    };
  },

  /**
   * Finds the existing direct conversation with someone, or creates one.
   *
   * The direct_conversation_keys unique constraint prevents the duplicate
   * threads Firestore allowed when both people started a chat at once.
   */
  async openDirect(currentUserId: string, otherUserId: string): Promise<string> {
    const { data: mine } = await supabase
      .from('conversation_members')
      .select('conversation_id, conversations!inner(type)')
      .eq('user_id', currentUserId);

    const candidateIds = (mine ?? [])
      .filter((r: Row) => r.conversations?.type === 'direct')
      .map((r: Row) => r.conversation_id);

    if (candidateIds.length > 0) {
      const { data: shared } = await supabase
        .from('conversation_members')
        .select('conversation_id')
        .eq('user_id', otherUserId)
        .in('conversation_id', candidateIds);
      if (shared?.length) return shared[0].conversation_id;
    }

    const { data: created, error } = await supabase.from('conversations')
      .insert({ type: 'direct', created_by: currentUserId }).select('id').single();
    if (error) throw error;

    const { error: memberError } = await supabase.from('conversation_members').insert([
      { conversation_id: created.id, user_id: currentUserId, role: 'member' },
      { conversation_id: created.id, user_id: otherUserId, role: 'member' },
    ]);
    if (memberError) throw memberError;

    return created.id;
  },

  async createGroup(input: {
    name: string; createdBy: string; memberIds: string[]; photoUrl?: string | null;
  }): Promise<string> {
    const { data, error } = await supabase.from('conversations').insert({
      type: 'group', name: input.name, created_by: input.createdBy,
      photo_url: input.photoUrl ?? null,
    }).select('id').single();
    if (error) throw error;

    const rows = [
      { conversation_id: data.id, user_id: input.createdBy, role: 'admin' as const },
      ...input.memberIds
        .filter((id) => id !== input.createdBy)
        .map((id) => ({ conversation_id: data.id, user_id: id, role: 'member' as const })),
    ];
    const { error: memberError } = await supabase.from('conversation_members').insert(rows);
    if (memberError) throw memberError;

    return data.id;
  },

  /** Group name / photo. RLS restricts this to admins. */
  async updateGroup(conversationId: string, patch: { name?: string; photoUrl?: string | null }) {
    const row: Row = {};
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.photoUrl !== undefined) row.photo_url = patch.photoUrl;
    const { error } = await supabase.from('conversations').update(row).eq('id', conversationId);
    if (error) throw error;
  },

  /**
   * System notice ("X added Y", "X left the group").
   *
   * sender_id is null rather than the literal string 'system' the Firestore
   * version used — the column is a real FK to users, so an unowned message is
   * expressed as NULL. The `type` enum carries the meaning.
   */
  async sendSystem(conversationId: string, content: string) {
    const { error } = await supabase.from('messages').insert({
      conversation_id: conversationId,
      sender_id: null,
      content,
      type: 'system',
    });
    if (error) throw error;
  },

  async addMember(conversationId: string, userId: string) {
    const { error } = await supabase.from('conversation_members')
      .upsert({ conversation_id: conversationId, user_id: userId, role: 'member' },
              { onConflict: 'conversation_id,user_id' });
    if (error) throw error;
  },

  async leave(conversationId: string, userId: string) {
    const { error } = await supabase.from('conversation_members')
      .delete().eq('conversation_id', conversationId).eq('user_id', userId);
    if (error) throw error;
  },

  /** Deleting the conversation cascades to messages, members and receipts. */
  async removeConversation(conversationId: string) {
    const { error } = await supabase.from('conversations').delete().eq('id', conversationId);
    if (error) throw error;
  },
};

// =============================================================================
// Notifications
// =============================================================================

export const notifications = {
  async list(userId: string, limit = 50): Promise<Notification[]> {
    const { data, error } = await supabase
      .from('notifications')
      .select(`id, recipient_id, actor_id, type, subtype, content, post_id, conversation_id,
               is_read, created_at, actor:users!notifications_actor_id_fkey(${USER_FIELDS})`)
      .eq('recipient_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;

    return (data ?? []).map((row: Row) => ({
      id: row.id,
      toUserId: row.recipient_id,
      fromUserId: row.actor_id,
      type: row.type,
      subType: row.subtype ?? undefined,
      content: row.content ?? undefined,
      referenceId: row.post_id ?? row.conversation_id ?? '',
      isRead: row.is_read,
      createdAt: row.created_at,
      fromUser: mapUser(row.actor),
    })) as Notification[];
  },

  async create(input: {
    recipientId: string; actorId: string;
    type: 'like' | 'comment' | 'message' | 'follow' | 'reaction' | 'mention';
    postId?: string; conversationId?: string; content?: string; subtype?: string;
  }) {
    if (input.recipientId === input.actorId) return; // never notify yourself
    await supabase.from('notifications').insert({
      recipient_id: input.recipientId,
      actor_id: input.actorId,
      type: input.type,
      subtype: input.subtype ?? null,
      content: input.content ?? null,
      post_id: input.postId ?? null,
      conversation_id: input.conversationId ?? null,
    });
  },

  async unreadCount(userId: string): Promise<number> {
    const { count } = await supabase.from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('recipient_id', userId).eq('is_read', false);
    return count ?? 0;
  },

  async markRead(id: string) {
    await supabase.from('notifications').update({ is_read: true }).eq('id', id);
  },

  async markAllRead(userId: string) {
    await supabase.from('notifications')
      .update({ is_read: true }).eq('recipient_id', userId).eq('is_read', false);
  },

  subscribe(userId: string, onChange: () => void): () => void {
    const channel = changesChannel(`notifications:${userId}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${userId}` },
        () => onChange())
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  },
};

// =============================================================================
// Songs and music history
// =============================================================================

export const songs = {
  /**
   * Songs are shared reference data keyed on the YouTube id.
   *
   * Insert-if-absent then read, rather than a true upsert. An upsert compiles
   * to `INSERT ... ON CONFLICT DO UPDATE`, which needs UPDATE permission on a
   * table every signed-in user can reach — meaning anyone could rewrite the
   * title and artist of a track already referenced by other people's posts.
   * `ignoreDuplicates` compiles to `DO NOTHING`, so INSERT alone is enough.
   */
  async upsert(song: ThemeSong): Promise<string> {
    const { error } = await supabase.from('songs').upsert({
      youtube_id: song.youtubeId,
      title: song.title,
      artist: song.artist ?? '',
      cover_url: song.coverUrl ?? null,
      start_time: song.startTime ?? 0,
    }, { onConflict: 'youtube_id', ignoreDuplicates: true });
    if (error) throw error;

    const { data, error: readError } = await supabase
      .from('songs').select('id').eq('youtube_id', song.youtubeId).single();
    if (readError) throw readError;
    return data.id;
  },

  async recordPlay(userId: string, song: ThemeSong, kind: 'used' | 'listened') {
    const songId = await songs.upsert(song);
    await supabase.from('music_history').insert({ user_id: userId, song_id: songId, kind });
  },

  /** Flattened to the shape the picker renders. Firestore stored a full copy of
   *  the track on every history row; here the join reassembles it. */
  async history(userId: string, limit = 20): Promise<MusicHistory[]> {
    const { data } = await supabase
      .from('music_history').select('id, user_id, kind, created_at, songs(*)')
      .eq('user_id', userId).order('created_at', { ascending: false }).limit(limit);

    return (data ?? [])
      .map((r: Row) => {
        const song = mapSong(r.songs);
        if (!song) return null;
        return {
          id: r.id,
          userId: r.user_id,
          youtubeId: song.youtubeId,
          title: song.title,
          artist: song.artist,
          coverUrl: song.coverUrl,
          startTime: song.startTime ?? 0,
          type: r.kind,
          createdAt: r.created_at,
        } as MusicHistory;
      })
      .filter(Boolean) as MusicHistory[];
  },
};

export { resolveStorageUrl, uploadFile };
