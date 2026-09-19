import { supabase } from './supabase';
import type { User } from '../types';

// The pure rules live in their own module so they can be tested without a
// Vite environment. Imported for use here AND re-exported, so every existing
// call site keeps importing them from './notes' exactly as before — a
// re-export alone would not put them in this module's scope.
import { sortNotes } from './noteRules';
import type { NoteCategory } from './noteRules';

export {
  listStyleFor, isTickable, sortNotes, isDueToday, splitToday,
} from './noteRules';
export type { NoteCategory, ListStyle } from './noteRules';

/**
 * Shared Notes & Reminders.
 *
 * A note belongs to a note space, and a note space has members who had to
 * accept an invitation to get there. Membership is the whole visibility model.
 *
 * Independent of map spaces by design — separate tables, separate helpers,
 * separate invites (0025). The two look alike and share nothing.
 *
 * None of these queries filter by membership. RLS does that, and a second
 * filter here could only ever hide something a member is entitled to see,
 * while forgetting one would show nothing extra because the database has
 * already refused it. The one exception is `invites()`, which filters on
 * status to separate two things RLS deliberately allows the same user to read.
 */

export type NoteSpaceRole = 'owner' | 'member';
export type NoteMemberStatus = 'pending' | 'accepted';

export interface NoteSpaceMember {
  userId: string;
  status: NoteMemberStatus;
  role: NoteSpaceRole;
  joinedAt: string;
  user?: User;
}

export interface NoteSpace {
  id: string;
  name: string;
  category: NoteCategory;
  createdBy: string;
  createdAt: string;
  /** Accepted members, plus anyone still pending if the viewer can see them.
   *  A pending invitee sees only their own row here; RLS decides. */
  members: NoteSpaceMember[];
}

export interface Note {
  id: string;
  spaceId: string;
  authorId: string;
  content: string;
  /** Null is a plain note; set makes it a reminder. That is the only
   *  difference between the two things this type holds. */
  dueDate?: string;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
  author?: User;
  editor?: User;
}

const USER_FIELDS = 'id, username, display_name, email, photo_url, bio, status, last_active, created_at';

const SPACE_SELECT = `
  id, name, category, created_by, created_at,
  note_space_members(user_id, status, role, joined_at, users(${USER_FIELDS}))
`;

const NOTE_SELECT = `
  id, space_id, author_id, content, due_date, completed,
  created_at, updated_at, updated_by,
  author:users!notes_author_id_fkey(${USER_FIELDS}),
  editor:users!notes_updated_by_fkey(${USER_FIELDS})
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

const mapSpace = (row: any): NoteSpace => ({
  id: row.id,
  name: row.name,
  // Spaces created before 0027 have no category column value in an old
  // cached response; the DB default covers the row itself.
  category: (row.category ?? 'general') as NoteCategory,
  createdBy: row.created_by,
  createdAt: row.created_at,
  members: (row.note_space_members ?? []).map((m: any) => ({
    userId: m.user_id,
    status: m.status as NoteMemberStatus,
    role: m.role as NoteSpaceRole,
    joinedAt: m.joined_at,
    user: mapUser(m.users),
  })),
});

const mapNote = (row: any): Note => ({
  id: row.id,
  spaceId: row.space_id,
  authorId: row.author_id,
  content: row.content,
  dueDate: row.due_date ?? undefined,
  completed: row.completed,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  updatedBy: row.updated_by ?? undefined,
  author: mapUser(row.author),
  editor: mapUser(row.editor),
});

export const noteSpaces = {
  /**
   * Spaces the caller has ACCEPTED.
   *
   * RLS also lets them read spaces they have only been invited to, so this
   * filters on the membership row rather than trusting the row count. The
   * embedded filter is on note_space_members, not on note_spaces, so an
   * accepted space whose roster includes pending invitees still comes back.
   */
  async mine(userId: string): Promise<NoteSpace[]> {
    const { data, error } = await supabase
      .from('note_spaces')
      .select(SPACE_SELECT)
      .order('created_at', { ascending: false });
    if (error) throw error;

    return (data ?? [])
      .map(mapSpace)
      .filter((s) => s.members.some((m) => m.userId === userId && m.status === 'accepted'));
  },

  /** Spaces the caller has been invited to and has not answered. */
  async invites(userId: string): Promise<NoteSpace[]> {
    const { data, error } = await supabase
      .from('note_spaces')
      .select(SPACE_SELECT)
      .order('created_at', { ascending: false });
    if (error) throw error;

    return (data ?? [])
      .map(mapSpace)
      .filter((s) => s.members.some((m) => m.userId === userId && m.status === 'pending'));
  },

  async get(spaceId: string): Promise<NoteSpace | null> {
    const { data, error } = await supabase
      .from('note_spaces')
      .select(SPACE_SELECT)
      .eq('id', spaceId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapSpace(data) : null;
  },

  /**
   * Creates a space, the owner's accepted membership, and a pending row per
   * invitee.
   *
   * The owner's row goes in first and separately: they are the owner by virtue
   * of note_spaces.created_by, so that insert is allowed before any membership
   * exists. It is inserted as 'accepted' — nobody invites themselves.
   *
   * Not a transaction; PostgREST has no multi-statement one. A space with no
   * owner row would be invisible to everybody including its creator, so the
   * space is removed again if that insert fails. Invitee rows failing is not
   * fatal — the space exists and people can be invited again — so it throws
   * without unwinding, and the caller has a real space id either way.
   */
  async create(input: {
    name: string;
    createdBy: string;
    category?: NoteCategory;
    inviteeIds?: string[];
  }): Promise<string> {
    const { data: space, error } = await supabase
      .from('note_spaces')
      .insert({
        name: input.name.trim(),
        created_by: input.createdBy,
        // Omitted rather than sent as null when absent: null would violate the
        // NOT NULL, while leaving the key off lets the column default apply.
        ...(input.category ? { category: input.category } : {}),
      })
      .select('id')
      .single();
    if (error) throw error;

    const { error: ownerError } = await supabase
      .from('note_space_members')
      .insert({
        space_id: space.id,
        user_id: input.createdBy,
        role: 'owner',
        status: 'accepted',
      });
    if (ownerError) {
      await supabase.from('note_spaces').delete().eq('id', space.id);
      throw ownerError;
    }

    const others = (input.inviteeIds ?? []).filter((id) => id !== input.createdBy);
    if (others.length) await noteSpaces.invite(space.id, others);

    return space.id;
  },

  /** Owner only — RLS refuses anyone else. Rows land as 'pending'. */
  async invite(spaceId: string, userIds: string[]): Promise<void> {
    if (!userIds.length) return;
    const { error } = await supabase.from('note_space_members').insert(
      userIds.map((user_id) => ({
        space_id: spaceId,
        user_id,
        role: 'member' as const,
        status: 'pending' as const,
      }))
    );
    if (error) throw error;
  },

  /** The invitee flips their own row. Until this lands they can read the
   *  space's name and nothing else. */
  async accept(spaceId: string, userId: string): Promise<void> {
    const { error } = await supabase
      .from('note_space_members')
      .update({ status: 'accepted' })
      .eq('space_id', spaceId)
      .eq('user_id', userId);
    if (error) throw error;
  },

  /** Declining and leaving are the same statement: the row goes away. A
   *  declined invite can be re-sent, because nothing remembers the refusal. */
  async leave(spaceId: string, userId: string): Promise<void> {
    const { error } = await supabase
      .from('note_space_members')
      .delete()
      .eq('space_id', spaceId)
      .eq('user_id', userId);
    if (error) throw error;
  },

  async remove(spaceId: string): Promise<void> {
    const { error } = await supabase.from('note_spaces').delete().eq('id', spaceId);
    if (error) throw error;
  },

  /** Membership changes in a space: someone accepting, declining or leaving. */
  subscribe(spaceId: string, onChange: () => void): () => void {
    const channel = supabase
      .channel(`note-space-members:${spaceId}#${Date.now()}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'note_space_members', filter: `space_id=eq.${spaceId}` },
        () => onChange()
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  },
};

export const notes = {
  async list(spaceId: string): Promise<Note[]> {
    const { data, error } = await supabase
      .from('notes')
      .select(NOTE_SELECT)
      .eq('space_id', spaceId);
    if (error) throw error;
    return sortNotes((data ?? []).map(mapNote));
  },

  async create(input: {
    spaceId: string;
    authorId: string;
    content: string;
    dueDate?: string | null;
  }): Promise<Note> {
    const { data, error } = await supabase
      .from('notes')
      .insert({
        space_id: input.spaceId,
        author_id: input.authorId,
        content: input.content.trim(),
        due_date: input.dueDate ?? null,
      })
      .select(NOTE_SELECT)
      .single();
    if (error) throw error;
    return mapNote(data);
  },

  /**
   * Any accepted member may edit any note — a shared list where you can only
   * tick your own reminders is not shared.
   *
   * updated_at and updated_by are deliberately absent from every payload here:
   * the notes_stamp_update trigger writes them, along with refusing changes to
   * author_id and space_id. Sending them from the client would be ignored, and
   * pretending otherwise would put "who edited this" under the caller's
   * control.
   */
  async update(noteId: string, patch: { content?: string; dueDate?: string | null }): Promise<Note> {
    const row: Record<string, unknown> = {};
    if (patch.content !== undefined) row.content = patch.content.trim();
    if (patch.dueDate !== undefined) row.due_date = patch.dueDate;

    const { data, error } = await supabase
      .from('notes')
      .update(row)
      .eq('id', noteId)
      .select(NOTE_SELECT)
      .single();
    if (error) throw error;
    return mapNote(data);
  },

  async setCompleted(noteId: string, completed: boolean): Promise<Note> {
    const { data, error } = await supabase
      .from('notes')
      .update({ completed })
      .eq('id', noteId)
      .select(NOTE_SELECT)
      .single();
    if (error) throw error;
    return mapNote(data);
  },

  async remove(noteId: string): Promise<void> {
    const { error } = await supabase.from('notes').delete().eq('id', noteId);
    if (error) throw error;
  },

  /** Every change to the space's notes, for every member watching it. This is
   *  what makes one person ticking a reminder show up on the other's screen. */
  subscribe(spaceId: string, onChange: () => void): () => void {
    const channel = supabase
      .channel(`notes:${spaceId}#${Date.now()}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notes', filter: `space_id=eq.${spaceId}` },
        () => onChange()
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  },
};
