/**
 * Email normalisation and validation.
 *
 * Normalising before lookup prevents "Bob@Example.com" and "bob@example.com"
 * being treated as different identities — which otherwise allows duplicate
 * accounts and lets a rate limiter keyed on the raw string be trivially
 * bypassed by varying capitalisation.
 */

/**
 * Practical RFC 5322 subset. Deliberately not the full grammar: the exhaustive
 * regex is unmaintainable and still can't tell you an address is deliverable.
 * Real verification is the confirmation email.
 */
const EMAIL_PATTERN =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

/**
 * Lowercases and trims. The local part is case-sensitive per RFC, but every
 * mainstream provider treats it case-insensitively and Firebase stores
 * addresses lowercased — matching that avoids duplicate identities.
 *
 * Note we do NOT strip dots or +tags. Doing so would merge addresses that
 * some providers treat as distinct, letting one person silently take over
 * another's account on a non-Gmail host.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  const normalized = normalizeEmail(email);
  if (normalized.length === 0 || normalized.length > 254) return false;
  const [local] = normalized.split('@');
  if (!local || local.length > 64) return false;
  return EMAIL_PATTERN.test(normalized);
}

/** Normalises and validates in one step, for form submit handlers. */
export function parseEmail(email: string): { ok: boolean; value: string } {
  const value = normalizeEmail(email);
  return { ok: isValidEmail(value), value };
}
