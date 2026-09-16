import React, { useState, useEffect } from 'react';
import { Search, Check, Loader2, UserPlus, Users as UsersIcon } from './icons';
import { Modal, ModalHeader, ModalBody, ModalFooter } from './Modal';
import { Avatar } from './Avatar';
import { useToast } from './ToastContext';
import { follows as followsApi } from '../lib/db';
import { spaces as spacesApi, MapSpace } from '../lib/pins';
import { describeError } from '../lib/utils';
import { cn } from '../lib/utils';
import type { User } from '../types';

interface SpaceMembersModalProps {
  user: User;
  space: MapSpace;
  onClose: () => void;
  /** Reload the map, so the new members show up in the pin attribution rows. */
  onChanged?: () => void;
}

/**
 * Who is in a space, and — for its owner — adding more.
 *
 * The create modal has always told people "You can add more people later",
 * which until now was a promise nothing in the app kept: membership was fixed
 * at creation, and forgetting someone meant rebuilding the space and losing
 * every pin in it.
 *
 * Adding is owner-only, and that is enforced in the database rather than here
 * (map_space_members_insert_owner, 0017). This hides the control from everyone
 * else so they are not offered an action that would fail, but the hiding is
 * the courtesy, not the security.
 *
 * No invitations to accept, matching the create modal and group chats: people
 * are added straight in. There is no pending state anywhere in this app to
 * reuse, and inventing one here would make spaces behave unlike every other
 * shared thing in it.
 */
export function SpaceMembersModal({ user, space, onClose, onChanged }: SpaceMembersModalProps) {
  const [people, setPeople] = useState<User[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const isOwner = space.createdBy === user.uid;
  const memberIds = new Set(space.members.map((m) => m.userId));

  useEffect(() => {
    // Non-owners cannot add anyone, so there is nothing to choose from and no
    // reason to spend the request.
    if (!isOwner) { setPeople([]); return; }
    let cancelled = false;
    (async () => {
      try {
        // Same source as the create modal and the group-chat composer.
        const mutuals = await followsApi.mentionable(user.uid);
        if (!cancelled) setPeople(mutuals);
      } catch (err) {
        console.error('Error loading people:', err);
        if (!cancelled) setPeople([]);
      }
    })();
    return () => { cancelled = true; };
  }, [user.uid, isOwner]);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const save = async () => {
    if (!picked.size) return;
    setSaving(true);
    try {
      await spacesApi.addMembers(space.id, [...picked]);
      toast(
        picked.size === 1
          ? `Added to "${space.name}"`
          : `${picked.size} people added to "${space.name}"`,
        'success'
      );
      onChanged?.();
      onClose();
    } catch (err) {
      console.error('Error adding space members:', err);
      toast(describeError(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  // Anyone already in the space is filtered out rather than shown as disabled:
  // the insert would fail on the primary key, and a row you can see but not
  // press is a worse explanation than simply listing them above as a member.
  const candidates = (people ?? []).filter((p) => !memberIds.has(p.uid));
  const filtered = candidates.filter((p) =>
    `${p.displayName} ${p.username}`.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <Modal onClose={onClose} size="lg" labelledBy="space-members-title" className="sm:h-[75vh]">
      <ModalHeader
        title={space.name}
        subtitle={`${space.members.length} ${space.members.length === 1 ? 'person' : 'people'} in this space`}
        onClose={onClose}
        id="space-members-title"
      />

      <ModalBody className="scrollbar-thin space-y-4">
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">
            In this space
          </h3>
          <ul className="space-y-1">
            {space.members.map((m) => (
              <li key={m.userId} className="flex items-center gap-3 rounded-xl p-2">
                {m.user ? <Avatar user={m.user} size="sm" /> : null}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-fg">
                    {m.userId === user.uid ? 'You' : m.user?.displayName ?? 'Someone'}
                  </span>
                  {m.user?.username && (
                    <span className="block truncate text-xs text-muted">@{m.user.username}</span>
                  )}
                </span>
                {m.role === 'owner' && (
                  <span className="shrink-0 rounded-full bg-surface-3 px-2 py-0.5 text-[11px] font-medium text-muted">
                    Owner
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>

        {isOwner ? (
          <div className="border-t border-line pt-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">
              Add someone
            </h3>

            <div className="relative">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search people…"
                className="field pl-10"
              />
              <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-subtle" />
            </div>

            <p className="mt-2 text-xs leading-relaxed text-muted">
              Anyone you add can see every pin already here, and add their own.
            </p>

            {people === null ? (
              <div className="flex justify-center py-8">
                <Loader2 size={18} className="animate-spin text-subtle" />
              </div>
            ) : filtered.length === 0 ? (
              <p className="py-8 text-center text-sm text-subtle">
                {query
                  ? 'Nobody matches that.'
                  : candidates.length === 0 && (people ?? []).length > 0
                    ? 'Everyone you follow is already in this space.'
                    : 'Nobody to add yet — follow some people first.'}
              </p>
            ) : (
              <ul className="mt-2 space-y-1">
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
          </div>
        ) : (
          <p className="border-t border-line pt-4 text-xs leading-relaxed text-muted">
            Only whoever made this space can add people to it.
          </p>
        )}
      </ModalBody>

      {isOwner && (
        <ModalFooter>
          <button
            type="button"
            onClick={save}
            disabled={!picked.size || saving}
            className="btn-primary flex h-11 w-full items-center justify-center gap-2 text-sm disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <UserPlus size={16} />}
            {saving
              ? 'Adding…'
              : picked.size === 0
                ? 'Pick someone to add'
                : `Add ${picked.size} ${picked.size === 1 ? 'person' : 'people'}`}
          </button>
        </ModalFooter>
      )}
    </Modal>
  );
}
