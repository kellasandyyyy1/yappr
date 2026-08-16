/**
 * Password strength policy and breached-password screening.
 *
 * IMPORTANT — where hashing actually happens:
 * This app uses Supabase Auth (GoTrue). Passwords are never stored, hashed, or
 * even retained by our code; the plaintext goes straight from the input element
 * into the Supabase SDK over TLS and is discarded. GoTrue hashes it server-side
 * with bcrypt, in `auth.users`, a schema the anon and authenticated roles
 * cannot read. There is no local password store for us to protect.
 *
 * (Under Firebase this was Google's memory-hard scrypt variant. The change of
 * algorithm is why no password could be carried across — see MIGRATION.md § A1.)
 *
 * The SHA-1 below is NOT password storage. It is the wire format required by
 * HaveIBeenPwned's k-anonymity range API, which only ever receives the first
 * five hex characters of the digest.
 */

export const MIN_PASSWORD_LENGTH = 10;

/**
 * Most-guessed passwords, checked offline so the obvious cases fail instantly
 * without a network round trip. HIBP covers the long tail.
 */
const COMMON_PASSWORDS = new Set([
  '123456', '123456789', '12345678', 'password', 'qwerty', '1234567890',
  '1234567', 'password1', '123123', 'iloveyou', 'abc123', 'qwerty123',
  'admin123', 'welcome1', 'letmein', 'monkey123', 'dragon123', 'sunshine',
  'princess', 'football', 'baseball', 'trustno1', 'passw0rd', 'password123',
  'qwertyuiop', 'superman', 'whatever', 'starwars', 'computer', 'michael1',
  'zaq12wsx', 'qazwsxedc', 'asdfghjkl', '1q2w3e4r', '1qaz2wsx', 'q1w2e3r4',
  'welcome123', 'admin1234', 'changeme', 'secret123', 'default1', 'pass1234',
  // Brand-derived guesses. `privy123` is NOT renamed to `yappr123` — it is a
  // blocklist entry, not branding. The old name stays guessable for exactly as
  // long as anyone remembers it, so the rebrand adds an entry rather than
  // moving one.
  'privy123', 'yappr123', 'yappr1234', 'letmein123', 'iloveyou1', 'test1234',
]);

export interface PasswordCheck {
  /** True when the password may be used. */
  ok: boolean;
  /** 0–4, for the strength meter. */
  score: number;
  /** Ordered, user-facing reasons it was rejected. */
  problems: string[];
  /** Set when HIBP confirmed the password appears in a breach corpus. */
  breachCount?: number;
}

/** Structural checks. Runs offline, synchronously, on every keystroke. */
export function checkPasswordStrength(
  password: string,
  context: { email?: string; username?: string } = {}
): PasswordCheck {
  const problems: string[] = [];

  if (password.length < MIN_PASSWORD_LENGTH) {
    problems.push(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > 128) {
    problems.push('Use 128 characters or fewer.');
  }

  const lower = password.toLowerCase();

  if (COMMON_PASSWORDS.has(lower)) {
    problems.push('This is one of the most commonly used passwords.');
  }

  // A password containing the account identifier is trivially guessable.
  const emailLocal = context.email?.split('@')[0]?.toLowerCase();
  if (emailLocal && emailLocal.length >= 3 && lower.includes(emailLocal)) {
    problems.push("Don't include your email address.");
  }
  if (context.username && context.username.length >= 3 && lower.includes(context.username.toLowerCase())) {
    problems.push("Don't include your username.");
  }

  if (/^(.)\1+$/.test(password)) {
    problems.push('Not just one repeated character.');
  }
  if (/^(?:0123456789|1234567890|abcdefghij|qwertyuiop)/.test(lower)) {
    problems.push('Not a straight run of keyboard or number order.');
  }

  // Variety score — informational, not a hard gate. Length matters far more
  // than symbol soup, so length is weighted heaviest.
  let score = 0;
  if (password.length >= MIN_PASSWORD_LENGTH) score++;
  if (password.length >= 14) score++;
  if (password.length >= 20) score++;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes >= 3) score++;
  if (problems.length > 0) score = Math.min(score, 1);

  return { ok: problems.length === 0, score: Math.min(score, 4), problems };
}

/**
 * Screens the password against HaveIBeenPwned using k-anonymity.
 *
 * Only the first 5 characters of the SHA-1 digest ever leave the browser.
 * HIBP returns every suffix sharing that prefix (~500–1000 hashes) and the
 * comparison happens locally, so the service never learns the password or
 * even the full hash.
 *
 * Fails open: if the API is unreachable, we do not block the user. A breach
 * check that hard-fails on network trouble turns an outage into a lockout.
 */
export async function checkPasswordBreached(
  password: string,
  signal?: AbortSignal
): Promise<{ breached: boolean; count: number; checked: boolean }> {
  try {
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(password));
    const hash = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();

    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);

    const response = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      signal,
      headers: { 'Add-Padding': 'true' }, // pads the response so its size leaks nothing
    });
    if (!response.ok) return { breached: false, count: 0, checked: false };

    const body = await response.text();
    for (const line of body.split('\n')) {
      const [candidate, countText] = line.trim().split(':');
      if (candidate === suffix) {
        const count = Number.parseInt(countText, 10) || 1;
        // Padding entries are returned with a count of 0.
        if (count > 0) return { breached: true, count, checked: true };
      }
    }
    return { breached: false, count: 0, checked: true };
  } catch {
    return { breached: false, count: 0, checked: false };
  }
}

/** Full gate used before account creation and password change. */
export async function validateNewPassword(
  password: string,
  context: { email?: string; username?: string } = {}
): Promise<PasswordCheck> {
  const structural = checkPasswordStrength(password, context);
  if (!structural.ok) return structural;

  const breach = await checkPasswordBreached(password);
  if (breach.breached) {
    return {
      ok: false,
      score: 0,
      breachCount: breach.count,
      problems: [
        `This password has appeared in ${breach.count.toLocaleString()} known data breaches. Choose a different one.`,
      ],
    };
  }

  return structural;
}
