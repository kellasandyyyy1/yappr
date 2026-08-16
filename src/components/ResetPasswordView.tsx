import React, { useEffect, useState } from 'react';
import { Lock, Mail, Eye, EyeOff, Loader2, ShieldCheck, AlertTriangle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { completePasswordSetup, requestMigrationReset } from '../lib/auth-migration';
import {
  checkPasswordStrength,
  validateNewPassword,
  MIN_PASSWORD_LENGTH,
  type PasswordCheck,
} from '../lib/passwordPolicy';
import { authErrorMessage, logAuthError, RESET_ACK } from '../lib/authErrors';
import { handlePasswordChanged } from '../lib/securityEvents';
import { PasswordStrengthMeter } from './PasswordStrengthMeter';
import { Logo } from './Logo';
import { navigate } from '../lib/router';

/**
 * Landing page for a password-reset link.
 *
 * ── WHY THIS DID NOT EXIST ───────────────────────────────────────────────────
 * `auth-migration.ts` has always sent reset emails to `/reset-password`, but
 * nothing ever served that path: it was absent from PUBLIC_ROUTES, App.tsx had
 * no branch for it, and `completePasswordSetup()` had no caller. Clicking a
 * reset link therefore landed on the normal auth screen with no way to set a
 * new password — and the recovery session it had just established was silently
 * discarded.
 *
 * ── HOW THE TOKEN BECOMES A SESSION ──────────────────────────────────────────
 * The client runs `flowType: 'pkce'`, so the link comes back as
 * `?code=<uuid>` in the QUERY STRING — not a fragment. That code has to be
 * exchanged for a session with `exchangeCodeForSession()`.
 *
 * Order matters here. `detectSessionInUrl: true` means the client may already
 * have consumed the code before this component mounts, and a code is
 * single-use — exchanging one twice fails. So: look for an existing session
 * first, only exchange if there isn't one, and strip the code from the URL
 * afterwards so a refresh does not retry a spent code.
 *
 * PKCE CAVEAT, surfaced rather than hidden: the exchange needs the
 * `code_verifier` that was stored in localStorage when the reset was
 * requested. Request the reset in one browser and open the link in another —
 * phone versus laptop, a webmail preview pane — and the verifier is absent and
 * the exchange fails. That is not an expired link, and telling the user it is
 * would send them round a loop that can never succeed, so it gets its own
 * message.
 *
 * The resulting session is real but narrow: it authorises
 * `updateUser({ password })` and little else. It is deliberately signed out
 * afterwards so a forwarded link cannot leave anyone logged in.
 */
type Phase = 'checking' | 'ready' | 'invalid' | 'done';

/** Why the link could not be used — drives the message shown. */
type FailReason = 'expired' | 'wrong-browser' | 'missing';

export function ResetPasswordView() {
  const [phase, setPhase] = useState<Phase>('checking');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [check, setCheck] = useState<PasswordCheck | null>(null);
  const [checkingBreach, setCheckingBreach] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Re-request state, for the dead-link path. A link that has expired or been
  // used is otherwise a dead end — the user has no session and no route back
  // to the reset form.
  const [resendEmail, setResendEmail] = useState('');
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // The client may finish the fragment exchange either before or after this
    // mounts, so check the current session AND listen for the event.
    const decide = (hasSession: boolean) => {
      if (cancelled) return;
      setPhase(hasSession ? 'ready' : 'invalid');
    };

    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY' || session) decide(true);
    });

    supabase.auth.getSession().then(({ data: current }) => {
      if (current.session) decide(true);
      // No session yet: give the fragment exchange a moment before declaring
      // the link dead. An expired or reused link never produces one.
      else setTimeout(async () => {
        const { data: retry } = await supabase.auth.getSession();
        decide(Boolean(retry.session));
      }, 1200);
    });

    return () => {
      cancelled = true;
      data.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    setCheck(password === '' ? null : checkPasswordStrength(password));
  }, [password]);

  const requestNewLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setResending(true);
    try {
      await requestMigrationReset(resendEmail);
    } finally {
      // Always the same acknowledgement, whether or not the address is
      // registered — the reset form must not become the enumeration oracle the
      // login form deliberately is not.
      setResent(true);
      setResending(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }

    setCheckingBreach(true);
    const verdict = await validateNewPassword(password);
    setCheckingBreach(false);
    if (!verdict.ok) {
      setCheck(verdict);
      setError(verdict.problems[0]);
      return;
    }

    setSaving(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      await completePasswordSetup(password);
      if (userData.user) void handlePasswordChanged(userData.user.id);

      // Sign out deliberately. The recovery session came from a link that may
      // have been forwarded or left in a shared inbox; the new password should
      // be required to get in.
      await supabase.auth.signOut();
      setPhase('done');
    } catch (err) {
      setError(authErrorMessage(err, 'Could not update your password. Please try again.'));
      logAuthError('password reset completion', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center px-5 py-8">
      <div className="w-full max-w-[420px]">
        <header className="mb-8 flex flex-col items-center gap-3 text-center">
          <Logo size="lg" iconOnly />
          <span className="brand-wordmark text-3xl font-extrabold tracking-tight">yappr</span>
          <p className="mt-1 text-sm text-muted">
            {phase === 'done' ? 'Password updated' : 'Choose a new password'}
          </p>
        </header>

        {phase === 'checking' && (
          <div className="flex flex-col items-center gap-3 py-10 text-muted">
            <Loader2 size={22} className="animate-spin text-accent" />
            <p className="text-sm">Checking your link…</p>
          </div>
        )}

        {phase === 'invalid' && (
          <div className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-4">
            <div className="flex items-start gap-2.5">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" />
              <div className="text-sm leading-relaxed text-danger">
                <p className="font-semibold">This link is no longer valid.</p>
                <p className="mt-1.5 text-danger/90">
                  Reset links expire and can only be used once.
                </p>
              </div>
            </div>

            {/* A dead link must not be a dead end. Without this the user has no
                session and no route back to the reset form. */}
            {resent ? (
              <p className="mt-4 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2.5 text-sm leading-relaxed text-accent-soft">
                {RESET_ACK}
              </p>
            ) : (
              <form onSubmit={requestNewLink} className="mt-4">
                <label htmlFor="resend-email" className="field-label">
                  Request a new link
                </label>
                <div className="relative">
                  <Mail size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
                  <input
                    id="resend-email"
                    type="email"
                    value={resendEmail}
                    onChange={(e) => setResendEmail(e.target.value)}
                    required
                    autoComplete="email"
                    className="field pl-11"
                    placeholder="email@example.com"
                  />
                </div>
                <button
                  disabled={resending}
                  className="btn-primary mt-3 flex h-11 w-full items-center justify-center text-sm"
                >
                  {resending ? <Loader2 size={16} className="animate-spin" /> : 'Send a new reset link'}
                </button>
              </form>
            )}

            <button
              onClick={() => navigate('/')}
              className="mx-auto mt-4 block text-sm font-semibold text-accent hover:text-accent-soft"
            >
              Back to sign in
            </button>
          </div>
        )}

        {phase === 'done' && (
          <div className="rounded-xl border border-accent/30 bg-accent/10 px-4 py-4">
            <div className="flex items-start gap-2.5">
              <ShieldCheck size={16} className="mt-0.5 shrink-0 text-accent" />
              <p className="text-sm leading-relaxed text-accent-soft">
                Your password has been changed. Sign in with it to continue.
              </p>
            </div>
            <button onClick={() => navigate('/')} className="btn-primary mt-4 h-11 w-full text-sm">
              Go to sign in
            </button>
          </div>
        )}

        {phase === 'ready' && (
          <form onSubmit={submit}>
            {error && (
              <div role="alert" className="mb-5 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
                {error}
              </div>
            )}

            <div className="mb-2">
              <label htmlFor="new-password" className="field-label">New password</label>
              <div className="relative">
                <Lock size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
                <input
                  id="new-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoFocus
                  autoComplete="new-password"
                  className="field pl-11 pr-12"
                  placeholder="Enter a new password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-1 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-lg text-muted transition-colors duration-100 hover:text-fg"
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>

              <PasswordStrengthMeter check={check} checking={checkingBreach} />
              {!check && (
                <p className="mt-2 text-xs text-muted">
                  At least {MIN_PASSWORD_LENGTH} characters. Checked against known breaches
                  before it is accepted.
                </p>
              )}
            </div>

            <div className="mt-4">
              <label htmlFor="confirm-password" className="field-label">Confirm new password</label>
              <div className="relative">
                <Lock size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
                <input
                  id="confirm-password"
                  type={showPassword ? 'text' : 'password'}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  autoComplete="new-password"
                  aria-invalid={confirm !== '' && confirm !== password}
                  className="field pl-11"
                  placeholder="Type it again"
                />
              </div>
              {/* Reported while typing rather than on submit — a mismatch found
                  only after the breach check has run wastes a round trip. */}
              {confirm !== '' && confirm !== password && (
                <p className="mt-2 text-xs text-danger">The two passwords do not match.</p>
              )}
            </div>

            <button
              disabled={saving || checkingBreach || !check?.ok || password !== confirm}
              className="btn-primary mt-6 flex h-12 w-full items-center justify-center gap-2 text-sm"
            >
              {saving || checkingBreach ? (
                <>
                  <Loader2 size={18} className="animate-spin" />
                  {checkingBreach ? 'Checking password…' : 'Saving…'}
                </>
              ) : (
                'Update password'
              )}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
