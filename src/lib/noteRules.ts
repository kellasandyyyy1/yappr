/**
 * The rules a notes space follows, with no I/O.
 *
 * Split out of notes.ts so it can be exercised on its own: notes.ts imports
 * the Supabase client, which reads import.meta.env at module scope and so
 * cannot be loaded outside a Vite build. That made every one of these
 * functions — the category rules, the ordering, and what counts as "today" —
 * unreachable from a plain node script, which is exactly the code most worth
 * checking directly.
 *
 * notes.ts re-exports all of it, so every existing import keeps working.
 */
import type { Note } from './notes';

/** Mirrors the note_space_category enum (0027). */
export type NoteCategory =
  | 'cooking' | 'trip' | 'date_ideas' | 'movies' | 'gifts' | 'bucket_list' | 'general';

export type ListStyle = 'checklist' | 'plain';

/**
 * Whether a space's entries are tickable, derived from its category rather
 * than stored alongside it — two columns that can disagree is one column too
 * many, and the first bug would be a Cooking space that renders as a plain
 * list.
 *
 * The distinction is about whether the entries are things you WORK THROUGH. A
 * shopping list and an itinerary get finished; date ideas and a bucket list
 * accumulate, and putting an unticked box next to "see the northern lights"
 * turns a wish into an outstanding task.
 */
const CHECKLIST_CATEGORIES: ReadonlySet<NoteCategory> = new Set<NoteCategory>([
  'cooking', 'trip', 'movies',
]);

export function listStyleFor(category: NoteCategory): ListStyle {
  return CHECKLIST_CATEGORIES.has(category) ? 'checklist' : 'plain';
}

/**
 * Does this particular entry get a checkbox?
 *
 * Two independent reasons for one to appear, which is why this is a function
 * and not just the list style:
 *
 *   • the space is a checklist, so everything in it is tickable
 *   • the entry has a due date, so it is a reminder — and a reminder you
 *     cannot mark done is not a reminder
 *
 * A due date is orthogonal to the category: "book the restaurant by Friday"
 * belongs in Date ideas and still needs ticking off.
 */
export function isTickable(category: NoteCategory, note: Pick<Note, 'dueDate'>): boolean {
  return listStyleFor(category) === 'checklist' || Boolean(note.dueDate);
}

/**
 * Ordering, in one place because two screens depend on it being the same:
 *
 *   1. incomplete reminders, soonest due first — the things with a deadline
 *   2. plain notes, newest first
 *   3. completed reminders, most recently completed first, de-emphasised
 *
 * Sorted client-side rather than in the query. The three groups are defined by
 * a combination of due_date, completed and null-ness that PostgREST's `order`
 * cannot express in one pass, and a space holds tens of notes, not thousands.
 */
export function sortNotes(list: Note[]): Note[] {
  const rank = (n: Note) => (n.completed ? 2 : n.dueDate ? 0 : 1);
  return [...list].sort((a, b) => {
    const byGroup = rank(a) - rank(b);
    if (byGroup !== 0) return byGroup;

    if (rank(a) === 0) return (a.dueDate ?? '').localeCompare(b.dueDate ?? '');
    if (rank(a) === 1) return b.createdAt.localeCompare(a.createdAt);
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

/**
 * Is this a reminder falling due at some point during today?
 *
 * "Today" is the VIEWER'S LOCAL calendar day, compared field by field rather
 * than by an ISO-string prefix. due_date is timestamptz and arrives as UTC, so
 * `note.dueDate.startsWith(todayIso)` — the obvious one-liner — is wrong
 * everywhere east or west of Greenwich: at UTC+8 a reminder set for 7am today
 * is stored as 23:00 yesterday, and would be filed under the wrong day by a
 * string compare. Date's own accessors are local by definition, so this
 * question is asked in the timezone the person actually lives in.
 *
 * Two people in different timezones therefore see different Today sections for
 * the same space. That is correct: a deadline of "Tuesday 9am" is a local
 * claim, and grouping it under the other person's Tuesday would be the bug.
 */
export function isDueToday(note: Pick<Note, 'dueDate'>, now: Date = new Date()): boolean {
  if (!note.dueDate) return false;
  const due = new Date(note.dueDate);
  return (
    due.getFullYear() === now.getFullYear() &&
    due.getMonth() === now.getMonth() &&
    due.getDate() === now.getDate()
  );
}

/**
 * Splits a space's notes into what is due today and everything else.
 *
 * Today's reminders are REMOVED from the main list rather than copied into a
 * second section. Showing them twice would leave them both grouped and
 * scattered, which is the thing the grouping is meant to fix.
 *
 * Within Today the order is plain chronological by due time, with completed
 * items sunk to the bottom — it is a worklist for the next few hours, so the
 * next thing due should be the next thing read. `rest` keeps sortNotes' usual
 * order, which puts anything still outstanding and overdue at the very top.
 */
export function splitToday(
  list: Note[],
  now: Date = new Date()
): { today: Note[]; rest: Note[] } {
  const today: Note[] = [];
  const rest: Note[] = [];
  for (const note of list) (isDueToday(note, now) ? today : rest).push(note);

  today.sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    return (a.dueDate ?? '').localeCompare(b.dueDate ?? '');
  });

  return { today, rest: sortNotes(rest) };
}

