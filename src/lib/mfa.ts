/**
 * TOTP two-factor authentication (Google Authenticator / 1Password / Authy).
 *
 * Built on Supabase's native MFA rather than a hand-rolled TOTP
 * implementation, so the shared secret lives in GoTrue and never in our code,
 * and the second factor is reflected in the session's `aal` claim — which RLS
 * can check — instead of being a screen the UI decides to show.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * IMPORTANT BEHAVIOURAL DIFFERENCE FROM THE FIREBASE VERSION
 * ────────────────────────────────────────────────────────────────────────────
 * Firebase *rejected* `signInWithEmailAndPassword` with
 * `auth/multi-factor-auth-required` when a second factor was enrolled: no
 * session existed until the code was entered.
 *
 * Supabase does not work that way. The password step succeeds and produces a
 * real session at assurance level `aal1`; entering the TOTP code upgrades it to
 * `aal2`. So a user who closes the tab at the 2FA prompt is still holding a
 * valid session.
 *
 * Two things close that gap, and BOTH are required:
 *   1. `abandonTotpChallenge()` below signs the half-authenticated session out
 *      whenever the user backs out of the prompt. (Client-side, best effort.)
 *   2. `supabase/migrations/0006_require_aal2.sql` makes every RLS policy
 *      reject an `aal1` token when the account has a verified factor. That is
 *      the part that actually enforces it — without it, an attacker who has the
 *      password can simply skip the prompt and use the aal1 session directly.
 *
 * Do not treat 2FA as enforced until 0006 has been applied.
 */

import { supabase } from './supabase';
import { recordSecurityEvent } from './securityEvents';

/** Supabase MFA is always available on the client; no console flag gates it. */
export function isMfaAvailable(): boolean {
  return typeof supabase.auth.mfa?.enroll === 'function';
}

/** Verified factors on the signed-in account. Unverified enrolments — started
 *  but never confirmed — are filtered out; they do not protect anything. */
export async function enrolledFactors() {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) throw error;
  return (data?.totp ?? []).filter((f) => f.status === 'verified');
}

export async function hasTotpEnrolled(): Promise<boolean> {
  try {
    return (await enrolledFactors()).length > 0;
  } catch {
    return false;
  }
}

export interface TotpEnrollment {
  /** Hand to `finishTotpEnrollment` once the user has entered a code. */
  factorId: string;
  /** Render as a QR code for the authenticator app. */
  qrCodeUrl: string;
  /** Show as text for manual entry when a camera isn't available. */
  sharedSecretKey: string;
}

/**
 * Step 1 — create an unverified factor and return its provisioning details.
 *
 * The factor exists in `auth.mfa_factors` with status `unverified` from this
 * point. It grants nothing until step 2, but an abandoned enrolment leaves a
 * row behind, so `finishTotpEnrollment` failing should be followed by
 * `unenrollTotp(factorId)` rather than a silent retry — a second `enroll` with
 * the same friendly name is rejected as a duplicate.
 */
export async function beginTotpEnrollment(accountLabel: string): Promise<TotpEnrollment> {
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: accountLabel,
  });
  if (error) throw error;

  return {
    factorId: data.id,
    qrCodeUrl: data.totp.uri,
    sharedSecretKey: data.totp.secret,
  };
}

/**
 * Step 2 — confirm the user's authenticator produces the right code, then
 * mark the factor verified. A wrong code rejects and the factor stays
 * unverified.
 */
export async function finishTotpEnrollment(
  userId: string,
  factorId: string,
  verificationCode: string
): Promise<void> {
  const { error } = await supabase.auth.mfa.challengeAndVerify({
    factorId,
    code: verificationCode.trim(),
  });
  if (error) throw error;
  await recordSecurityEvent(userId, 'mfa_enrolled');
}

/** Removes an enrolled factor. */
export async function unenrollTotp(userId: string, factorId?: string): Promise<void> {
  const id = factorId ?? (await enrolledFactors())[0]?.id;
  if (!id) return;
  const { error } = await supabase.auth.mfa.unenroll({ factorId: id });
  if (error) throw error;
  await recordSecurityEvent(userId, 'mfa_removed');
}

/**
 * Sign-in side. Call immediately after the password step succeeds.
 *
 * Returns the factor that still needs a code, or null when the session is
 * already at the assurance level the account requires.
 */
export async function pendingTotpChallenge(): Promise<{ factorId: string } | null> {
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error) return null;
  if (data.nextLevel !== 'aal2' || data.currentLevel === 'aal2') return null;

  const factors = await enrolledFactors();
  if (factors.length === 0) return null;
  return { factorId: factors[0].id };
}

/** Completes a sign-in that was interrupted by the second-factor challenge. */
export async function resolveTotpChallenge(factorId: string, verificationCode: string) {
  const { data, error } = await supabase.auth.mfa.challengeAndVerify({
    factorId,
    code: verificationCode.trim(),
  });
  if (error) throw error;
  return data;
}

/**
 * Discards the half-authenticated session when the user backs out of the
 * prompt. Firebase needed no equivalent — there was no session to discard.
 */
export async function abandonTotpChallenge(): Promise<void> {
  await supabase.auth.signOut();
}
