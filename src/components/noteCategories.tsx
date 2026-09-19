import React from 'react';
import { ChefHat, Plane, Heart, Film, Gift, Stars, Notebook } from './icons';
import type { NoteCategory } from '../lib/notes';

/**
 * Everything a category changes about how a space looks and reads.
 *
 * One table rather than seven switch statements scattered across the compose
 * box, the empty state, the hub row and the picker. Adding a category should
 * be adding a row here, and the exhaustive Record type means the compiler
 * names every field still missing when a new one is added to the enum.
 *
 * ── NO COLOUR HERE ──────────────────────────────────────────────────────────
 * There are no per-category tints. Every category draws in the same neutral
 * outlined ring, everywhere it appears, and a category is told apart by its
 * GLYPH and its label — never by hue.
 *
 * That also means this file no longer needs the carve-out it used to carry
 * against index.css's "single accent, blue only" rule: nothing in these
 * screens paints a second hue at all.
 *
 * The ring's own colours are measured against the surface it sits on rather
 * than picked by eye — see the .cat-ring--outline block in index.css.
 */
export interface CategoryMeta {
  /** What the picker calls it. */
  label: string;
  /** One line under the label in the picker, saying what it is for. */
  hint: string;
  icon: typeof Notebook;
  /** Compose-box placeholder. */
  placeholder: string;
  /** Empty state, in two lines: what is missing, then what to do. */
  emptyTitle: string;
  emptyHint: string;
  /** Singular noun for the entries, used in button labels. */
  itemNoun: string;
  /**
   * Class carrying this category's hover animation, defined in index.css.
   *
   * It goes on the interactive element, not the icon — the animation is
   * triggered by that element's :hover / :focus-visible / :active, and the
   * class only supplies the keyframe name and timing as custom properties.
   */
  animClass: string;
}

export const CATEGORY_META: Record<NoteCategory, CategoryMeta> = {
  cooking: {
    label: 'Cooking',
    animClass: 'cat-cooking',
    hint: 'Recipes and shopping',
    icon: ChefHat,
    placeholder: 'Add a recipe or ingredient…',
    emptyTitle: 'No recipes yet.',
    emptyHint: 'Add the first one — anyone in this space can tick things off.',
    itemNoun: 'item',
  },
  trip: {
    label: 'Trip planning',
    animClass: 'cat-trip',
    hint: 'Places, packing and dates',
    icon: Plane,
    placeholder: 'Add a place, item, or date…',
    emptyTitle: 'Nothing planned yet.',
    emptyHint: 'Add somewhere to go, something to pack, or a date to book.',
    itemNoun: 'item',
  },
  date_ideas: {
    label: 'Date ideas',
    animClass: 'cat-date_ideas',
    hint: 'Things to do together',
    icon: Heart,
    placeholder: 'Add something to try together…',
    emptyTitle: 'No ideas yet.',
    emptyHint: 'Add the first thing you both want to do.',
    itemNoun: 'idea',
  },
  movies: {
    label: 'Movies & shows',
    animClass: 'cat-movies',
    hint: 'A watchlist you share',
    icon: Film,
    placeholder: 'Add something to watch…',
    emptyTitle: 'Nothing on the list yet.',
    emptyHint: 'Add the first one, and tick it off once you have watched it.',
    itemNoun: 'title',
  },
  gifts: {
    label: 'Gift ideas',
    animClass: 'cat-gifts',
    hint: 'Before you forget them',
    icon: Gift,
    placeholder: 'Add a gift idea…',
    emptyTitle: 'No gift ideas yet.',
    emptyHint: 'Write them down the moment they come up — they never survive the week.',
    itemNoun: 'idea',
  },
  bucket_list: {
    label: 'Bucket list',
    animClass: 'cat-bucket_list',
    hint: 'The someday list',
    icon: Stars,
    placeholder: 'Add something for someday…',
    emptyTitle: 'Nothing on the list yet.',
    emptyHint: 'Add the first thing. No deadlines unless you want them.',
    itemNoun: 'thing',
  },
  general: {
    label: 'General',
    animClass: 'cat-general',
    hint: 'Anything else',
    icon: Notebook,
    placeholder: 'Add a note…',
    emptyTitle: 'Nothing here yet.',
    emptyHint: 'Anything you add is visible to everyone in this space.',
    itemNoun: 'note',
  },
};

/**
 * Picker order. Deliberately not the enum's order and not alphabetical:
 * General last, because it is the fallback rather than the suggestion, and the
 * six specific ones first so the grid leads with the reason someone is here.
 */
export const CATEGORY_ORDER: NoteCategory[] = [
  'cooking', 'trip', 'date_ideas', 'movies', 'gifts', 'bucket_list', 'general',
];

/**
 * The category icon, in the one treatment every surface now uses: an outlined
 * neutral ring, lit from above, with no per-category colour anywhere.
 *
 * There is deliberately no tinted alternative left. Two treatments for the
 * same thing is how a component ends up with a variant nobody can remember the
 * rule for — and the previous split (neutral while choosing, coloured while
 * scanning) was a distinction only its author could see.
 *
 * `cat-ring` and `cat-icon` are always applied, but the hover keyframes are
 * inert on their own: they fire only inside an element carrying `cat-tile`,
 * which is the picker and nothing else. The ring in a list row therefore stays
 * still, which is right — motion on a row you are trying to read is
 * decoration, not a response to something you did.
 */
export function CategoryIcon({
  category,
  size,
  /** 36px for a list row, where the ring sits beside two lines of text. The
   *  44px default is for the picker, where the icon is the thing being
   *  chosen. Same stroke and shading either way. */
  compact = false,
  className,
}: {
  category: NoteCategory;
  size?: number;
  compact?: boolean;
  className?: string;
}) {
  const Icon = CATEGORY_META[category].icon;
  return (
    <span
      aria-hidden
      className={`cat-ring cat-ring--outline ${compact ? 'cat-ring--sm' : ''} flex shrink-0 items-center justify-center ${className ?? ''}`}
    >
      <Icon size={size ?? (compact ? 17 : 21)} className="cat-icon" />
    </span>
  );
}
