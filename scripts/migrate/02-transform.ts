/**
 * Step 2 — Transform exported Firestore documents into Postgres rows.
 *
 *   npx tsx scripts/migrate/02-transform.ts
 *
 * Pure function of the export: reads migration-data/firestore/, writes
 * migration-data/postgres/. Touches no network and no database, so it is safe
 * to run repeatedly while tuning the mapping.
 *
 * Every record that cannot be placed is recorded in issues-transform.json with
 * its source path. Nothing is dropped without a trace.
 */

import path from 'node:path';
import {
  ensureDirs, readJson, writeJson, RAW_DIR, OUT_DIR, DATA_DIR,
  IssueLog, IdMap, toTimestamp, toText, toNullableText, normalizeUsername,
} from './shared';

interface Doc { id: string; path: string; data: any; subcollections?: Record<string, Doc[]> }
interface AuthUser { uid: string; email?: string; displayName?: string; disabled: boolean; createdAt?: string; hasPassword: boolean }

const issues = new IssueLog();

// Namespaced so identical Firestore ids in different collections never collide.
const userIds    = new IdMap('user');
const postIds    = new IdMap('post');
const commentIds = new IdMap('comment');
const convIds    = new IdMap('conversation');
const messageIds = new IdMap('message');
const songIds    = new IdMap('song');

const load = (name: string): Doc[] => {
  try { return readJson<Doc[]>(path.join(RAW_DIR, `${name}.json`)); }
  catch { issues.warn(name, `Export file missing; treated as empty`); return []; }
};

// --- Song deduplication ------------------------------------------------------
// Firestore embedded the full song object on users and posts. Collapse them to
// one row per YouTube id, keyed deterministically so both references resolve.

const songs = new Map<string, any>();

function upsertSong(raw: any, sourcePath: string): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const youtubeId = toNullableText(raw.youtubeId);
  if (!youtubeId) {
    issues.warn(sourcePath, 'Song object has no youtubeId; dropped', raw, 'songs');
    return null;
  }
  const id = songIds.get(youtubeId);
  if (!songs.has(youtubeId)) {
    songs.set(youtubeId, {
      id,
      youtube_id: youtubeId,
      title: toText(raw.title, 'Unknown title'),
      artist: toText(raw.artist, ''),
      cover_url: toNullableText(raw.coverUrl),
      start_time: Number.isFinite(Number(raw.startTime)) ? Math.max(0, Math.trunc(Number(raw.startTime))) : 0,
    });
  }
  return id;
}

function main() {
  ensureDirs();
  console.log('Transforming Firestore export → Postgres rows\n');

  const rawUsers  = load('users');
  const authUsers = readJson<AuthUser[]>(path.join(RAW_DIR, 'auth-users.json'));

  // === Users =================================================================
  // Firestore profile documents are the source of truth for profile fields,
  // but auth is the source of truth for *which accounts exist*. A profile with
  // no auth user cannot be migrated: there is nothing for users.id to
  // reference. A auth user with no profile gets a synthesised profile.

  const authByUid = new Map(authUsers.map((u) => [u.uid, u]));
  const profileByUid = new Map(rawUsers.map((d) => [d.id, d]));
  const usernamesSeen = new Map<string, string>();

  const users: any[] = [];

  for (const auth of authUsers) {
    if (!auth.email) {
      issues.error(`auth/${auth.uid}`, 'Auth user has no email; skipped entirely', auth, 'users');
      continue;
    }

    const profile = profileByUid.get(auth.uid);
    if (!profile) {
      issues.warn(
        `auth/${auth.uid}`,
        'Auth user has no Firestore profile; synthesising one from auth fields',
        { email: auth.email }, 'users'
      );
    }

    const data = profile?.data ?? {};

    // Username collisions: Firestore never enforced uniqueness, so two accounts
    // can share one. The schema does enforce it, so later duplicates get a
    // numeric suffix and the change is logged.
    let username = normalizeUsername(data.username) ?? normalizeUsername(auth.email.split('@')[0]);
    if (!username) {
      username = `user_${auth.uid.slice(0, 8).toLowerCase()}`;
      issues.warn(`users/${auth.uid}`, 'Username unusable; generated a placeholder', { username }, 'users');
    }
    if (usernamesSeen.has(username)) {
      const original = username;
      let suffix = 2;
      while (usernamesSeen.has(`${original}${suffix}`)) suffix++;
      username = `${original}${suffix}`;
      issues.warn(
        `users/${auth.uid}`,
        'Duplicate username; renamed to keep the unique constraint',
        { from: original, to: username, conflictsWith: usernamesSeen.get(original) }, 'users'
      );
    }
    usernamesSeen.set(username, auth.uid);

    // Epoch rather than now() for a missing date: a synthesised "created just
    // now" is plausible enough to go unnoticed and quietly wrong, and it also
    // made the transform non-deterministic between runs.
    const createdAt = toTimestamp(data.createdAt) ?? toTimestamp(auth.createdAt);
    if (!createdAt) {
      issues.warn(`users/${auth.uid}`,
        'No parseable created date on profile or auth record; set to epoch so it is visibly unknown',
        null, 'users');
    }

    users.push({
      id: userIds.register(auth.uid),
      firebase_uid: auth.uid,
      username,
      display_name: toText(data.displayName, auth.displayName ?? username),
      email: auth.email.toLowerCase(),
      photo_url: toNullableText(data.photoURL),
      bio: toText(data.bio, ''),
      theme_song_id: upsertSong(data.themeSong, `users/${auth.uid}/themeSong`),
      status: ['active', 'idle', 'offline'].includes(data.status) ? data.status : 'offline',
      last_active: toTimestamp(data.lastActive),
      terms_version: toNullableText(data.termsVersion),
      terms_accepted_at: toTimestamp(data.termsAcceptedAt),
      created_at: createdAt ?? new Date(0).toISOString(),
    });
  }

  // Profiles with no matching auth user are unmigratable — flag loudly.
  for (const profile of rawUsers) {
    if (!authByUid.has(profile.id)) {
      issues.error(
        `users/${profile.id}`,
        'Firestore profile has no Firebase Auth user; cannot create users row (no auth.users to reference)',
        { username: profile.data?.username, email: profile.data?.email }, 'users'
      );
    }
  }

  const knownUser = (uid: unknown): string | null => {
    const id = toNullableText(uid);
    if (!id) return null;
    return authByUid.has(id) && authByUid.get(id)!.email ? userIds.get(id) : null;
  };

  // === Posts =================================================================

  const posts: any[] = [];
  const postImages: any[] = [];
  const postEdits: any[] = [];
  const comments: any[] = [];
  const postReactions: any[] = [];
  const commentReactions: any[] = [];

  for (const doc of load('posts')) {
    const authorId = knownUser(doc.data.userId);
    if (!authorId) {
      issues.error(doc.path, 'Post author does not resolve to a migrated user; post skipped',
        { userId: doc.data.userId }, 'posts');
      continue;
    }

    const postId = postIds.register(doc.id);
    const createdAt = toTimestamp(doc.data.createdAt);
    if (!createdAt) {
      issues.warn(doc.path, 'Post has no parseable createdAt; using epoch so ordering is obviously wrong rather than silently plausible', null, 'posts');
    }

    posts.push({
      id: postId,
      firebase_id: doc.id,
      user_id: authorId,
      content: toText(doc.data.content, ''),
      type: ['text', 'image', 'voice'].includes(doc.data.type) ? doc.data.type : 'text',
      visibility: ['public', 'followers', 'private'].includes(doc.data.visibility)
        ? doc.data.visibility : 'public',
      voice_url: toNullableText(doc.data.voiceUrl),
      song_id: upsertSong(doc.data.song, `${doc.path}/song`),
      // Counters intentionally start at 0; recompute_counters() derives them
      // from the imported rows. Trusting the Firestore value would import its
      // drift along with the data.
      likes_count: 0,
      comments_count: 0,
      created_at: createdAt ?? new Date(0).toISOString(),
    });

    // imageUrls[] → post_images rows
    const urls: unknown[] = Array.isArray(doc.data.imageUrls)
      ? doc.data.imageUrls
      : doc.data.imageUrl ? [doc.data.imageUrl] : [];
    urls.filter((u) => toNullableText(u)).forEach((url, i) => {
      postImages.push({ post_id: postId, position: i, url: String(url) });
    });

    // editHistory[] → post_edits rows
    if (Array.isArray(doc.data.editHistory)) {
      for (const entry of doc.data.editHistory) {
        postEdits.push({
          post_id: postId,
          previous_content: toText(entry?.content, ''),
          edited_at: toTimestamp(entry?.editedAt) ?? createdAt ?? new Date(0).toISOString(),
        });
      }
    }

    // reactions{emoji:[uid]} → one row per (post, user)
    for (const [emoji, uids] of Object.entries(doc.data.reactions ?? {})) {
      if (!Array.isArray(uids)) continue;
      for (const uid of uids) {
        const reactorId = knownUser(uid);
        if (!reactorId) {
          issues.warn(doc.path, 'Reaction from an unknown user; dropped', { uid, emoji }, 'post_reactions');
          continue;
        }
        // The map allowed one user under several emoji; the table permits one.
        if (postReactions.some((r) => r.post_id === postId && r.user_id === reactorId)) {
          issues.warn(doc.path, 'User had multiple reactions on one post; kept the first', { uid, emoji }, 'post_reactions');
          continue;
        }
        postReactions.push({ post_id: postId, user_id: reactorId, emoji });
      }
    }

    // posts/{id}/comments subcollection → comments rows
    for (const sub of doc.subcollections?.comments ?? []) {
      const commenterId = knownUser(sub.data.userId);
      if (!commenterId) {
        issues.error(sub.path, 'Comment author does not resolve to a migrated user; comment skipped',
          { userId: sub.data.userId }, 'comments');
        continue;
      }
      const commentId = commentIds.register(sub.id);
      comments.push({
        id: commentId,
        firebase_id: sub.id,
        post_id: postId,
        user_id: commenterId,
        content: toText(sub.data.content, ''),
        type: ['text', 'image', 'voice'].includes(sub.data.type) ? sub.data.type : 'text',
        image_url: toNullableText(sub.data.imageUrl),
        voice_url: toNullableText(sub.data.voiceUrl),
        // replyToId is resolved in a second pass below, once every comment id
        // is known — a reply can reference a comment created after it.
        reply_to_id: null,
        _reply_to_firebase_id: toNullableText(sub.data.replyToId),
        created_at: toTimestamp(sub.data.createdAt) ?? new Date(0).toISOString(),
      });

      for (const [emoji, uids] of Object.entries(sub.data.reactions ?? {})) {
        if (!Array.isArray(uids)) continue;
        for (const uid of uids) {
          const reactorId = knownUser(uid);
          if (!reactorId) continue;
          if (commentReactions.some((r) => r.comment_id === commentId && r.user_id === reactorId)) continue;
          commentReactions.push({ comment_id: commentId, user_id: reactorId, emoji });
        }
      }
    }
  }

  // Second pass: resolve comment reply targets now all ids exist.
  const commentByFirebaseId = new Map(comments.map((c) => [c.firebase_id, c.id]));
  for (const comment of comments) {
    const target = comment._reply_to_firebase_id;
    if (target) {
      const resolved = commentByFirebaseId.get(target);
      if (resolved) comment.reply_to_id = resolved;
      else issues.warn(`comments/${comment.firebase_id}`, 'Reply target comment not found; reply link dropped', { target }, 'comments');
    }
    delete comment._reply_to_firebase_id;
  }

  // Legacy top-level `comments` collection — prove it is empty rather than assume.
  const legacyComments = load('comments');
  if (legacyComments.length > 0) {
    issues.error('comments',
      `Legacy top-level comments collection contains ${legacyComments.length} documents. ` +
      'The app writes comments to posts/{id}/comments, so these are unreferenced. ' +
      'Review MIGRATION.md before discarding them.',
      { count: legacyComments.length }, 'comments');
  }

  // === Likes =================================================================
  // Firestore document id is `${postId}_${userId}`. Post ids and uids are both
  // 20–28 char opaque strings with no delimiter guarantee, so the id is parsed
  // only as a fallback — the document fields are authoritative.

  const likeKeys = new Set<string>();
  const likes: any[] = [];

  for (const doc of load('likes')) {
    const postFirebaseId = toNullableText(doc.data.postId);
    const userFirebaseId = toNullableText(doc.data.userId);

    if (!postFirebaseId || !userFirebaseId) {
      issues.error(doc.path, 'Like row missing postId or userId field; cannot reconstruct from the composite document id reliably', doc.data, 'likes');
      continue;
    }
    if (!postIds.has(postFirebaseId)) {
      issues.warn(doc.path, 'Like references a post that was not migrated; dropped', { postFirebaseId }, 'likes');
      continue;
    }
    const likerId = knownUser(userFirebaseId);
    if (!likerId) {
      issues.warn(doc.path, 'Like from an unknown user; dropped', { userFirebaseId }, 'likes');
      continue;
    }

    const key = `${postFirebaseId}|${userFirebaseId}`;
    if (likeKeys.has(key)) {
      issues.warn(doc.path, 'Duplicate like for the same (post, user); collapsed', null, 'likes');
      continue;
    }
    likeKeys.add(key);

    likes.push({
      post_id: postIds.get(postFirebaseId),
      user_id: likerId,
      created_at: toTimestamp(doc.data.createdAt) ?? new Date(0).toISOString(),
    });
  }

  // === Follows ===============================================================

  const followKeys = new Set<string>();
  const follows: any[] = [];

  for (const doc of load('follows')) {
    const followerId = knownUser(doc.data.followerId);
    const followingId = knownUser(doc.data.followingId);
    if (!followerId || !followingId) {
      issues.warn(doc.path, 'Follow references an unknown user; dropped',
        { followerId: doc.data.followerId, followingId: doc.data.followingId }, 'follows');
      continue;
    }
    if (followerId === followingId) {
      issues.warn(doc.path, 'Self-follow row; dropped (violates no_self_follow)', null, 'follows');
      continue;
    }
    const key = `${followerId}|${followingId}`;
    if (followKeys.has(key)) {
      issues.warn(doc.path, 'Duplicate follow (Firestore allowed these); collapsed', null, 'follows');
      continue;
    }
    followKeys.add(key);
    follows.push({
      follower_id: followerId,
      following_id: followingId,
      created_at: toTimestamp(doc.data.createdAt) ?? new Date(0).toISOString(),
    });
  }

  // === Conversations, members, messages ======================================

  const conversations: any[] = [];
  const members: any[] = [];
  const messages: any[] = [];
  const receipts: any[] = [];
  const messageReactions: any[] = [];

  for (const doc of load('chats')) {
    const participants: string[] = Array.isArray(doc.data.participants) ? doc.data.participants : [];
    const resolved = participants
      .map((uid) => ({ uid, id: knownUser(uid) }))
      .filter((p): p is { uid: string; id: string } => p.id !== null);

    if (resolved.length !== participants.length) {
      issues.warn(doc.path, 'Conversation had participants that do not resolve to migrated users; those members dropped',
        { missing: participants.filter((u) => !knownUser(u)) }, 'conversation_members');
    }
    if (resolved.length === 0) {
      issues.error(doc.path, 'Conversation has no resolvable participants; skipped', null, 'conversations');
      continue;
    }

    const type = doc.data.type === 'group' ? 'group' : 'direct';
    if (type === 'direct' && resolved.length !== 2) {
      issues.warn(doc.path, `Direct conversation has ${resolved.length} participants instead of 2; imported as-is`, null, 'conversations');
    }

    const convId = convIds.register(doc.id);
    const admins: string[] = Array.isArray(doc.data.admins) ? doc.data.admins : [];
    const createdAt = toTimestamp(doc.data.createdAt) ?? toTimestamp(doc.data.updatedAt) ?? new Date(0).toISOString();

    conversations.push({
      id: convId,
      firebase_id: doc.id,
      type,
      name: type === 'group' ? toText(doc.data.name, 'Group chat') : null,
      photo_url: toNullableText(doc.data.photoURL),
      created_by: knownUser(doc.data.createdBy),
      created_at: createdAt,
      updated_at: toTimestamp(doc.data.updatedAt) ?? createdAt,
    });

    for (const p of resolved) {
      members.push({
        conversation_id: convId,
        user_id: p.id,
        role: admins.includes(p.uid) ? 'admin' : 'member',
        joined_at: createdAt,
        last_read_at: null,
      });
    }

    for (const sub of doc.subcollections?.messages ?? []) {
      const senderFirebaseId = toNullableText(sub.data.senderId);
      const isSystem = senderFirebaseId === 'system' || sub.data.type === 'system';
      const senderId = isSystem ? null : knownUser(senderFirebaseId);

      if (!isSystem && !senderId) {
        issues.error(sub.path, 'Message sender does not resolve to a migrated user; message skipped',
          { senderId: senderFirebaseId }, 'messages');
        continue;
      }

      const msgId = messageIds.register(sub.id);
      messages.push({
        id: msgId,
        firebase_id: sub.id,
        conversation_id: convId,
        sender_id: senderId,
        content: toText(sub.data.content, ''),
        type: ['text', 'image', 'voice', 'post', 'system'].includes(sub.data.type) ? sub.data.type : 'text',
        image_url: toNullableText(sub.data.imageUrl),
        voice_url: toNullableText(sub.data.voiceUrl),
        reply_to_id: null,
        _reply_to_firebase_id: toNullableText(sub.data.replyToId),
        _shared_post_firebase_id: toNullableText(sub.data.postId),
        shared_post_id: null,
        created_at: toTimestamp(sub.data.createdAt) ?? new Date(0).toISOString(),
      });

      // readBy[] / deliveredTo[] → message_receipts. A read implies delivery,
      // so a uid in readBy but not deliveredTo still gets delivered_at set.
      const readBy: string[] = Array.isArray(sub.data.readBy) ? sub.data.readBy : [];
      const deliveredTo: string[] = Array.isArray(sub.data.deliveredTo) ? sub.data.deliveredTo : [];
      const recipients = new Set([...readBy, ...deliveredTo].filter((u) => u !== senderFirebaseId));

      for (const uid of recipients) {
        const recipientId = knownUser(uid);
        if (!recipientId) continue;
        const wasRead = readBy.includes(uid);
        receipts.push({
          message_id: msgId,
          user_id: recipientId,
          // Firestore stored no per-user timestamp, only membership of an
          // array. The message's own createdAt is the only defensible
          // approximation — flagged so nobody reads these as precise.
          delivered_at: toTimestamp(sub.data.createdAt) ?? new Date(0).toISOString(),
          read_at: wasRead ? toTimestamp(sub.data.createdAt) ?? new Date(0).toISOString() : null,
        });
      }

      for (const [emoji, uids] of Object.entries(sub.data.reactions ?? {})) {
        if (!Array.isArray(uids)) continue;
        for (const uid of uids) {
          const reactorId = knownUser(uid);
          if (!reactorId) continue;
          if (messageReactions.some((r) => r.message_id === msgId && r.user_id === reactorId)) continue;
          messageReactions.push({ message_id: msgId, user_id: reactorId, emoji });
        }
      }
    }
  }

  if (receipts.length > 0) {
    issues.warn('chats/*/messages',
      `${receipts.length} message receipts have approximate timestamps: Firestore stored readBy/deliveredTo as arrays with no per-user time, so the message createdAt was used`,
      null, 'message_receipts');
  }

  // Resolve message cross-references now every id exists.
  const messageByFirebaseId = new Map(messages.map((m) => [m.firebase_id, m.id]));
  for (const msg of messages) {
    if (msg._reply_to_firebase_id) {
      const resolved = messageByFirebaseId.get(msg._reply_to_firebase_id);
      if (resolved) msg.reply_to_id = resolved;
      else issues.warn(`messages/${msg.firebase_id}`, 'Reply target message not found; reply link dropped', null, 'messages');
    }
    if (msg._shared_post_firebase_id) {
      if (postIds.has(msg._shared_post_firebase_id)) {
        msg.shared_post_id = postIds.get(msg._shared_post_firebase_id);
      } else {
        issues.warn(`messages/${msg.firebase_id}`, 'Shared post no longer exists; link dropped', null, 'messages');
      }
    }
    delete msg._reply_to_firebase_id;
    delete msg._shared_post_firebase_id;
  }

  // === Notifications =========================================================

  const notifications: any[] = [];
  for (const doc of load('notifications')) {
    const recipientId = knownUser(doc.data.toUserId);
    if (!recipientId) {
      issues.warn(doc.path, 'Notification recipient unknown; dropped', { toUserId: doc.data.toUserId }, 'notifications');
      continue;
    }
    const type = doc.data.type;
    if (!['like', 'comment', 'message', 'follow', 'reaction', 'mention'].includes(type)) {
      issues.warn(doc.path, `Unrecognised notification type "${type}"; dropped`, null, 'notifications');
      continue;
    }

    // referenceId is polymorphic in Firestore — a post id for like/comment/
    // mention/reaction, a chat id for message. Split into typed columns.
    const ref = toNullableText(doc.data.referenceId);
    const isMessage = type === 'message';

    notifications.push({
      id: undefined, // let Postgres generate
      firebase_id: doc.id,
      recipient_id: recipientId,
      actor_id: knownUser(doc.data.fromUserId),
      type,
      subtype: toNullableText(doc.data.subType),
      content: toNullableText(doc.data.content),
      post_id: !isMessage && ref && postIds.has(ref) ? postIds.get(ref) : null,
      comment_id: null,
      conversation_id: isMessage && ref && convIds.has(ref) ? convIds.get(ref) : null,
      is_read: doc.data.isRead === true,
      created_at: toTimestamp(doc.data.createdAt) ?? new Date(0).toISOString(),
    });
  }

  // === Music history =========================================================

  const musicHistory: any[] = [];
  for (const doc of load('musicHistory')) {
    const ownerId = knownUser(doc.data.userId);
    if (!ownerId) continue;
    const songId = upsertSong(doc.data, doc.path);
    if (!songId) continue;
    musicHistory.push({
      user_id: ownerId,
      song_id: songId,
      kind: doc.data.type === 'used' ? 'used' : 'listened',
      created_at: toTimestamp(doc.data.createdAt) ?? new Date(0).toISOString(),
    });
  }

  // === Push subscriptions ====================================================

  const pushSubscriptions: any[] = [];
  const endpointsSeen = new Set<string>();
  for (const doc of load('subscriptions')) {
    const ownerId = knownUser(doc.data.userId);
    const endpoint = toNullableText(doc.data.endpoint);
    const keys = doc.data.keys ?? {};
    if (!ownerId || !endpoint || !keys.p256dh || !keys.auth) {
      issues.warn(doc.path, 'Push subscription incomplete; dropped', null, 'push_subscriptions');
      continue;
    }
    if (endpointsSeen.has(endpoint)) continue;
    endpointsSeen.add(endpoint);
    pushSubscriptions.push({
      user_id: ownerId, endpoint, p256dh: keys.p256dh, auth: keys.auth,
      created_at: toTimestamp(doc.data.createdAt) ?? new Date(0).toISOString(),
    });
  }

  // === Security events =======================================================

  const securityEvents: any[] = [];
  for (const doc of rawUsers) {
    const ownerId = knownUser(doc.id);
    if (!ownerId) continue;
    for (const sub of doc.subcollections?.securityEvents ?? []) {
      securityEvents.push({
        user_id: ownerId,
        type: sub.data.type,
        device_id: toText(sub.data.deviceId, 'unknown'),
        device_label: toNullableText(sub.data.deviceLabel),
        created_at: toTimestamp(sub.data.createdAt) ?? new Date(0).toISOString(),
      });
    }
  }

  // === Write output ==========================================================

  const tables: Record<string, any[]> = {
    songs: [...songs.values()],
    users,
    follows,
    posts,
    post_images: postImages,
    post_edits: postEdits,
    likes,
    comments,
    post_reactions: postReactions,
    comment_reactions: commentReactions,
    conversations,
    conversation_members: members,
    messages,
    message_receipts: receipts,
    message_reactions: messageReactions,
    notifications,
    music_history: musicHistory,
    push_subscriptions: pushSubscriptions,
    security_events: securityEvents,
  };

  for (const [table, rows] of Object.entries(tables)) {
    writeJson(path.join(OUT_DIR, `${table}.json`), rows);
    console.log(`  ${table.padEnd(22)} ${String(rows.length).padStart(7)} rows`);
  }

  // The UID map is the artefact everything else keys off — persist it so the
  // storage step and any later reconciliation can reuse the same mapping.
  writeJson(path.join(DATA_DIR, 'uid-map.json'), userIds.toJSON());
  writeJson(path.join(DATA_DIR, 'post-id-map.json'), postIds.toJSON());

  console.log('\nIssues:');
  issues.report('transform');
  issues.save(path.join(DATA_DIR, 'issues-transform.json'));

  if (issues.errorCount > 0) {
    console.log(
      `\n${issues.errorCount} record(s) could NOT be migrated. ` +
      'Review migration-data/issues-transform.json before importing.'
    );
  }
}

main();
