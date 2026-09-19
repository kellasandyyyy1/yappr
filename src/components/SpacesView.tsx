import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Loader2, MapPin, Notebook, Check, X } from './icons';
import { AvatarStack } from './AvatarStack';
import { useToast } from './ToastContext';
import { spaces as mapSpacesApi } from '../lib/pins';
import type { MapSpace } from '../lib/pins';
import { noteSpaces as noteSpacesApi } from '../lib/notes';
import type { NoteSpace } from '../lib/notes';
import { notifications as notificationsApi } from '../lib/db';
import { CATEGORY_META, CategoryIcon } from './noteCategories';
import { CreateSpaceModal } from './CreateSpaceModal';
import { CreateNoteSpaceModal } from './CreateNoteSpaceModal';
import { cn, describeError, formatTimeAgo } from '../lib/utils';
import type { User } from '../types';

type Filter = 'all' | 'map' | 'notes';

interface SpacesViewProps {
  user: User;
  /** Opening a map space hands off to the map view, which owns the full-height
   *  layout the map needs and which this hub deliberately does not replicate. */
  onOpenMapSpace: (spaceId: string) => void;
  onOpenNoteSpace: (space: NoteSpace) => void;
}

/**
 * One hub for both kinds of space.
 *
 * Map spaces and note spaces share no tables, no policies and no membership —
 * they are separate features that happen to be the same idea applied twice: a
 * named thing, some people in it, and something they build up together. Listing
 * them apart would mean two nav entries for one concept, and the mobile bar had
 * already dropped its labels at six.
 *
 * What they do NOT share is how you get in. A map space adds you; a notes space
 * invites you. That asymmetry is visible here as the invites section, which has
 * no map equivalent because there is nothing to accept.
 */
export function SpacesView({ user, onOpenMapSpace, onOpenNoteSpace }: SpacesViewProps) {
  const [mapSpaces, setMapSpaces] = useState<MapSpace[] | null>(null);
  const [noteSpacesList, setNoteSpacesList] = useState<NoteSpace[] | null>(null);
  const [invites, setInvites] = useState<NoteSpace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [creating, setCreating] = useState<null | 'map' | 'notes'>(null);
  const [picking, setPicking] = useState(false);
  // The invite being answered, so its two buttons can show it without
  // disabling every other invite on screen.
  const [answering, setAnswering] = useState<string | null>(null);
  const { toast } = useToast();

  const load = useCallback(async () => {
    try {
      const [maps, mine, pending] = await Promise.all([
        mapSpacesApi.mine(),
        noteSpacesApi.mine(user.uid),
        noteSpacesApi.invites(user.uid),
      ]);
      setMapSpaces(maps);
      setNoteSpacesList(mine);
      setInvites(pending);
      setError(null);
    } catch (err) {
      console.error('Error loading spaces:', err);
      setError(describeError(err));
      setMapSpaces([]);
      setNoteSpacesList([]);
      setInvites([]);
    }
  }, [user.uid]);

  useEffect(() => { load(); }, [load]);

  const accept = async (space: NoteSpace) => {
    setAnswering(space.id);
    try {
      await noteSpacesApi.accept(space.id, user.uid);
      // Tell the owner. Not fatal if it fails — they are in the space either
      // way, and the membership row is the thing that matters.
      notificationsApi
        .create({
          recipientId: space.createdBy,
          actorId: user.uid,
          type: 'note_invite',
          noteSpaceId: space.id,
          subtype: 'accepted',
          content: space.name,
        })
        .catch((err) => console.error('Could not notify the owner:', err));

      toast(`Joined "${space.name}"`, 'success');
      await load();
    } catch (err) {
      console.error('Error accepting invite:', err);
      toast(describeError(err), 'error');
    } finally {
      setAnswering(null);
    }
  };

  const decline = async (space: NoteSpace) => {
    setAnswering(space.id);
    try {
      // Declining deletes the row outright. Nothing remembers the refusal, so
      // the owner can invite again — which is the behaviour people expect from
      // a declined invitation rather than a permanent block.
      await noteSpacesApi.leave(space.id, user.uid);
      setInvites((prev) => (prev ?? []).filter((s) => s.id !== space.id));
    } catch (err) {
      console.error('Error declining invite:', err);
      toast(describeError(err), 'error');
    } finally {
      setAnswering(null);
    }
  };

  const loading = mapSpaces === null || noteSpacesList === null;
  const showMaps = filter === 'all' || filter === 'map';
  const showNotes = filter === 'all' || filter === 'notes';
  const visibleCount =
    (showMaps ? mapSpaces?.length ?? 0 : 0) + (showNotes ? noteSpacesList?.length ?? 0 : 0);

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-fg">Spaces</h1>
        <button
          type="button"
          onClick={() => setPicking(true)}
          className="btn-primary flex h-9 items-center gap-1.5 px-4 text-xs"
        >
          <Plus size={14} />
          New space
        </button>
      </div>

      {/* --- filter ------------------------------------------------------- */}
      <div className="mb-4 flex gap-1.5">
        {([
          ['all', 'All'],
          ['map', 'Maps'],
          ['notes', 'Notes'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setFilter(id)}
            aria-pressed={filter === id}
            className={cn(
              'rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors',
              filter === id
                ? 'border-accent/40 bg-accent/10 text-accent'
                : 'border-line text-muted hover:bg-surface-2 hover:text-fg'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {error && (
        <p className="mb-3 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
        </p>
      )}

      {/* --- invites ------------------------------------------------------ */}
      {invites && invites.length > 0 && (
        <section className="mb-5">
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
            Invitations
          </h2>
          <ul className="space-y-2">
            {invites.map((space) => (
              <li
                key={space.id}
                className="flex items-center gap-3 rounded-2xl border border-accent/30 bg-accent/5 p-3"
              >
                <CategoryIcon category={space.category} compact />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-fg">{space.name}</p>
                  <p className="truncate text-xs text-muted">
                    {/* The viewer's own row, not the space's created_at: a
                        space made last year can be an invitation from today.
                        joined_at on a pending row is when it was sent. */}
                    {CATEGORY_META[space.category].label} · invited{' '}
                    {formatTimeAgo(
                      space.members.find((m) => m.userId === user.uid)?.joinedAt ?? space.createdAt
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => decline(space)}
                    disabled={answering === space.id}
                    aria-label={`Decline ${space.name}`}
                    className="rounded-full border border-line p-2 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
                  >
                    <X size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => accept(space)}
                    disabled={answering === space.id}
                    className="btn-primary flex h-8 items-center gap-1.5 px-3 text-xs"
                  >
                    {answering === space.id
                      ? <Loader2 size={13} className="animate-spin" />
                      : <Check size={13} />}
                    Accept
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* --- the spaces themselves ---------------------------------------- */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 size={18} className="animate-spin text-subtle" />
        </div>
      ) : visibleCount === 0 && !error ? (
        <div className="py-12 text-center">
          <p className="text-sm text-subtle">
            {filter === 'map'
              ? 'No map spaces yet.'
              : filter === 'notes'
                ? 'No notes spaces yet.'
                : 'No spaces yet.'}
          </p>
          <p className="mt-1 text-xs text-muted">
            A space is a shared map or a shared list. Make one and invite people.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {showMaps &&
            (mapSpaces ?? []).map((space) => (
              <li key={`map-${space.id}`}>
                <button
                  type="button"
                  onClick={() => onOpenMapSpace(space.id)}
                  className="flex w-full items-center gap-3 rounded-2xl border border-line bg-surface-2/40 p-3 text-left transition-colors hover:bg-surface-2"
                >
                  {/* The same ring as the note categories. A map row sitting
                      beside seven outlined circles in a filled rounded square
                      read as a mistake rather than a distinction — and the
                      distinction is already carried by the pin itself and by
                      the word "Map" underneath. */}
                  <span
                    aria-hidden
                    className="cat-ring cat-ring--outline cat-ring--sm flex shrink-0 items-center justify-center"
                  >
                    <MapPin size={17} className="cat-icon" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-fg">{space.name}</span>
                    <span className="block truncate text-xs text-muted">
                      Map · {space.members.length} {space.members.length === 1 ? 'person' : 'people'}
                    </span>
                  </span>
                  <AvatarStack users={space.members.map((m) => m.user)} max={3} size="xs" />
                </button>
              </li>
            ))}

          {showNotes &&
            (noteSpacesList ?? []).map((space) => {
              const accepted = space.members.filter((m) => m.status === 'accepted');
              const pending = space.members.filter((m) => m.status === 'pending');
              return (
                <li key={`notes-${space.id}`}>
                  <button
                    type="button"
                    onClick={() => onOpenNoteSpace(space)}
                    className="flex w-full items-center gap-3 rounded-2xl border border-line bg-surface-2/40 p-3 text-left transition-colors hover:bg-surface-2"
                  >
                    {/* The category icon and tint, not a generic notes glyph.
                        Same job the MapPin does for map spaces: tell you what
                        a row is before you read its name. */}
                    <CategoryIcon category={space.category} compact />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-fg">{space.name}</span>
                      <span className="block truncate text-xs text-muted">
                        {CATEGORY_META[space.category].label} · {accepted.length}{' '}
                        {accepted.length === 1 ? 'person' : 'people'}
                        {pending.length > 0 && ` · ${pending.length} invited`}
                      </span>
                    </span>
                    <AvatarStack users={accepted.map((m) => m.user)} max={3} size="xs" />
                  </button>
                </li>
              );
            })}
        </ul>
      )}

      {/* --- which kind? --------------------------------------------------- */}
      {picking && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="What kind of space?"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
          onClick={() => setPicking(false)}
        >
          <div
            className="w-full max-w-sm rounded-3xl border border-line bg-surface p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-1 text-center text-base font-semibold text-fg">New space</h2>
            <p className="mb-4 text-center text-xs text-muted">
              Two kinds, and they stay separate.
            </p>
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => { setPicking(false); setCreating('map'); }}
                className="flex w-full items-center gap-3 rounded-2xl border border-line p-3 text-left transition-colors hover:bg-surface-2"
              >
                <span
                  aria-hidden
                  className="cat-ring cat-ring--outline flex shrink-0 items-center justify-center"
                >
                  <MapPin size={19} className="cat-icon" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-fg">Map space</span>
                  <span className="block text-xs text-muted">
                    Pins on a shared map. People are added straight in.
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => { setPicking(false); setCreating('notes'); }}
                className="flex w-full items-center gap-3 rounded-2xl border border-line p-3 text-left transition-colors hover:bg-surface-2"
              >
                <span
                  aria-hidden
                  className="cat-ring cat-ring--outline flex shrink-0 items-center justify-center"
                >
                  <Notebook size={19} className="cat-icon" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-fg">Notes space</span>
                  <span className="block text-xs text-muted">
                    Notes and reminders. People are invited and have to accept.
                  </span>
                </span>
              </button>
            </div>
            <button
              type="button"
              onClick={() => setPicking(false)}
              className="btn-secondary mt-3 h-10 w-full text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {creating === 'map' && (
        <CreateSpaceModal
          user={user}
          onClose={() => setCreating(null)}
          onCreated={(id) => { setCreating(null); onOpenMapSpace(id); }}
        />
      )}
      {creating === 'notes' && (
        <CreateNoteSpaceModal
          user={user}
          onClose={() => setCreating(null)}
          onCreated={async () => {
            setCreating(null);
            await load();
          }}
        />
      )}
    </div>
  );
}
