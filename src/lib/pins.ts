import { supabase, resolveStorageUrl } from './supabase';
import type { User } from '../types';

/**
 * Map Spaces: persistent shared maps.
 *
 * A pin belongs to a space, and a space has members. Membership is the whole
 * visibility model — every member sees every pin in the space and can keep
 * adding to it. This replaced per-pin sharing, where a pin was addressed to
 * individuals and nothing accumulated.
 *
 * None of these queries filter by membership. RLS does that (0017), and a
 * second filter here could only ever hide something a member is entitled to
 * see — while forgetting one would show nothing extra, because the database
 * has already refused it.
 */

export type PinMediaType = 'photo' | 'video' | 'song';
export type SpaceRole = 'owner' | 'member';

export interface PinMedia {
  id: string;
  type: PinMediaType;
  url?: string;
  youtubeVideoId?: string;
  /** The song's name, captured when it was attached (0021). Absent on
   *  anything attached before that, which the card fills in from the
   *  oEmbed lookup instead. */
  songTitle?: string;
  songArtist?: string;
  posterUrl?: string;
  orderIndex: number;
}

export interface SpaceMember {
  userId: string;
  role: SpaceRole;
  joinedAt: string;
  user?: User;
}

export interface MapSpace {
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
  members: SpaceMember[];
  pinCount?: number;
}

export interface Pin {
  id: string;
  spaceId: string;
  creatorId: string;
  latitude: number;
  longitude: number;
  /** The place name — the pin's title. */
  name?: string;
  /** A few words about the memory. */
  caption?: string;
  createdAt: string;
  creator?: User;
  media: PinMedia[];
}

const USER_FIELDS = 'id, username, display_name, email, photo_url, bio, status, last_active, created_at';

const SPACE_SELECT = `
  id, name, created_by, created_at,
  map_space_members(user_id, role, joined_at, users(${USER_FIELDS}))
`;

const PIN_SELECT = `
  id, space_id, creator_id, latitude, longitude, name, caption, created_at,
  users!pins_creator_id_fkey(${USER_FIELDS}),
  pin_media(id, media_type, media_url, youtube_video_id, song_title, song_artist, poster_url, order_index)
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

const mapSpace = (row: any): MapSpace => ({
  id: row.id,
  name: row.name,
  createdBy: row.created_by,
  createdAt: row.created_at,
  members: (row.map_space_members ?? []).map((m: any) => ({
    userId: m.user_id,
    role: m.role as SpaceRole,
    joinedAt: m.joined_at,
    user: mapUser(m.users),
  })),
});

const mapPin = (row: any): Pin => ({
  id: row.id,
  spaceId: row.space_id,
  creatorId: row.creator_id,
  // Postgres numeric arrives as a string over PostgREST. Leaflet needs numbers,
  // and "51.5" turns into NaN the moment arithmetic touches it.
  latitude: Number(row.latitude),
  longitude: Number(row.longitude),
  name: row.name ?? undefined,
  caption: row.caption ?? undefined,
  createdAt: row.created_at,
  creator: mapUser(row.users),
  media: (row.pin_media ?? [])
    .map((m: any) => ({
      id: m.id,
      type: m.media_type as PinMediaType,
      url: m.media_url ?? undefined,
      youtubeVideoId: m.youtube_video_id ?? undefined,
      songTitle: m.song_title ?? undefined,
      songArtist: m.song_artist ?? undefined,
      posterUrl: m.poster_url ?? undefined,
      orderIndex: m.order_index ?? 0,
    }))
    .sort((a: PinMedia, b: PinMedia) => a.orderIndex - b.orderIndex),
});

export const spaces = {
  /** Every space the caller belongs to. */
  async mine(): Promise<MapSpace[]> {
    const { data, error } = await supabase
      .from('map_spaces')
      .select(SPACE_SELECT)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapSpace);
  },

  /**
   * Creates a space and its membership rows.
   *
   * The creator's own row goes in first and separately: they are the owner by
   * virtue of map_spaces.created_by, so that insert is allowed before any
   * membership exists. Everyone else follows in one statement.
   *
   * Not a transaction — PostgREST has no multi-statement one. A space with no
   * members would be invisible to everybody including its creator, so the
   * space is removed again if the owner row fails.
   */
  async create(input: { name: string; createdBy: string; memberIds?: string[] }): Promise<string> {
    const { data: space, error } = await supabase
      .from('map_spaces')
      .insert({ name: input.name.trim(), created_by: input.createdBy })
      .select('id')
      .single();
    if (error) throw error;

    try {
      const { error: ownerError } = await supabase
        .from('map_space_members')
        .insert({ space_id: space.id, user_id: input.createdBy, role: 'owner' });
      if (ownerError) throw ownerError;

      const others = (input.memberIds ?? []).filter((id) => id !== input.createdBy);
      if (others.length) {
        const { error: memberError } = await supabase.from('map_space_members').insert(
          others.map((user_id) => ({ space_id: space.id, user_id, role: 'member' as const }))
        );
        if (memberError) throw memberError;
      }
    } catch (err) {
      await supabase.from('map_spaces').delete().eq('id', space.id);
      throw err;
    }

    return space.id;
  },

  /** Owner only — RLS refuses anyone else. */
  async addMembers(spaceId: string, userIds: string[]): Promise<void> {
    if (!userIds.length) return;
    const { error } = await supabase.from('map_space_members').insert(
      userIds.map((user_id) => ({ space_id: spaceId, user_id, role: 'member' as const }))
    );
    if (error) throw error;
  },

  /** Owner removing anyone, or a member leaving. RLS allows exactly those. */
  async removeMember(spaceId: string, userId: string): Promise<void> {
    const { error } = await supabase
      .from('map_space_members')
      .delete()
      .eq('space_id', spaceId)
      .eq('user_id', userId);
    if (error) throw error;
  },

  async remove(spaceId: string): Promise<void> {
    const { error } = await supabase.from('map_spaces').delete().eq('id', spaceId);
    if (error) throw error;
  },
};

export const pins = {
  /**
   * Pins in the spaces the caller belongs to.
   *
   * `spaceId` narrows to one space for the UI's filter; leaving it off returns
   * everything, which is what the combined map shows.
   */
  async visible(spaceId?: string): Promise<Pin[]> {
    let query = supabase.from('pins').select(PIN_SELECT).order('created_at', { ascending: false });
    if (spaceId) query = query.eq('space_id', spaceId);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []).map(mapPin);
  },

  async get(id: string): Promise<Pin | null> {
    const { data, error } = await supabase.from('pins').select(PIN_SELECT).eq('id', id).maybeSingle();
    if (error) throw error;
    return data ? mapPin(data) : null;
  },

  /**
   * Drops a pin into a space. No recipient picker: membership already decides
   * who sees it.
   *
   * Same hand-rolled rollback as spaces.create() and for the same reason — a
   * pin whose media failed to attach would sit on the shared map as an empty
   * marker indistinguishable from a real one.
   */
  async create(input: {
    spaceId: string;
    creatorId: string;
    latitude: number;
    longitude: number;
    name?: string | null;
    caption?: string | null;
    media?: Array<{
      type: PinMediaType;
      url?: string | null;
      youtubeVideoId?: string | null;
      songTitle?: string | null;
      songArtist?: string | null;
      posterUrl?: string | null;
    }>;
  }): Promise<string> {
    const { data: pin, error } = await supabase
      .from('pins')
      .insert({
        space_id: input.spaceId,
        creator_id: input.creatorId,
        latitude: input.latitude,
        longitude: input.longitude,
        name: input.name?.trim() || null,
        caption: input.caption?.trim() || null,
      })
      .select('id')
      .single();
    if (error) throw error;

    if (input.media?.length) {
      const { error: mediaError } = await supabase.from('pin_media').insert(
        input.media.map((m, order_index) => ({
          pin_id: pin.id,
          media_type: m.type,
          media_url: m.url ?? null,
          youtube_video_id: m.youtubeVideoId ?? null,
          song_title: m.songTitle ?? null,
          song_artist: m.songArtist ?? null,
          poster_url: m.posterUrl ?? null,
          order_index,
        }))
      );
      if (mediaError) {
        await supabase.from('pins').delete().eq('id', pin.id);
        throw mediaError;
      }
    }

    return pin.id;
  },

  async remove(id: string): Promise<void> {
    const { error } = await supabase.from('pins').delete().eq('id', id);
    if (error) throw error;
  },

  /**
   * Signs media held in a private bucket. Chat-bucket objects are stored as
   * `supabase://…` and have to be exchanged for a signed URL before rendering.
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
