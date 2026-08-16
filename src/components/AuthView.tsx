import React, { useState, useEffect, useCallback } from 'react';
import { auth as authApi } from '../lib/db';
import { requestMigrationReset } from '../lib/auth-migration';
import { useToast } from './ToastContext';
import { Mail, Lock, User as UserIcon, Eye, EyeOff, Loader2, ShieldCheck, ShieldAlert, KeyRound, X } from 'lucide-react';
import { parseEmail } from '../lib/emailValidation';
import {
  checkPasswordStrength,
  validateNewPassword,
  MIN_PASSWORD_LENGTH,
  type PasswordCheck,
} from '../lib/passwordPolicy';
import {
  authErrorMessage,
  isCredentialFailure,
  logAuthError,
  RESET_ACK,
  type AuthDiagnostics,
} from '../lib/authErrors';
import { AuthDebugPanel } from './AuthDebugPanel';
import { Logo } from './Logo';
import {
  getThrottleState,
  recordFailure,
  recordSuccess,
  formatRetryAfter,
  MAX_ATTEMPTS,
} from '../lib/loginThrottle';
import { pendingTotpChallenge, resolveTotpChallenge, abandonTotpChallenge } from '../lib/mfa';
import { handlePostSignIn } from '../lib/securityEvents';
import { CaptchaGate } from './CaptchaGate';
import { PasswordStrengthMeter } from './PasswordStrengthMeter';
import { fetchLegalManifest } from '../lib/legal';
import { navigate } from '../lib/router';

interface AuthViewProps {
  onAuthSuccess: () => void;
  /** Explains an involuntary return to this screen — see App.tsx loadSession. */
  notice?: string | null;
  onDismissNotice?: () => void;
}

export function AuthView({ onAuthSuccess, notice, onDismissNotice }: AuthViewProps) {
  const [isLogin, setIsLogin] = useState(true);
  const [isForgotPassword, setIsForgotPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  // Dev-only. The on-screen message stays deliberately vague to avoid being a
  // user-enumeration oracle; this carries the detail that vagueness costs us.
  const [diagnostics, setDiagnostics] = useState<AuthDiagnostics | null>(null);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  // Abuse controls
  const [throttle, setThrottle] = useState(() => getThrottleState(''));
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);

  // Second factor. Unlike Firebase, a session already exists at this point —
  // see the header comment in lib/mfa.ts.
  const [mfaFactorId, setMfaFactorId] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');

  // Signup password quality
  const [passwordCheck, setPasswordCheck] = useState<PasswordCheck | null>(null);
  const [checkingBreach, setCheckingBreach] = useState(false);

  // Legal consent. Starts false and is never pre-checked — a pre-ticked box
  // is not consent under GDPR or any comparable regime.
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [legalVersion, setLegalVersion] = useState('');

  useEffect(() => {
    fetchLegalManifest().then((manifest) => {
      if (manifest) setLegalVersion(manifest.version);
    });
  }, []);

  const refreshThrottle = useCallback((raw: string) => {
    setThrottle(getThrottleState(parseEmail(raw).value));
  }, []);

  useEffect(() => {
    refreshThrottle(email);
  }, [email, refreshThrottle]);

  // Live structural feedback while choosing a password. The network breach
  // check is deferred to submit so we don't fire a request per keystroke.
  useEffect(() => {
    if (isLogin || isForgotPassword || password === '') {
      setPasswordCheck(null);
      return;
    }
    setPasswordCheck(checkPasswordStrength(password, { email, username }));
  }, [password, email, username, isLogin, isForgotPassword]);

  // Tick the lockout countdown so the button re-enables without a reload.
  useEffect(() => {
    if (throttle.allowed) return;
    const timer = setInterval(() => refreshThrottle(email), 1000);
    return () => clearInterval(timer);
  }, [throttle.allowed, email, refreshThrottle]);

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    const parsed = parseEmail(email);
    if (!parsed.ok) {
      setError('Enter a valid email address.');
      return;
    }

    setLoading(true);
    try {
      // requestMigrationReset swallows its own errors for the same reason —
      // reporting "no such user" here would turn the reset form into the
      // enumeration oracle the login form is not. It is also the path a
      // Firebase-era account takes to set its first Supabase password.
      await requestMigrationReset(parsed.value);
    } catch (err) {
      setDiagnostics(logAuthError('password reset', err));
    } finally {
      // Same acknowledgement either way, and the same elapsed time is not
      // guaranteed — but the response text is identical, which is what
      // matters for enumeration.
      setSuccess(RESET_ACK);
      toast('Check your inbox', 'info');
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const parsed = parseEmail(email);
    if (!parsed.ok) {
      setError('Enter a valid email address.');
      return;
    }

    // Refuse while locked out.
    const state = getThrottleState(parsed.value);
    if (!state.allowed) {
      setError(`Too many failed attempts. Try again in ${formatRetryAfter(state.retryAfterSeconds)}.`);
      setThrottle(state);
      return;
    }
    if (state.captchaRequired && !captchaToken) {
      setError('Complete the verification below to continue.');
      setThrottle(state);
      return;
    }

    setLoading(true);
    try {
      if (isLogin) {
        const { user: signedIn } = await authApi.signIn(parsed.value, password);

        // Supabase hands back a usable session before the second factor, so
        // the challenge check has to happen here rather than in the catch
        // block where Firebase's rejection used to land. Nothing is treated as
        // a completed sign-in until this returns null.
        const challenge = await pendingTotpChallenge();
        if (challenge) {
          setMfaFactorId(challenge.factorId);
          setLoading(false);
          return;
        }

        recordSuccess(parsed.value);
        if (signedIn) void handlePostSignIn(signedIn.id);
        toast('Welcome back', 'success');
      } else {
        // Consent is a hard precondition for account creation.
        if (!agreedToTerms) {
          setError('Please accept the Terms and Privacy Policy to create an account.');
          setLoading(false);
          return;
        }

        // Full policy gate — length, common list, and HIBP breach corpus.
        setCheckingBreach(true);
        const verdict = await validateNewPassword(password, { email: parsed.value, username });
        setCheckingBreach(false);
        if (!verdict.ok) {
          setPasswordCheck(verdict);
          setError(verdict.problems[0]);
          setLoading(false);
          return;
        }

        // The profile row is created by the on_auth_user_created trigger, in
        // the same transaction as the account, from this metadata. It is NOT a
        // second call from here: with email confirmation on there is no session
        // yet, so a client-side insert would be rejected by RLS and leave an
        // account with no profile — unusable and impossible to re-register.
        const { user: created, session } = await authApi.signUp(parsed.value, password, {
          username: username.toLowerCase().replace(/\s+/g, ''),
          displayName: username,
          termsVersion: legalVersion,
        });

        recordSuccess(parsed.value);

        if (!session) {
          // Account created, email unconfirmed. There is deliberately no
          // session, so stop here rather than calling onAuthSuccess() and
          // dropping the user into an app they cannot load.
          setSuccess('Account created. Check your inbox to confirm your email, then sign in.');
          setPassword('');
          setLoading(false);
          return;
        }

        if (created) void handlePostSignIn(created.id);
        toast('Account created. Welcome to Yappr.', 'success');
      }
      onAuthSuccess();
    } catch (err: unknown) {
      setCheckingBreach(false);
      setDiagnostics(logAuthError(isLogin ? 'sign in' : 'sign up', err));

      if (isCredentialFailure(err)) {
        const next = recordFailure(parsed.value);
        setThrottle(next);
        setCaptchaToken(null);
        setError(
          next.allowed
            ? authErrorMessage(err)
            : `Too many failed attempts. Try again in ${formatRetryAfter(next.retryAfterSeconds)}.`
        );
      } else {
        setError(authErrorMessage(err, 'Something went wrong. Please try again.'));
      }
    } finally {
      setLoading(false);
    }
  };

  const handleMfaSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mfaFactorId) return;
    setError('');
    setLoading(true);
    try {
      const result = await resolveTotpChallenge(mfaFactorId, mfaCode);
      recordSuccess(parseEmail(email).value);
      // Only now is this a real sign-in — the session is aal2, so the event
      // log write (and everything else under RLS) is permitted.
      if (result.user) void handlePostSignIn(result.user.id);
      setMfaFactorId(null);
      setMfaCode('');
      toast('Welcome back', 'success');
      onAuthSuccess();
    } catch (err) {
      setDiagnostics(logAuthError('mfa challenge', err));
      setError(authErrorMessage(err, 'That code is not valid. Try again.'));
    } finally {
      setLoading(false);
    }
  };

  /** Backing out of the prompt has to destroy the aal1 session; Firebase had
   *  no session to destroy at this point, so this is new. */
  const cancelMfa = async () => {
    setMfaFactorId(null);
    setMfaCode('');
    setError('');
    setPassword('');
    await abandonTotpChallenge();
  };

  const switchMode = () => {
    setIsLogin(!isLogin);
    setError('');
    setSuccess('');
    setPassword('');
    setPasswordCheck(null);
  };

  const signupBlocked =
    !isLogin && (!passwordCheck?.ok || !username.trim() || !agreedToTerms);
  const submitDisabled =
    loading || checkingBreach || !throttle.allowed || signupBlocked ||
    (throttle.captchaRequired && !captchaToken);

  return (
    // Centred single screen: the form sits above the fold at every size, so
    // there is nothing to scroll past to reach the Sign In button.
    <div className="flex min-h-[100dvh] flex-col items-center justify-center px-5 py-8">
      <div className="w-full max-w-[420px]">
        {/* Compact header — a mark, a name, one line of context. Previously a
            generic lucide chat glyph; now the actual brand icon. */}
        <header className="mb-8 text-center">
          <h1 className="flex flex-col items-center gap-3">
            <Logo size="lg" iconOnly />
            <span className="brand-wordmark text-3xl font-extrabold tracking-tight">yappr</span>
          </h1>
          <p className="mt-1.5 text-sm text-muted">
            {mfaFactorId
              ? 'Two-factor verification'
              : isForgotPassword
                ? 'Reset your password'
                : isLogin
                  ? 'Sign in to your account'
                  : 'Create your account'}
          </p>
        </header>

        {/* Shown when the app sent the user back here rather than the user
            failing to sign in. Sits above `error` because it explains the
            state they arrived in, not something they just did. */}
        {notice && (
          <div
            role="alert"
            className="mb-5 flex items-start gap-2.5 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3"
          >
            <ShieldAlert size={16} className="mt-0.5 shrink-0 text-danger" />
            <p className="flex-1 text-sm leading-relaxed text-danger">{notice}</p>
            {onDismissNotice && (
              <button
                type="button"
                onClick={onDismissNotice}
                aria-label="Dismiss"
                className="-mr-1 -mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded text-danger/70 transition-colors hover:text-danger"
              >
                <X size={14} />
              </button>
            )}
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="mb-5 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger"
          >
            {error}
          </div>
        )}

        {success && (
          <div
            role="status"
            className="mb-5 rounded-xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-accent-soft"
          >
            {success}
          </div>
        )}

        {/* Compiled out of production builds — see the component. */}
        <AuthDebugPanel diagnostics={diagnostics} onDismiss={() => setDiagnostics(null)} />

        {mfaFactorId ? (
          /* Second factor. Reached only when the account has a verified TOTP
             factor. The password has been accepted and an aal1 session exists;
             it is worthless until this form upgrades it to aal2. */
          <form onSubmit={handleMfaSubmit}>
            <div className="mb-5 flex items-start gap-2 rounded-xl border border-line bg-surface-2 px-4 py-3">
              <ShieldCheck size={16} className="mt-0.5 shrink-0 text-accent" />
              <p className="text-sm leading-relaxed text-muted">
                Enter the 6-digit code from your authenticator app.
              </p>
            </div>

            <div className="mb-5">
              <label htmlFor="mfa-code" className="field-label">
                Verification code
              </label>
              <div className="relative">
                <KeyRound
                  size={18}
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"
                />
                <input
                  id="mfa-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))}
                  required
                  autoFocus
                  className="field pl-11 tracking-[0.3em]"
                  placeholder="000000"
                />
              </div>
            </div>

            <button
              disabled={loading || mfaCode.length < 6}
              className="btn-primary flex h-12 w-full items-center justify-center text-sm"
            >
              {loading ? <Loader2 size={18} className="animate-spin" /> : 'Verify'}
            </button>

            <button
              type="button"
              onClick={cancelMfa}
              className="mx-auto mt-6 block text-sm font-semibold text-accent hover:text-accent-soft"
            >
              Cancel
            </button>
          </form>
        ) : isForgotPassword ? (
          <form onSubmit={handleResetPassword}>
            <div className="mb-5">
              <label htmlFor="reset-email" className="field-label">
                Registration email
              </label>
              <div className="relative">
                <Mail
                  size={18}
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"
                />
                <input
                  id="reset-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  className="field pl-11"
                  placeholder="email@example.com"
                />
              </div>
            </div>

            <button
              disabled={loading}
              className="btn-primary flex h-12 w-full items-center justify-center text-sm"
            >
              {loading ? <Loader2 size={18} className="animate-spin" /> : 'Send reset link'}
            </button>

            <button
              type="button"
              onClick={() => setIsForgotPassword(false)}
              className="mx-auto mt-6 block text-sm font-semibold text-accent hover:text-accent-soft"
            >
              Back to sign in
            </button>
          </form>
        ) : (
          <form onSubmit={handleSubmit}>
            {!isLogin && (
              <div className="mb-5">
                <label htmlFor="auth-username" className="field-label">
                  Username
                </label>
                <div className="relative">
                  <UserIcon
                    size={18}
                    className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"
                  />
                  <input
                    id="auth-username"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                    autoComplete="username"
                    className="field pl-11"
                    placeholder="Your name"
                  />
                </div>
              </div>
            )}

            <div className="mb-5">
              <label htmlFor="auth-email" className="field-label">
                Email
              </label>
              <div className="relative">
                <Mail
                  size={18}
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"
                />
                <input
                  id="auth-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  className="field pl-11"
                  placeholder="email@example.com"
                />
              </div>
            </div>

            {/* Password block sits directly above the submit button — no
                spacer, no mt-auto, no gap to scroll past. */}
            <div className="mb-2">
              <div className="flex items-baseline justify-between">
                <label htmlFor="auth-password" className="field-label">
                  Password
                </label>
                {isLogin && (
                  <button
                    type="button"
                    onClick={() => {
                      setIsForgotPassword(true);
                      setError('');
                      setSuccess('');
                    }}
                    className="mb-2 text-xs font-semibold text-accent hover:text-accent-soft"
                  >
                    Forgot password?
                  </button>
                )}
              </div>
              <div className="relative">
                <Lock
                  size={18}
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"
                />
                <input
                  id="auth-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete={isLogin ? 'current-password' : 'new-password'}
                  className="field pl-11 pr-12"
                  placeholder="Enter your password"
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

              {!isLogin && (
                <>
                  <PasswordStrengthMeter check={passwordCheck} checking={checkingBreach} />
                  {!passwordCheck && (
                    <p className="mt-2 text-xs text-muted">
                      At least {MIN_PASSWORD_LENGTH} characters. Checked against known
                      breaches before your account is created.
                    </p>
                  )}
                </>
              )}
            </div>

            {/* Warn before the lockout, not only after it. */}
            {isLogin && throttle.allowed && throttle.attempts > 0 && throttle.remaining <= 2 && (
              <p className="mt-4 text-sm text-danger" role="status">
                {throttle.remaining} attempt{throttle.remaining === 1 ? '' : 's'} left before
                this account is temporarily locked.
              </p>
            )}

            {isLogin && throttle.captchaRequired && (
              <div className="mt-4">
                <CaptchaGate
                  verified={!!captchaToken}
                  onVerified={setCaptchaToken}
                  onReset={() => setCaptchaToken(null)}
                />
              </div>
            )}

            {/* Explicit, unticked consent. Required before account creation. */}
            {!isLogin && (
              <label className="mt-5 flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={agreedToTerms}
                  onChange={(e) => setAgreedToTerms(e.target.checked)}
                  aria-describedby="terms-consent-text"
                  className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer accent-[#3b82f6]"
                />
                <span id="terms-consent-text" className="text-sm leading-relaxed text-muted">
                  I agree to the{' '}
                  <button
                    type="button"
                    onClick={() => navigate('/terms-of-conditions')}
                    className="font-semibold text-accent underline underline-offset-2 hover:text-accent-soft"
                  >
                    Terms of Conditions
                  </button>{' '}
                  and{' '}
                  <button
                    type="button"
                    onClick={() => navigate('/privacy-policy')}
                    className="font-semibold text-accent underline underline-offset-2 hover:text-accent-soft"
                  >
                    Privacy Policy
                  </button>
                  .
                </span>
              </label>
            )}

            <button
              disabled={submitDisabled}
              className="btn-primary mt-6 flex h-12 w-full items-center justify-center gap-2 text-sm"
            >
              {loading || checkingBreach ? (
                <>
                  <Loader2 size={18} className="animate-spin" />
                  {checkingBreach ? 'Checking password…' : null}
                </>
              ) : !throttle.allowed ? (
                `Locked — retry in ${formatRetryAfter(throttle.retryAfterSeconds)}`
              ) : isLogin ? (
                'Sign in'
              ) : (
                'Create account'
              )}
            </button>

            <p className="mt-6 text-center text-sm text-muted">
              {isLogin ? "Don't have an account? " : 'Already registered? '}
              <button
                type="button"
                onClick={switchMode}
                className="font-semibold text-accent hover:text-accent-soft"
              >
                {isLogin ? 'Sign up' : 'Sign in'}
              </button>
            </p>
          </form>
        )}

        {/* Always reachable, including on the sign-in tab, so the documents
            are available without creating an account. */}
        <p className="mt-8 text-center text-xs leading-relaxed text-muted">
          {isLogin ? 'By using Yappr you agree to our ' : 'By signing up you agree to our '}
          <button
            type="button"
            onClick={() => navigate('/terms-of-conditions')}
            className="font-medium text-accent underline underline-offset-2 hover:text-accent-soft"
          >
            Terms
          </button>{' '}
          and{' '}
          <button
            type="button"
            onClick={() => navigate('/privacy-policy')}
            className="font-medium text-accent underline underline-offset-2 hover:text-accent-soft"
          >
            Privacy Policy
          </button>
          .
        </p>

        <p className="mt-6 text-center text-sm text-muted">
          Developed by{' '}
          <a
            href="https://kellasandrei.netlify.app"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-accent transition-colors duration-100 hover:text-accent-soft hover:underline"
          >
            andrei
          </a>
        </p>
      </div>
    </div>
  );
}
