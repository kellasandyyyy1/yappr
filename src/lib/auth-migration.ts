import { supabase } from './supabase';

/**
 * Handling for accounts carried over from Firebase.
 *
 * ── THE CONSTRAINT ───────────────────────────────────────────────────────────
 * Firebase hashes passwords with a modified scrypt parameterised by a
 * project-specific signer key, salt separator, rounds and memory cost.
 * Supabase Auth (GoTrue) verifies bcrypt and argon2. There is no conversion:
 * you cannot derive one hash from the other without the plaintext password,
 * which nobody has.
 *
 * So migrated accounts exist with no password. Rather than a hard cutoff where
 * everyone is simply locked out and confused, the sign-in form detects a
 * migrated account and routes the user into a one-time reset. Their data,
 * username and user id are all preserved — only the credential changes.
 *
 * This is a genuine, unavoidable user-visible consequence. It should be
 * announced by email before cutover, not discovered at the sign-in screen.
 */

export interface MigratedAccountCheck {
  /** True when this address belongs to an account that has never set a
   *  Supabase password. */
  requiresReset: boolean;
  reason: 'migrated' | 'unknown' | 'none';
}

/**
 * Decides whether a failed sign-in was a migrated account rather than a wrong
 * password.
 *
 * Deliberately does NOT probe whether the email exists — that would rebuild
 * the user-enumeration oracle removed in src/lib/authErrors.ts. Instead it
 * infers from the error GoTrue returns for a passwordless account, and when
 * uncertain says so rather than guessing.
 */
export function classifySignInFailure(error: unknown): MigratedAccountCheck {
  const message =
    error && typeof error === 'object' && 'message' in error
      ? String((error as { message: unknown }).message).toLowerCase()
      : '';

  // GoTrue returns this for an account with no password credential set.
  if (
    message.includes('invalid login credentials') ||
    message.includes('email logins are disabled')
  ) {
    // Ambiguous by design: this is also what a genuinely wrong password
    // returns. The UI should offer the reset path without asserting the
    // account exists.
    return { requiresReset: false, reason: 'unknown' };
  }

  return { requiresReset: false, reason: 'none' };
}

/**
 * Sends the reset email. Always reports success to the caller so the form
 * cannot be used to discover which addresses are registered.
 */
export async function requestMigrationReset(email: string): Promise<void> {
  try {
    await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
      redirectTo: `${window.location.origin}/reset-password`,
    });
  } catch (err) {
    // Swallowed on purpose — see above. Logged without the address.
    console.warn('[auth] reset request failed');
  }
}

/**
 * True when the signed-in user still carries the migration flag, meaning they
 * arrived via a reset link and have not yet chosen a new password.
 */
export async function needsPasswordSetup(): Promise<boolean> {
  const { data } = await supabase.auth.getUser();
  return data.user?.user_metadata?.requires_password_reset === true;
}

/** Sets the new password and clears the migration flag in one step. */
export async function completePasswordSetup(newPassword: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({
    password: newPassword,
    data: { requires_password_reset: false, password_set_at: new Date().toISOString() },
  });
  if (error) throw error;
}
