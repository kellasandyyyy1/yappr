/**
 * Auth error handling.
 *
 * Two jobs:
 *  1. Collapse the auth provider's specific failures into generic messages so
 *     an attacker can't use the login or reset form to discover which email
 *     addresses have accounts (user enumeration).
 *  2. Guarantee no credential material ever reaches a log sink.
 *
 * Previously the UI rendered `err.message` verbatim, which distinguishes
 * "user not found" from "wrong password" — a working oracle for enumerating
 * registered addresses.
 *
 * ── PORTING NOTE ─────────────────────────────────────────────────────────────
 * The Firebase `auth/*` codes are kept alongside the Supabase ones rather than
 * replaced. `isCredentialFailure()` is what drives `recordFailure()`, and
 * therefore the lockout and the CAPTCHA gate. Had this module only learned the
 * new codes at the same moment the call sites started producing them, every
 * failed sign-in would have been classified as "not a credential failure" — no
 * attempt counted, no lockout, no CAPTCHA, and nothing visibly broken to say
 * so. Recognising both vocabularies costs nothing and removes the window.
 */

/** The single response for every credential failure, whatever the cause. */
const GENERIC_CREDENTIALS = 'Invalid email or password.';

/**
 * Codes that must never be distinguishable from one another.
 *
 * `user_not_found` and `user_banned` belong here even though they are not
 * literally "wrong password": each one confirms that the address is
 * registered, which is the fact being protected.
 *
 * `email_not_confirmed` was here too, and has been deliberately moved to
 * SAFE_MESSAGES. Measured against the live project:
 *
 *     correct password, unconfirmed -> 400 email_not_confirmed
 *     wrong password,   unconfirmed -> 400 invalid_credentials
 *
 * GoTrue only reports "not confirmed" *after* accepting the password, so a
 * specific message reveals the account exists only to someone who already
 * holds valid credentials. That is not an enumeration oracle, and telling a
 * user their account is fine but unverified beats telling them their own
 * password is wrong.
 */
const CREDENTIAL_CODES = new Set([
  // Supabase (GoTrue)
  'invalid_credentials',
  'user_not_found',
  'user_banned',
  'email_address_invalid',
  'validation_failed',
  'bad_json',
  // Firebase
  'auth/invalid-credential',
  'auth/invalid-login-credentials',
  'auth/wrong-password',
  'auth/user-not-found',
  'auth/invalid-email',
  'auth/user-disabled',
  'auth/missing-password',
]);

/**
 * Codes that describe the *client's own* situation rather than whether an
 * account exists, so they are safe to surface specifically.
 */
const SAFE_MESSAGES: Record<string, string> = {
  // Supabase (GoTrue)
  // Reached only once the password has been accepted — see CREDENTIAL_CODES.
  email_not_confirmed:
    'Your email address has not been confirmed yet. Check your inbox for the confirmation link.',
  over_request_rate_limit:
    'Too many attempts from this device. Wait a few minutes and try again.',
  over_email_send_rate_limit:
    'Too many emails requested. Wait a few minutes and try again.',
  weak_password:
    'That password is too weak. Choose a longer one.',
  user_already_exists:
    'That email cannot be used to create an account.',
  email_exists:
    'That email cannot be used to create an account.',
  signup_disabled:
    'New accounts are not being accepted right now.',
  email_provider_disabled:
    'Email sign-in is not enabled for this app.',
  reauthentication_needed:
    'Please sign in again before making this change.',
  session_expired:
    'Your session has expired. Sign in again.',
  otp_expired:
    'This link has expired or has already been used. Request a new one.',
  mfa_verification_failed:
    'That code is not valid. Check your authenticator app and try again.',
  mfa_challenge_expired:
    'That code expired. Try again with a fresh one.',
  captcha_failed:
    'Verification failed. Try the check again.',
  same_password:
    'Choose a password you have not used here before.',

  // Firebase
  'auth/too-many-requests':
    'Too many attempts from this device. Wait a few minutes and try again.',
  'auth/network-request-failed':
    'Network error. Check your connection and try again.',
  'auth/weak-password':
    'That password is too weak. Choose a longer one.',
  'auth/email-already-in-use':
    'That email cannot be used to create an account.',
  'auth/operation-not-allowed':
    'Email sign-in is not enabled for this app.',
  'auth/requires-recent-login':
    'Please sign in again before making this change.',
  'auth/invalid-action-code':
    'This link has expired or has already been used. Request a new one.',
  'auth/expired-action-code':
    'This link has expired. Request a new one.',
  'auth/multi-factor-auth-required':
    'Enter the code from your authenticator app.',
  'auth/invalid-verification-code':
    'That code is not valid. Check your authenticator app and try again.',
};

/**
 * Message-text fallbacks, checked only when no code is present.
 *
 * Self-hosted and older GoTrue builds return an `AuthApiError` carrying a
 * message and an HTTP status but no `code`. Matching on prose is fragile, which
 * is why it is a fallback and not the primary path — but a missed classification
 * here means an uncounted login attempt, so the fragile check is better than
 * none.
 */
const CREDENTIAL_MESSAGE_PATTERNS = [
  /invalid login credentials/i,
  /email not confirmed/i,
  /invalid email or password/i,
  /email logins are disabled/i,
];

/**
 * Status-only rules, for failures that carry neither a code nor a useful
 * message. Checked after codes and message text.
 *
 * 504 is the one that matters here. GoTrue times out waiting on the
 * confirmation email — `context deadline exceeded` in the auth logs — and
 * returns a bare Gateway Timeout. It was landing on the generic fallback, so
 * the user could not tell a transient mail-transport stall from a rejected
 * password.
 *
 * The wording states that no account was created, which is verifiable: the
 * signup transaction rolls back, and `auth.users` was confirmed empty of
 * orphans after a 504.
 */
const STATUS_MESSAGES: Record<number, string> = {
  502: 'The server is temporarily unreachable. Please try again in a moment.',
  503: 'The service is temporarily unavailable. Please try again in a moment.',
  504: 'The server took too long to respond, so your account was not created. Please try again.',
};

/**
 * Message-text rules for failures GoTrue reports without a `code`.
 *
 * Both entries here were found by reproducing real failures, not by reading
 * docs — each one was landing on the generic "Something went wrong" fallback,
 * which is the least useful thing the UI can say.
 */
const MESSAGE_RULES: Array<{ test: RegExp; message: string }> = [
  {
    // 500 from the `handle_new_user` trigger. Signup writes the profile row in
    // the same transaction as the account, so a violated constraint on
    // `users` rolls the whole thing back — and GoTrue surfaces it as this one
    // opaque string with no code and no detail about which constraint failed.
    //
    // In practice it is always the username: taken (unique), or failing
    // `^[a-z0-9_]{3,30}$`. AuthView validates both before submitting, so this
    // is the backstop for a race or a rule that drifts out of sync.
    test: /database error saving new user/i,
    message:
      'That username is unavailable or contains unsupported characters. ' +
      'Use 3–30 characters: lowercase letters, numbers and underscores only.',
  },
  {
    // A malformed or rotated publishable key. Every request 401s identically,
    // which reads exactly like a server outage until you look at the body.
    test: /invalid api key/i,
    message: 'The app is misconfigured and cannot reach the server. Please contact support.',
  },
];

function codeOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string' && code) return code;
  }
  return '';
}

function messageOf(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return '';
}

/** Supabase sets `status`; 400/422 on an auth call is a rejected credential. */
function statusOf(error: unknown): number | null {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return null;
}

/**
 * Maps any auth error to a message that is safe to show a user.
 *
 * `user_already_exists` is deliberately vague. Signup inherently leaks some
 * existence information — you cannot both allow signup and hide whether an
 * address is taken — but we avoid confirming it in plain words. Turn on
 * Authentication → "Confirm email" in the Supabase dashboard to close the
 * remaining gap at the API level: with confirmation required, GoTrue returns a
 * fake success for an address that already exists.
 */
export function authErrorMessage(error: unknown, fallback = GENERIC_CREDENTIALS): string {
  const code = codeOf(error);
  if (CREDENTIAL_CODES.has(code)) return GENERIC_CREDENTIALS;
  if (code in SAFE_MESSAGES) return SAFE_MESSAGES[code];

  // Codeless failures, matched on message text. Checked before the credential
  // patterns so a specific rule always beats the generic collapse.
  const message = messageOf(error);
  const rule = MESSAGE_RULES.find((r) => r.test.test(message));
  if (rule) return rule.message;

  const status = statusOf(error);
  if (status !== null && status in STATUS_MESSAGES) return STATUS_MESSAGES[status];

  if (!code && matchesCredentialMessage(error)) return GENERIC_CREDENTIALS;
  return fallback;
}

function matchesCredentialMessage(error: unknown): boolean {
  const message = messageOf(error);
  return CREDENTIAL_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

/** True when the failure was a bad-credentials case, for throttle accounting. */
export function isCredentialFailure(error: unknown): boolean {
  const code = codeOf(error);
  if (code) return CREDENTIAL_CODES.has(code);

  // No code: fall back to the message, then to the status. A 400 or 422 from
  // an auth endpoint is a rejected credential; 429 is rate limiting and 5xx is
  // an outage, and counting either against the user would lock them out for a
  // failure that was not theirs.
  if (matchesCredentialMessage(error)) return true;
  const status = statusOf(error);
  return status === 400 || status === 422;
}

/**
 * Password reset must always report the same thing whether or not the address
 * is registered, otherwise the reset form becomes the enumeration oracle that
 * the login form no longer is.
 */
export const RESET_ACK =
  'If an account exists for that email, a reset link is on its way. Check your inbox.';

const REDACTED = '[redacted]';

/**
 * Scrubs anything credential-shaped before it can reach console/telemetry.
 * Belt and braces: we also simply never pass password state to a logger.
 */
export function redactSensitive(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/("?(?:password|newPassword|currentPassword|idToken|refreshToken|accessToken|secret|otp|totp)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,&}]+)/gi,
        `$1${REDACTED}`)
      .replace(/([?&](?:password|token|oobCode|code)=)[^&\s]+/gi, `$1${REDACTED}`);
  }

  if (Array.isArray(value)) return value.map(redactSensitive);

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = /pass|token|secret|otp|credential|cookie|authorization/i.test(key)
        ? REDACTED
        : redactSensitive(v);
    }
    return out;
  }

  return value;
}

/**
 * Everything known about a failure, for diagnosis.
 *
 * The user-facing message is deliberately vague — that is the anti-enumeration
 * design and it stays. But vagueness on screen should not mean vagueness in the
 * console: a blocked request, a rejected password and an RLS denial all
 * rendered as "Something went wrong. Please try again.", which is unactionable.
 *
 * `kind` is the field worth reading first. It separates the three cases that
 * look identical from the outside:
 *   • 'credentials'   — the server considered it and said no
 *   • 'blocked'       — the request never reached the server (CSP, offline,
 *                       DNS, CORS). `error.status` and `error.code` are both
 *                       absent, which is the signature.
 *   • 'authorization' — a Postgres/PostgREST rejection, e.g. RLS (42501). The
 *                       auth call succeeded; something after it did not.
 */
export interface AuthDiagnostics {
  context: string;
  kind: 'credentials' | 'unverified' | 'blocked' | 'authorization' | 'rate-limit' | 'server' | 'unknown';
  code: string;
  status: number | null;
  message: string;
  shownToUser: string;
  hint?: string;
}

/** A fetch that never left the browser: no HTTP status, no server error code. */
function looksBlocked(error: unknown): boolean {
  if (codeOf(error) || statusOf(error) !== null) return false;
  const message = messageOf(error);
  return /failed to fetch|networkerror|load failed|network request failed/i.test(message);
}

export function diagnoseAuthError(context: string, error: unknown): AuthDiagnostics {
  const code = codeOf(error);
  const status = statusOf(error);
  const message = String(redactSensitive(messageOf(error) || String(error)));

  let kind: AuthDiagnostics['kind'] = 'unknown';
  let hint: string | undefined;

  if (looksBlocked(error)) {
    kind = 'blocked';
    hint =
      'The request never reached Supabase. Check the CSP `connect-src` allowlist ' +
      'in server.ts, then the network tab — a CSP violation is reported there and ' +
      'in the console, not in this error object.';
  } else if (/^\d{5}$/.test(code)) {
    // Postgres SQLSTATE. 42501 is insufficient_privilege, i.e. RLS said no.
    kind = 'authorization';
    if (code === '42501') {
      hint =
        'Row level security rejected the write. If this is signup, the profile ' +
        'insert ran without a session — `users_insert_own` needs id = auth.uid().';
    }
  } else if (/database error saving new user/i.test(message)) {
    // Constraint violation inside the signup transaction — see MESSAGE_RULES.
    kind = 'authorization';
    hint =
      'The handle_new_user trigger could not insert the profile row. Almost ' +
      'always the username: already taken, or failing ^[a-z0-9_]{3,30}$. ' +
      'GoTrue gives no detail, so check public.users for a conflicting row.';
  } else if (/invalid api key/i.test(message)) {
    kind = 'blocked';
    hint =
      'VITE_SUPABASE_ANON_KEY does not match the project. Compare it against ' +
      'the publishable key in Supabase → Settings → API Keys. A stray ' +
      'character makes every request 401 with this message.';
  } else if (code === 'email_not_confirmed') {
    // The password was correct. Not a failed attempt, and deliberately not
    // counted against the lockout — a user who cannot find the confirmation
    // email should not also get locked out for trying.
    kind = 'unverified';
  } else if (isCredentialFailure(error)) {
    kind = 'credentials';
  } else if (code.includes('rate_limit') || status === 429) {
    kind = 'rate-limit';
  } else if (status === 504) {
    kind = 'server';
    hint =
      'GoTrue timed out — check auth_logs for "context deadline exceeded". On ' +
      'signup this is almost always the confirmation email: Supabase\'s built-in ' +
      'SMTP is a testing service and stalls under load. Configure a custom SMTP ' +
      'provider. No account is created; the transaction rolls back.';
  } else if (status !== null && status >= 500) {
    kind = 'server';
  }

  return {
    context,
    kind,
    code: code || '(none)',
    status,
    message,
    shownToUser: authErrorMessage(error, 'Something went wrong. Please try again.'),
    hint,
  };
}

/**
 * Console logger that cannot accidentally emit a credential.
 *
 * Returns the diagnostics so a caller can also surface them in the dev panel
 * without classifying the error a second time.
 */
export function logAuthError(context: string, error: unknown): AuthDiagnostics {
  const diagnostics = diagnoseAuthError(context, error);
  console.error(`[auth] ${context} — ${diagnostics.kind}`, {
    code: diagnostics.code,
    status: diagnostics.status,
    message: diagnostics.message,
    shownToUser: diagnostics.shownToUser,
    ...(diagnostics.hint ? { hint: diagnostics.hint } : {}),
  });
  return diagnostics;
}
