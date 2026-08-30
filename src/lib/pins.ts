import { supabase, resolveStorageUrl } from './supabase';
import type { User } from '../types';

/**
 * Memory Pins: a map location carrying media, shared with people or groups.
 *
 * A pin is private by default and has no public state — it is visible to its
 * creator and to whoever it has been explicitly shared with. That whitelist
 * lives in RLS (see 0015_memory_pins.sql), so these queries carry no
 * visibility filter of their own: the database decides, and a mistake here
 * shows too little rather than too much.
 */

export type PinMediaType = 'photo' | 'video' | 'song';

export interface PinMedia {
  id: string;
  type: PinMediaType;
  /** Storage URL for a photo or video. */
  url?: string;
  /** YouTube id for a song. */
  youtubeVideoId?: string;
  posterUrl?: string;
  orderIndex: number;
}

export interface PinShare {
  id: string;
  sharedWithUserId?: string;
  conversationId?: string;
  createdAt: string;
}

export interface Pin {
  id: string;
  creatorId: string;
  latitude: number;
  longitude: number;
  caption?: string;
  createdAt: string;
  creator?: User;
  media: PinMedia[];
  shares: PinShare[];
}

const USER_FIELDS = 'id, username, display_name, email, photo_url, bio, status, last_active, created_at';

const PIN_SELECT = `
  id, creator_id, latitude, longitude, caption, created_at,
  users!pins_creator_id_fkey(${USER_FIELDS}),
  pin_media(id, media_type, media_url, youtube_video_id, poster_url, order_index),
  pin_shares(id, shared_with_user_id, conversation_id, created_at)
`;

const mapUser = (row: any): User | undefined =>
  row
    ? {
        uid: row.id,
        id: row.id,
        username: row.username,
        displayName: row.display_name ?? row.username,
        email: row.email ?? '',
        photoURL: row.photo_url ?? undefined,
        bio: row.bio ?? undefined,
        status: row.status ?? undefined,
        lastActive: row.last_active ?? undefined,
        createdAt: row.created_at,
      }
    : undefined;

const mapPin = (row: any): Pin => ({
  id: row.id,
  creatorId: row.creator_id,
  // Postgres numeric arrives as a string over PostgREST; Leaflet needs numbers,
  // and `"51.5"` silently becomes NaN once arithmetic touches it.
  latitude: Number(row.latitude),
  longitude: Number(row.longitude),
  caption: row.caption ?? undefined,
  createdAt: row.created_at,
  creator: mapUser(row.users),
  media: (row.pin_media ?? [])
    .map((m: any) => ({
      id: m.id,
      type: m.media_type as PinMediaType,
      url: m.media_url ?? undefined,
      youtubeVideoId: m.youtube_video_id ?? undefined,
      posterUrl: m.poster_url ?? undefined,
      orderIndex: m.order_index ?? 0,
    }))
    .sort((a: PinMedia, b: PinMedia) => a.orderIndex - b.orderIndex),
  shares: (row.pin_shares ?? []).map((s: any) => ({
    id: s.id,
    sharedWithUserId: s.shared_with_user_id ?? undefined,
    conversationId: s.conversation_id ?? undefined,
    createdAt: s.created_at,
  })),
});

export const pins = {
  /**
   * Every pin the caller can see: their own, plus anything shared with them
   * directly or through a conversation they are in.
   *
   * No `.eq('creator_id', …)` and no share join here on purpose — adding one
   * would silently hide pins shared through a group. RLS already answers the
   * question; this asks for everything and lets it filter.
   */
  async visible(): Promise<Pin[]> {
    const { data, error } = await supabase
      .from('pins')
      .select(PIN_SELECT)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapPin);
  },

  async get(id: string): Promise<Pin | null> {
    const { data, error } = await supabase
      .from('pins')
      .select(PIN_SELECT)
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    return data ? mapPin(data) : null;
  },

  /**
   * Creates a pin, its media and its shares.
   *
   * Not a transaction: PostgREST has no multi-statement one. The pin is
   * written first so the child rows have something to point at; if a later
   * insert fails the pin is removed again, so a half-built pin never appears
   * on the map. A stored procedure would be atomic, and is the upgrade path if
   * this ever needs to be.
   */
  async create(input: {
    creatorId: string;
    latitude: number;
    longitude: number;
    caption?: string | null;
    media?: Array<{
      type: PinMediaType;
      url?: string | null;
      youtubeVideoId?: string | null;
      posterUrl?: string | null;
    }>;
    shareWithUserIds?: string[];
    shareWithConversationIds?: string[];
  }): Promise<string> {
    const { data: pin, error } = await supabase
      .from('pins')
      .insert({
        creator_id: input.creatorId,
        latitude: input.latitude,
        longitude: input.longitude,
        caption: input.caption?.trim() || null,
      })
      .select('id')
      .single();
    if (error) throw error;

    try {
      if (input.media?.length) {
        const { error: mediaError } = await supabase.from('pin_media').insert(
          input.media.map((m, order_index) => ({
            pin_id: pin.id,
            media_type: m.type,
            media_url: m.url ?? null,
            youtube_video_id: m.youtubeVideoId ?? null,
            poster_url: m.posterUrl ?? null,
            order_index,
          }))
        );
        if (mediaError) throw mediaError;
      }

      const shares = [
        ...(input.shareWithUserIds ?? []).map((uid) => ({
          pin_id: pin.id,
          shared_with_user_id: uid,
          conversation_id: null,
        })),
        ...(input.shareWithConversationIds ?? []).map((cid) => ({
          pin_id: pin.id,
          shared_with_user_id: null,
          conversation_id: cid,
        })),
      ];
      if (shares.length) {
        const { error: shareError } = await supabase.from('pin_shares').insert(shares);
        if (shareError) throw shareError;
      }
    } catch (err) {
      // Roll back by hand. Leaving the pin would put an empty, unshared marker
      // on the creator's map with no way to tell it apart from a real one.
      await supabase.from('pins').delete().eq('id', pin.id);
      throw err;
    }

    return pin.id;
  },

  async remove(id: string): Promise<void> {
    const { error } = await supabase.from('pins').delete().eq('id', id);
    if (error) throw error;
  },

  /**
   * Signs any media that lives in a private bucket.
   *
   * Photos and videos attached to a pin go to the same buckets the rest of the
   * app uses, and the chat ones are private — so a stored `supabase://` value
   * has to be exchanged for a signed URL before it can be rendered.
   */
  async resolveMedia(media: PinMedia[]): Promise<PinMedia[]> {
    return Promise.all(
      media.map(async (m) => ({
        ...m,
        url: m.url ? (await resolveStorageUrl(m.url)) ?? undefined : undefined,
        posterUrl: m.posterUrl ? (await resolveStorageUrl(m.posterUrl)) ?? undefined : undefined,
      }))
    );
  },
};
