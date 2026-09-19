import React, { useState, useEffect } from 'react';
import { Search, Check, Loader2, ChevronLeft } from './icons';
import { Modal, ModalHeader, ModalBody, ModalFooter } from './Modal';
import { Avatar } from './Avatar';
import { useToast } from './ToastContext';
import { follows as followsApi, notifications as notificationsApi } from '../lib/db';
import { noteSpaces as noteSpacesApi, listStyleFor } from '../lib/notes';
import type { NoteCategory } from '../lib/notes';
import { CATEGORY_META, CATEGORY_ORDER, CategoryIcon } from './noteCategories';
import { describeError } from '../lib/utils';
import { cn } from '../lib/utils';
import type { User } from '../types';

/**
 * Example names, shown in the placeholder once a category is picked.
 *
 * Kept here rather than in CATEGORY_META because they are specific to this one
 * field — they are a prompt for naming, not a property of the category, and
 * nothing else in the app has a use for them.
 */
const NAME_HINTS: Record<NoteCategory, string> = {
  cooking: 'Weeknight dinners, Sunday roast…',
  trip: 'Naples in June, Road trip…',
  date_ideas: 'Saturdays, Rainy days…',
  movies: 'Watchlist, Horror night…',
  gifts: 'Her birthday, Christmas…',
  bucket_list: 'Someday, Before we are 40…',
  general: 'Flat admin, Shopping…',
};

interface CreateNoteSpaceModalProps {
  user: User;
  onClose: () => void;
  onCreated?: (spaceId: string) => void;
}

/**
 * Name a notes space and invite people to it.
 *
 * Unlike <CreateSpaceModal /> for maps, the people picked here are INVITED,
 * not added: each gets a pending membership row that grants nothing, plus a
 * notification to accept or decline. The copy says "invite" throughout for
 * that reason — telling someone they have added a person who has not agreed
 * yet would be a lie the schema does not support.
 */
export function CreateNoteSpaceModal({ user, onClose, onCreated }: CreateNoteSpaceModalProps) {
  // Category first, then the details. Picking what the space is FOR before
  // naming it is the right order: the answer to "what do I call this" is much
  // easier once the screen has already said "Cooking", and the placeholder in
  // the name field can then suggest something in the right register.
  const [category, setCategory] = useState<NoteCategory | null>(null);
  const [name, setName] = useState('');
  const [people, setPeople] = useState<User[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Same source the mention picker, the group-chat composer and the map
        // space modal use: people the viewer actually has a relationship with.
        const mutuals = await followsApi.mentionable(user.uid);
        if (!cancelled) setPeople(mutuals);
      } catch (err) {
        console.error('Error loading people:', err);
        if (!cancelled) setPeople([]);
      }
    })();
    return () => { cancelled = true; };
  }, [user.uid]);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const save = async () => {
    if (!name.trim() || !category) return;
    setSaving(true);
    try {
      const spaceId = await noteSpacesApi.create({
        name,
        category,
        createdBy: user.uid,
        inviteeIds: [...picked],
      });

      // Notifications are sent after the space exists, one per invitee, and
      // their failure is not the creation's failure — the pending rows are
      // already in place and the invites show up in the other person's Spaces
      // tab regardless. Hence allSettled and a warning, not a throw.
      const sent = await Promise.allSettled(
        [...picked].map((recipientId) =>
          notificationsApi.create({
            recipientId,
            actorId: user.uid,
            type: 'note_invite',
            noteSpaceId: spaceId,
            content: name.trim(),
          })
        )
      );
      const failed = sent.filter((r) => r.status === 'rejected').length;
      if (failed > 0) {
        console.error(`${failed} invite notification(s) could not be sent`);
      }

      toast(
        picked.size > 0
          ? `"${name.trim()}" created — ${picked.size} invited`
          : `"${name.trim()}" created`,
        'success'
      );
      onCreated?.(spaceId);
      onClose();
    } catch (err) {
      console.error('Error creating notes space:', err);
      toast(describeError(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const filtered = (people ?? []).filter((p) =>
    `${p.displayName} ${p.username}`.toLowerCase().includes(query.toLowerCase())
  );

  // --- step one: what is it for? -------------------------------------------
  if (!category) {
    return (
      <Modal onClose={onClose} size="lg" labelledBy="note-space-title" className="sm:h-[75vh]">
        <ModalHeader
          title="New notes space"
          subtitle="What is it for?"
          onClose={onClose}
          id="note-space-title"
        />

        <ModalBody className="scrollbar-thin">
          <div className="grid grid-cols-2 gap-2">
            {CATEGORY_ORDER.map((id) => {
              const meta = CATEGORY_META[id];
              const checklist = listStyleFor(id) === 'checklist';
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setCategory(id)}
                  // cat-tile is the animation's trigger and meta.animClass
                  // names which one; both are inert without the other. See the
                  // note-category block in index.css.
                  className={cn(
                    'cat-tile flex flex-col gap-2 rounded-2xl border border-line bg-surface-2/40 p-3 text-left transition-colors hover:border-accent/40 hover:bg-surface-2',
                    meta.animClass
                  )}
                >
                  <CategoryIcon category={id} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-fg">{meta.label}</span>
                    <span className="block text-xs leading-snug text-muted">{meta.hint}</span>
                  </span>
                  {/* Said up front, because it is the one thing that cannot be
                      changed later without moving every entry. */}
                  <span className="text-[11px] text-subtle">
                    {checklist ? 'Tick things off' : 'A running list'}
                  </span>
                </button>
              );
            })}
          </div>
        </ModalBody>
      </Modal>
    );
  }

  // --- step two: name it and invite people ----------------------------------
  const meta = CATEGORY_META[category];

  return (
    <Modal onClose={onClose} size="lg" labelledBy="note-space-title" className="sm:h-[75vh]">
      <ModalHeader
        title={`New ${meta.label.toLowerCase()} space`}
        subtitle="Name it and invite people"
        onClose={onClose}
        id="note-space-title"
      />

      <ModalBody className="scrollbar-thin space-y-3">
        <button
          type="button"
          onClick={() => setCategory(null)}
          className="flex items-center gap-1.5 text-xs font-medium text-muted transition-colors hover:text-fg"
        >
          <ChevronLeft size={14} />
          Change category
        </button>

        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          placeholder={`Name it — ${NAME_HINTS[category]}`}
          className="field"
        />

        <div className="relative">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search people…"
            className="field pl-10"
          />
          <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-subtle" />
        </div>

        <p className="text-xs leading-relaxed text-muted">
          Everyone you invite gets asked first. Once they accept they can read
          and add to this space. You can invite more people later.
        </p>

        {people === null ? (
          <div className="flex justify-center py-8">
            <Loader2 size={18} className="animate-spin text-subtle" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-8 text-center text-sm text-subtle">
            {query ? 'Nobody matches that.' : 'Nobody to invite yet — follow some people first.'}
          </p>
        ) : (
          <ul className="space-y-1">
            {filtered.map((p) => (
              <li key={p.uid}>
                <button
                  type="button"
                  onClick={() => toggle(p.uid)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-xl p-2 text-left transition-colors',
                    picked.has(p.uid) ? 'bg-accent/10' : 'hover:bg-surface-2'
                  )}
                >
                  <Avatar user={p} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-fg">{p.displayName}</span>
                    <span className="block truncate text-xs text-muted">@{p.username}</span>
                  </span>
                  {picked.has(p.uid) && <Check size={16} className="shrink-0 text-accent" />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </ModalBody>

      <ModalFooter>
        <button
          type="button"
          onClick={save}
          disabled={!name.trim() || saving}
          className="btn-primary flex h-11 w-full items-center justify-center gap-2 text-sm"
        >
          {saving ? <Loader2 size={16} className="animate-spin" /> : <meta.icon size={16} />}
          {saving
            ? 'Creating…'
            : picked.size > 0
              ? `Create and invite ${picked.size}`
              : 'Create just for me'}
        </button>
      </ModalFooter>
    </Modal>
  );
}
