import React from 'react';
import { Check, AlertCircle } from 'lucide-react';
import { cn } from '../lib/utils';
import type { PasswordCheck } from '../lib/passwordPolicy';

/**
 * Strength feedback for password creation.
 *
 * Shows what is actually wrong rather than a bare colour bar, because "weak"
 * with no explanation just makes people append "1!" to the same password.
 */

const LABELS = ['Too weak', 'Weak', 'Okay', 'Strong', 'Very strong'];

export function PasswordStrengthMeter({
  check,
  checking,
}: {
  check: PasswordCheck | null;
  checking?: boolean;
}) {
  if (!check) return null;

  return (
    <div className="mt-2.5" aria-live="polite">
      <div className="flex items-center gap-2">
        <div className="flex h-1.5 flex-1 gap-1" role="presentation">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className={cn(
                'h-full flex-1 rounded-full transition-colors duration-150',
                i < check.score
                  ? check.score <= 1
                    ? 'bg-danger'
                    : check.score === 2
                      ? 'bg-amber-500'
                      : 'bg-accent'
                  : 'bg-surface-3'
              )}
            />
          ))}
        </div>
        <span
          className={cn(
            'shrink-0 text-xs font-medium',
            check.score <= 1 ? 'text-danger' : check.score === 2 ? 'text-amber-400' : 'text-accent'
          )}
        >
          {checking ? 'Checking…' : LABELS[check.score]}
        </span>
      </div>

      {check.problems.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {check.problems.map((problem) => (
            <li key={problem} className="flex items-start gap-1.5 text-xs leading-relaxed text-muted">
              <AlertCircle size={13} className="mt-0.5 shrink-0 text-danger" />
              {problem}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-accent">
          <Check size={13} />
          Not found in any known breach.
        </p>
      )}
    </div>
  );
}
