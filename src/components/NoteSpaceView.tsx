import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ArrowLeft, Plus, Loader2, CalendarClock, CircleDashed, CheckCircle2,
  Trash2, Users as UsersIcon, X, ChevronDown,
} from './icons';
import { Avatar } from './Avatar';
import { AvatarStack } from './AvatarStack';
import { useToast } from './ToastContext';
import { notes as notesApi, noteSpaces as noteSpacesApi, sortNotes, isTickable, splitToday } from '../lib/notes';
import type { Note, NoteSpace } from '../lib/notes';
import { CATEGORY_META, CategoryIcon } from './noteCategories';
import { cn, describeError, formatTimeAgo } from '../lib/utils';
import type { User } from '../types';

interface NoteSpaceViewProps {
  user: User;
  space: NoteSpace;
  onBack: () => void;
  onUserClick?: (userId: string) => void;
}

/**
 * Formats a due date the way someone reads a deadline: what matters is whether
 * it has passed and roughly when it is, not the year.
 */
function formatDue(iso: string): { label: string; overdue: boolean; soon: boolean } {
  const due = new Date(iso);
  const now = new Date();
  const overdue = due.getTime() <= now.getTime();
  const soon = !overdue && due.getTime() - now.getTime() < 24 * 60 * 60 * 1000;

  const sameYear = due.getFullYear() === now.getFullYear();
  const label = due.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return { label, overdue, soon };
}

/**
 * `datetime-local` speaks local wall-clock with no zone; the column is
 * timestamptz. Round-tripping through Date is what reconciles them — the
 * browser attaches the viewer's offset on the way in, and strips it on the way
 * back out so the input shows the same wall-clock it was given.
 */
const toIso = (localValue: string): string => new Date(localValue).toISOString();

const toLocalInput = (iso: string): string => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * One entry, used by both sections so they cannot drift apart.
 *
 * `tickable` is passed in rather than derived here: the Today section forces
 * it true regardless of the space's category, because everything grouped there
 * is a reminder and a reminder you cannot tick off is not a reminder.
 */
function NoteRow({
  note, space, user, busy, tickable, onToggle, onRemove, onUserClick,
}: {
  note: Note;
  space: NoteSpace;
  user: User;
  busy: boolean;
  tickable: boolean;
  onToggle: (note: Note) => void;
  onRemove: (note: Note) => void;
  onUserClick?: (userId: string) => void;
  /**
   * Declared explicitly, which should not be necessary and is.
   *
   * This project has no @types/react — check node_modules/@types — so TSX
   * intrinsics fall back to `any` and custom components are checked as plain
   * structural objects, with none of React's own handling of the reserved
   * `key` prop. Nothing had hit it before because this is the first custom
   * component in the codebase rendered from a .map() with a key; every other
   * keyed element is an intrinsic <li> or <div>, which is untyped.
   *
   * React still strips `key` before the props reach this function, so it is
   * never actually readable in here. Declaring it only quiets the checker.
   * The real fix is adding @types/react — see the note in the handover.
   */
  key?: string;
}) {
  const dueInfo = note.dueDate ? formatDue(note.dueDate) : null;
  // "Edited" only when it actually was: the trigger stamps updated_at on every
  // write, so it is never equal to created_at after the first edit and always
  // equal before one.
  const edited = note.updatedAt !== note.createdAt;

  return (
    <li
      className={cn(
        'group flex items-start gap-3 rounded-2xl border border-line bg-surface-2/40 p-3 transition-opacity',
        note.completed && 'opacity-50'
      )}
    >
      {tickable ? (
        <button
          type="button"
          onClick={() => onToggle(note)}
          disabled={busy}
          aria-label={note.completed ? 'Mark as not done' : 'Mark as done'}
          aria-pressed={note.completed}
          className="mt-0.5 shrink-0 text-muted transition-colors hover:text-accent"
        >
          {note.completed
            ? <CheckCircle2 size={20} className="text-accent" />
            : <CircleDashed size={20} />}
        </button>
      ) : (
        // No checkbox in a plain-list space: a bucket list where every wish
        // sits next to an empty box reads as a backlog of things you have
        // failed to do. The spacer keeps the text on the same left edge as any
        // reminder alongside it, so the column does not jog.
        <span aria-hidden className="mt-0.5 w-5 shrink-0" />
      )}

      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'whitespace-pre-wrap break-words text-sm text-fg',
            note.completed && 'line-through'
          )}
        >
          {note.content}
        </p>

        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
          <button
            type="button"
            onClick={() => note.author && onUserClick?.(note.author.uid)}
            className="flex items-center gap-1.5 transition-colors hover:text-fg"
          >
            {note.author && <Avatar user={note.author} size="xs" />}
            <span>{note.author?.displayName ?? 'Someone'}</span>
          </button>
          <span aria-hidden>·</span>
          <span>
            {edited
              ? `edited ${formatTimeAgo(note.updatedAt)}`
              : `added ${formatTimeAgo(note.createdAt)}`}
          </span>
          {edited && note.editor && note.editor.uid !== note.authorId && (
            <span>by {note.editor.displayName}</span>
          )}
        </div>
      </div>

      {dueInfo && (
        <span
          className={cn(
            'mt-0.5 flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium',
            note.completed
              ? 'bg-surface-2 text-subtle'
              : dueInfo.overdue
                ? 'bg-danger/15 text-danger'
                : dueInfo.soon
                  ? 'bg-accent/15 text-accent'
                  : 'bg-surface-2 text-muted'
          )}
        >
          <CalendarClock size={12} />
          {dueInfo.label}
        </span>
      )}

      {(note.authorId === user.uid || space.createdBy === user.uid) && (
        <button
          type="button"
          onClick={() => onRemove(note)}
          aria-label={`Delete "${note.content.slice(0, 40)}"`}
          // hover-reveal, not opacity-0 + group-hover: on a phone or a tablet
          // there is no hover to reveal it with, and the button was simply
          // invisible. See the note in index.css.
          className="hover-reveal mt-0.5 shrink-0 rounded-full p-1.5 text-subtle transition-colors hover:bg-surface-2 hover:text-danger"
        >
          <Trash2 size={14} />
        </button>
      )}
    </li>
  );
}

export function NoteSpaceView({ user, space: initialSpace, onBack, onUserClick }: NoteSpaceViewProps) {
  const [space, setSpace] = useState<NoteSpace>(initialSpace);
  const [items, setItems] = useState<Note[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [due, setDue] = useState<string>('');
  const [wantsDue, setWantsDue] = useState(false);
  const [saving, setSaving] = useState(false);
  // The note whose completed state is mid-flight, so its checkbox can show it
  // without freezing the whole list.
  const [busyId, setBusyId] = useState<string | null>(null);
  const [todayOpen, setTodayOpen] = useState(true);
  /**
   * The current local calendar date, as a re-render trigger.
   *
   * Without it, a tab left open overnight keeps yesterday's reminders under a
   * heading that says Today — a screen that is quietly, confidently wrong, and
   * the kind of thing nobody notices until they miss something. The effect
   * below re-arms itself at each local midnight.
   */
  const [dayStamp, setDayStamp] = useState(() => new Date().toDateString());
  const { toast } = useToast();

  useEffect(() => {
    const now = new Date();
    const midnight = new Date(now);
    // setHours(24, …) rolls into the next day, and does it correctly across
    // month and year ends and across a DST change, which arithmetic on
    // 86_400_000 milliseconds does not.
    midnight.setHours(24, 0, 0, 0);
    const timer = setTimeout(
      () => setDayStamp(new Date().toDateString()),
      midnight.getTime() - now.getTime() + 1_000
    );
    return () => clearTimeout(timer);
  }, [dayStamp]);

  const load = useCallback(async () => {
    try {
      const list = await notesApi.list(initialSpace.id);
      setItems(list);
      setError(null);
    } catch (err) {
      // A failed fetch is not an empty list. Saying "nothing here yet" when
      // the query failed is the conflation this project has been bitten by.
      console.error('Error loading notes:', err);
      setError(describeError(err));
      setItems([]);
    }
  }, [initialSpace.id]);

  useEffect(() => { load(); }, [load]);

  // Someone else adding, editing or ticking something. This is what makes two
  // accounts agree without either of them refreshing.
  useEffect(() => notesApi.subscribe(initialSpace.id, load), [initialSpace.id, load]);

  // And someone accepting their invitation, so the roster stops saying they
  // are pending while they are reading the same list.
  useEffect(
    () =>
      noteSpacesApi.subscribe(initialSpace.id, async () => {
        try {
          const fresh = await noteSpacesApi.get(initialSpace.id);
          if (fresh) setSpace(fresh);
        } catch (err) {
          console.error('Error refreshing space:', err);
        }
      }),
    [initialSpace.id]
  );

  const meta = CATEGORY_META[space.category];

  const accepted = useMemo(
    () => space.members.filter((m) => m.status === 'accepted'),
    [space.members]
  );
  const pending = useMemo(
    () => space.members.filter((m) => m.status === 'pending'),
    [space.members]
  );

  // dayStamp is listed deliberately: it is not read in the body, but it is
  // what makes the split recompute when the clock rolls past midnight.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const { today, rest } = useMemo(() => splitToday(items ?? []), [items, dayStamp]);
  const doneToday = today.filter((n) => n.completed).length;

  const add = async () => {
    const text = content.trim();
    if (!text || saving) return;
    if (wantsDue && !due) {
      toast('Pick a date and time, or turn the reminder off', 'error');
      return;
    }

    setSaving(true);
    try {
      const created = await notesApi.create({
        spaceId: space.id,
        authorId: user.uid,
        content: text,
        dueDate: wantsDue && due ? toIso(due) : null,
      });
      // Inserted locally as well as awaited from realtime: the round trip is
      // visible on a slow connection, and a compose box that clears into
      // nothing looks like a failure.
      setItems((prev) => sortNotes([...(prev ?? []).filter((n) => n.id !== created.id), created]));
      setContent('');
      setDue('');
      setWantsDue(false);
    } catch (err) {
      console.error('Error adding note:', err);
      toast(describeError(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (note: Note) => {
    setBusyId(note.id);
    // Optimistic: ticking a box that waits for a server is the interaction
    // people notice most. Reverted below if the write is refused.
    const previous = items;
    setItems((prev) =>
      sortNotes((prev ?? []).map((n) => (n.id === note.id ? { ...n, completed: !n.completed } : n)))
    );
    try {
      const updated = await notesApi.setCompleted(note.id, !note.completed);
      setItems((prev) => sortNotes((prev ?? []).map((n) => (n.id === updated.id ? updated : n))));
    } catch (err) {
      console.error('Error updating note:', err);
      setItems(previous);
      toast(describeError(err), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (note: Note) => {
    const previous = items;
    setItems((prev) => (prev ?? []).filter((n) => n.id !== note.id));
    try {
      await notesApi.remove(note.id);
    } catch (err) {
      console.error('Error deleting note:', err);
      setItems(previous);
      toast(describeError(err), 'error');
    }
  };

  return (
    <div className="mx-auto w-full max-w-2xl">
      {/* --- header ------------------------------------------------------- */}
      <div className="mb-4 flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to spaces"
          className="rounded-full p-2 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <ArrowLeft size={20} />
        </button>
        <CategoryIcon category={space.category} compact />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold text-fg">{space.name}</h1>
          <p className="truncate text-xs text-muted">
            {meta.label} · {accepted.length} {accepted.length === 1 ? 'member' : 'members'}
            {pending.length > 0 && ` · ${pending.length} invited`}
          </p>
        </div>
        {accepted.length > 0 && (
          <AvatarStack
            users={accepted.map((m) => m.user).filter(Boolean) as User[]}
            max={4}
            size="sm"
          />
        )}
      </div>

      {/* --- compose ------------------------------------------------------ */}
      <div className="mb-4 rounded-2xl border border-line bg-surface-2/40 p-3">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          maxLength={2000}
          rows={2}
          placeholder={meta.placeholder}
          className="field resize-none"
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter breaks the line — the same contract as
            // the message composer, because it is the same shape of box.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              add();
            }
          }}
        />

        {/* Two rows, not one wrapping row.
            A <input type="datetime-local"> has an intrinsic width it will not
            shrink below — around 150px plus the picker indicator — so the chip,
            the field, the clear button and the submit button together overran
            the card on a phone. `ml-auto` then pushed the submit button past
            the right edge, off screen and unclickable. Separating the controls
            from the action means the action can never be what gets pushed
            out. */}
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              const next = !wantsDue;
              setWantsDue(next);
              // Default to an hour out rather than an empty picker: a toggle
              // that produces a field you must then fill in twice is a toggle
              // that does nothing.
              if (next && !due) {
                const soon = new Date(Date.now() + 60 * 60 * 1000);
                soon.setSeconds(0, 0);
                setDue(toLocalInput(soon.toISOString()));
              }
            }}
            className={cn(
              'flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
              wantsDue
                ? 'border-accent/40 bg-accent/10 text-accent'
                : 'border-line text-muted hover:bg-surface-2 hover:text-fg'
            )}
          >
            <CalendarClock size={14} />
            {wantsDue ? 'Reminder' : 'Add due date'}
          </button>

          {wantsDue && (
              <>
                <input
                  type="datetime-local"
                  value={due}
                  onChange={(e) => setDue(e.target.value)}
                  aria-label="Due date and time"
                  // min-w-0 + flex-1 lets it give way on a narrow screen
                  // instead of forcing the row wider than its container;
                  // basis keeps it a sensible size when there is room.
                  // color-scheme:dark makes the native picker and its
                  // calendar indicator match the theme — without it Chrome
                  // draws a white widget on the dark card.
                  className="min-w-0 flex-1 basis-40 rounded-full border border-line bg-surface-2 px-3 py-1.5 text-xs text-fg [color-scheme:dark]"
                />
                <button
                  type="button"
                  onClick={() => { setWantsDue(false); setDue(''); }}
                  aria-label="Remove due date"
                  className="shrink-0 rounded-full p-1.5 text-subtle transition-colors hover:bg-surface-2 hover:text-fg"
                >
                  <X size={14} />
                </button>
              </>
            )}
          </div>

          <button
            type="button"
            onClick={add}
            disabled={!content.trim() || saving}
            // Full width on a phone, where it is the only thing on its row and
            // a wide target is easier to hit; back to hugging its label and
            // sitting right once there is room for it.
            className="btn-primary flex h-9 w-full items-center justify-center gap-1.5 px-4 text-xs sm:w-auto sm:self-end"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            {wantsDue ? 'Add reminder' : `Add ${meta.itemNoun}`}
          </button>
        </div>
      </div>

      {/* --- list --------------------------------------------------------- */}
      {error && (
        <p className="mb-3 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
        </p>
      )}

      {items === null ? (
        <div className="flex justify-center py-12">
          <Loader2 size={18} className="animate-spin text-subtle" />
        </div>
      ) : items.length === 0 && !error ? (
        <div className="py-12 text-center">
          <p className="text-sm text-subtle">{meta.emptyTitle}</p>
          <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-muted">
            {meta.emptyHint}
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {/* --- Today ------------------------------------------------- */}
          {today.length > 0 && (
            <section>
              <button
                type="button"
                onClick={() => setTodayOpen((open) => !open)}
                aria-expanded={todayOpen}
                className="mb-2 flex w-full items-center gap-2 text-left"
              >
                <ChevronDown
                  size={15}
                  className={cn(
                    "shrink-0 text-muted transition-transform duration-150",
                    !todayOpen && "-rotate-90"
                  )}
                />
                <span className="text-[11px] font-semibold uppercase tracking-wider text-fg">
                  Today ({today.length})
                </span>
                {doneToday > 0 && (
                  <span className="text-[11px] text-subtle">· {doneToday} done</span>
                )}
                <span className="ml-auto h-px flex-1 bg-line" aria-hidden />
              </button>

              {/* `tickable` is hard-coded true here, whatever the space's
                  category: everything grouped under Today is a reminder by
                  definition, and Today is a worklist. So a Bucket list — which
                  has no checkboxes anywhere else — still gets them for the one
                  thing that is due today. */}
              {todayOpen && (
                <ul className="space-y-2">
                  {today.map((note) => (
                    <NoteRow
                      key={note.id}
                      note={note}
                      space={space}
                      user={user}
                      busy={busyId === note.id}
                      tickable
                      onToggle={toggle}
                      onRemove={remove}
                      onUserClick={onUserClick}
                    />
                  ))}
                </ul>
              )}
            </section>
          )}

          {/* --- everything else ---------------------------------------- */}
          {rest.length > 0 && (
            <section>
              {today.length > 0 && (
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Everything else
                </p>
              )}
              <ul className="space-y-2">
                {rest.map((note) => (
                  <NoteRow
                    key={note.id}
                    note={note}
                    space={space}
                    user={user}
                    busy={busyId === note.id}
                    tickable={isTickable(space.category, note)}
                    onToggle={toggle}
                    onRemove={remove}
                    onUserClick={onUserClick}
                  />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      {pending.length > 0 && (
        <p className="mt-6 flex items-center justify-center gap-1.5 text-xs text-subtle">
          <UsersIcon size={12} />
          Waiting on {pending.map((m) => m.user?.displayName ?? 'someone').join(', ')}
        </p>
      )}
    </div>
  );
}
