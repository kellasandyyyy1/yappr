import React from 'react';
import { cn } from '../lib/utils';

/**
 * The Yappr lockup: penguin icon plus wordmark.
 *
 * ── WHY THE WORDMARK IS HTML TEXT, NOT THE SVG ───────────────────────────────
 * `yappr-wordmark.svg` draws its letterforms with a live <text> element in
 * Poppins. A browser will not load a webfont into an `<img src="*.svg">` — SVGs
 * referenced that way are isolated documents with no access to the page's
 * fonts or stylesheets — so the wordmark would silently fall back to Segoe UI
 * or Arial, roughly 160 design units narrower than intended. That is not
 * hypothetical: rendering it detached the speech-bubble tail from the final
 * "r" and left it floating (see the note in public/favicon/yappr-logo.svg).
 *
 * Rendering the word as real text avoids the whole problem and is better
 * anyway: it is selectable, it scales with the user's font-size preference,
 * it is available to screen readers without an alt attribute, and the gradient
 * is a CSS token we can tune for contrast.
 *
 * Once the wordmark is re-exported with its text converted to outlines, this
 * can become a plain <img>. Until then this is the accurate one.
 *
 * ── CONTRAST ─────────────────────────────────────────────────────────────────
 * The brand gradient runs #4F9DFF → #123B8C. Against the app background
 * (#050507) those ends measure 7.5:1 and 2.0:1 respectively, so the tail of the
 * word falls below the 3:1 WCAG AA floor for large text. `--brand-grad-end` is
 * therefore a lightened stop rather than the raw brand value; see index.css.
 * The icon is unaffected — it carries its own light tile.
 */

type LogoSize = 'sm' | 'md' | 'lg';

const SIZES: Record<LogoSize, { icon: string; text: string; gap: string }> = {
  sm: { icon: 'h-7 w-7', text: 'text-lg', gap: 'gap-2' },
  md: { icon: 'h-9 w-9', text: 'text-xl', gap: 'gap-2.5' },
  lg: { icon: 'h-14 w-14', text: 'text-3xl', gap: 'gap-3' },
};

interface LogoProps {
  size?: LogoSize;
  /** Hides the wordmark, leaving just the icon — for the collapsed sidebar. */
  iconOnly?: boolean;
  className?: string;
}

export function Logo({ size = 'md', iconOnly = false, className }: LogoProps) {
  const s = SIZES[size];

  return (
    <span className={cn('flex items-center', s.gap, className)}>
      <img
        src="/favicon/yappr-penguins-icon.svg"
        alt=""
        aria-hidden="true"
        width={56}
        height={56}
        className={cn(s.icon, 'shrink-0 rounded-[22%]')}
        draggable={false}
      />
      {!iconOnly && (
        <span className={cn('brand-wordmark font-extrabold tracking-tight', s.text)}>
          yappr
        </span>
      )}
    </span>
  );
}
