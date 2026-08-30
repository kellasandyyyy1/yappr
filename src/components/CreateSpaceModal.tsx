import React, { useState, useEffect } from 'react';
import { Search, Check, Loader2, Users as UsersIcon } from 'lucide-react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from './Modal';
import { Avatar } from './Avatar';
import { useToast } from './ToastContext';
import { follows as followsApi } from '../lib/db';
import { spaces as spacesApi } from '../lib/pins';
import { describeError } from '../lib/utils';
import { cn } from '../lib/utils';
import type { User } from '../types';

interface CreateSpaceModalProps {
  user: User;
  onClose: () => void;
  onCreated?: (spaceId: string) => void;
}

/**
 * Name a space and pick who is in it.
 *
 * Members are added directly, with no invite to accept. That mirrors group
 * chats, which is the only comparable flow in the app and which also adds
 * people straight into conversation_members — there is no pending state
 * anywhere to reuse. If spaces should require acceptance, group chats
 * probably should too, and it wants building once for both.
 */
export function CreateSpaceModal({ user, onClose, onCreated }: CreateSpaceModalProps) {
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
        // Same source the mention picker and the group-chat composer use:
        // people the viewer actually has a relationship with.
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
    if (!name.trim()) return;
    setSaving(true);
    try {
      const spaceId = await spacesApi.create({
        name,
        createdBy: user.uid,
        memberIds: [...picked],
      });
      toast(`"${name.trim()}" created`, 'success');
      onCreated?.(spaceId);
      onClose();
    } catch (err) {
      console.error('Error creating space:', err);
      toast(describeError(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const filtered = (people ?? []).filter((p) =>
    `${p.displayName} ${p.username}`.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <Modal onClose={onClose} size="lg" labelledBy="space-title" className="sm:h-[75vh]">
      <ModalHeader
        title="New map space"
        subtitle="A shared map everyone in it can keep adding to"
        onClose={onClose}
        id="space-title"
      />

      <ModalBody className="scrollbar-thin space-y-3">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          placeholder="Name it — Summer trip, Our places…"
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
          Everyone you add can see every pin in this space and add their own. You
          can add more people later.
        </p>

        {people === null ? (
          <div className="flex justify-center py-8">
            <Loader2 size={18} className="animate-spin text-subtle" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-8 text-center text-sm text-subtle">
            {query ? 'Nobody matches that.' : 'Nobody to add yet — follow some people first.'}
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
          {saving ? <Loader2 size={16} className="animate-spin" /> : <UsersIcon size={16} />}
          {saving
            ? 'Creating…'
            : picked.size > 0
              ? `Create with ${picked.size} ${picked.size === 1 ? 'person' : 'people'}`
              : 'Create just for me'}
        </button>
      </ModalFooter>
    </Modal>
  );
}
