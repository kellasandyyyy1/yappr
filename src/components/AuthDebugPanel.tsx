import React from 'react';
import { AlertTriangle, X } from 'lucide-react';
import type { AuthDiagnostics } from '../lib/authErrors';

/**
 * Dev-only readout of the last auth failure.
 *
 * The user-facing message is intentionally vague — collapsing "wrong password"
 * and "no such account" into one string is what stops the login form being a
 * user-enumeration oracle, and that must not change. The cost is that a
 * genuine misconfiguration looks exactly like a typo'd password. This panel
 * pays that cost back, in dev only.
 *
 * Gated on `import.meta.env.DEV`, so Vite removes the whole component from a
 * production build rather than shipping a panel that leaks which addresses are
 * registered.
 */
export function AuthDebugPanel({
  diagnostics,
  onDismiss,
}: {
  diagnostics: AuthDiagnostics | null;
  onDismiss: () => void;
}) {
  if (!import.meta.env.DEV || !diagnostics) return null;

  const KIND_LABEL: Record<AuthDiagnostics['kind'], string> = {
    blocked: 'Request never reached the server',
    credentials: 'Server rejected the credentials',
    unverified: 'Password accepted — email not confirmed',
    authorization: 'Permission denied after authenticating',
    'rate-limit': 'Rate limited',
    server: 'Server error',
    unknown: 'Unclassified',
  };

  return (
    <div
      role="status"
      className="mb-5 rounded-xl border border-danger/40 bg-danger/5 text-left"
    >
      <div className="flex items-start gap-2 border-b border-danger/20 px-4 py-2.5">
        <AlertTriangle size={15} className="mt-0.5 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-danger">
            Dev only · {KIND_LABEL[diagnostics.kind]}
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss debug details"
          className="-mr-1 -mt-0.5 flex h-6 w-6 items-center justify-center rounded text-muted transition-colors hover:text-fg"
        >
          <X size={14} />
        </button>
      </div>

      <dl className="space-y-1.5 px-4 py-3 text-xs">
        {([
          ['where', diagnostics.context],
          ['code', diagnostics.code],
          ['status', diagnostics.status === null ? '(none)' : String(diagnostics.status)],
          ['message', diagnostics.message],
          ['shown to user', diagnostics.shownToUser],
        ] as const).map(([label, value]) => (
          <div key={label} className="flex gap-2">
            <dt className="w-24 shrink-0 text-muted">{label}</dt>
            <dd className="min-w-0 flex-1 font-mono text-[11px] leading-relaxed text-fg [overflow-wrap:anywhere]">
              {value}
            </dd>
          </div>
        ))}
      </dl>

      {diagnostics.hint && (
        <p className="border-t border-danger/20 px-4 py-2.5 text-xs leading-relaxed text-muted">
          {diagnostics.hint}
        </p>
      )}
    </div>
  );
}
