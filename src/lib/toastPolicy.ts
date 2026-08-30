/**
 * When a toast goes away, and how many may be up at once.
 *
 * Pure, and separate from the component, so the rules can be tested directly —
 * scripts/migrate/test-toast-policy.ts. The interesting cases are the ones that
 * would regress silently: an error quietly gaining a timeout, or the cap
 * dropping the wrong end of the stack.
 */

export type ToastType = 'success' | 'error' | 'info';

export interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
}

/**
 * Routine confirmations take themselves away — "Comment posted" has either been
 * read or it hasn't, and it should not need clicking.
 *
 * Errors return null: they carry the only explanation of why something did not
 * happen, and four seconds is not enough to read one, decide what to do, and
 * act. Those wait for the dismiss button.
 */
export const autoDismissMs = (type: ToastType): number | null =>
  type === 'error' ? null : 4000;

/**
 * Because errors stay until dismissed, they can pile up. An unbounded column
 * would eventually cover the screen it is reporting on.
 */
export const MAX_VISIBLE = 4;

/**
 * Adds a toast, keeping the newest MAX_VISIBLE.
 *
 * The oldest is dropped, not the newest: the most recent message is the one
 * describing what the reader just did, so it is the one that must survive.
 */
export const appendToast = (list: ToastItem[], incoming: ToastItem): ToastItem[] =>
  [...list, incoming].slice(-MAX_VISIBLE);
