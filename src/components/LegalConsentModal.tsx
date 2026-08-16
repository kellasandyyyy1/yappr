import React, { useState } from 'react';
import { FileText, Loader2, AlertTriangle } from 'lucide-react';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { recordConsent, formatLegalDate } from '../lib/legal';
import { navigate } from '../lib/router';
import { useToast } from './ToastContext';

/**
 * Shown when the accepted terms version no longer matches the current one.
 *
 * Deliberately has no dismiss control and no backdrop close: the point is a
 * recorded decision, and a modal you can click away from records nothing. The
 * only ways out are accepting or signing out, both of which are explicit.
 *
 * The checkbox starts unchecked. Pre-checking a consent box is not consent.
 */

interface LegalConsentModalProps {
  uid: string;
  version: string;
  lastUpdated: string;
  onAccepted: () => void;
  onDecline: () => void;
}

export function LegalConsentModal({
  uid,
  version,
  lastUpdated,
  onAccepted,
  onDecline,
}: LegalConsentModalProps) {
  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { toast } = useToast();

  const accept = async () => {
    if (!agreed || saving) return;
    setSaving(true);
    setFailure(null);
    try {
      await recordConsent(uid, version);
      toast("Thanks — you're all set", 'success');
      onAccepted();
    } catch (err) {
      // A generic "couldn't save" here is a dead end: the user cannot proceed
      // and cannot tell a misconfiguration from a dropped connection. Name the
      // actual cause so it is fixable.
      const code =
        err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
      console.error('[legal] failed to record consent', { code });

      if (code.includes('permission-denied')) {
        setFailure(
          'The database rejected this write. The app\'s Firestore rules need to allow ' +
          '"termsVersion" and "termsAcceptedAt" on the user document — deploy the ' +
          'latest firestore.rules and try again.'
        );
      } else if (code.includes('unavailable') || code.includes('network')) {
        setFailure('Could not reach the server. Check your connection and try again.');
      } else {
        setFailure('Something went wrong saving your acceptance. Please try again.');
      }
      setSaving(false);
    }
  };

  return (
    // No `onClose` behaviour that dismisses silently — declining signs out.
    <Modal onClose={() => {}} size="md" variant="center" labelledBy="legal-consent-title">
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-4 sm:px-6">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent/12 text-accent">
          <FileText size={18} />
        </span>
        <div className="min-w-0">
          <h2 id="legal-consent-title" className="text-lg font-bold text-fg">
            We've updated our terms
          </h2>
          <p className="text-sm text-muted">Updated {formatLegalDate(lastUpdated)}</p>
        </div>
      </div>

      <ModalBody className="space-y-4">
        <p className="text-[15px] leading-relaxed text-muted">
          We've made changes to our Terms of Conditions and Privacy Policy. Please review
          them and accept to keep using Yappr.
        </p>

        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            onClick={() => navigate('/terms-of-conditions')}
            className="btn-secondary flex-1 px-4 py-2.5 text-sm"
          >
            Read Terms
          </button>
          <button
            onClick={() => navigate('/privacy-policy')}
            className="btn-secondary flex-1 px-4 py-2.5 text-sm"
          >
            Read Privacy Policy
          </button>
        </div>

        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface-2 p-4">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer accent-[#3b82f6]"
          />
          <span className="text-[15px] leading-relaxed text-fg">
            I have read and agree to the updated Terms of Conditions and Privacy Policy.
          </span>
        </label>

        <p className="text-xs text-subtle">
          Version {version} · Your acceptance is recorded with a timestamp.
        </p>

        {failure && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm leading-relaxed text-danger"
          >
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span>{failure}</span>
          </div>
        )}
      </ModalBody>

      <ModalFooter className="space-y-2">
        <button
          onClick={accept}
          disabled={!agreed || saving}
          className="btn-primary flex h-12 w-full items-center justify-center gap-2 text-sm"
        >
          {saving && <Loader2 size={16} className="animate-spin" />}
          {saving ? 'Saving…' : 'Accept and continue'}
        </button>
        <button
          onClick={onDecline}
          disabled={saving}
          className="btn-secondary h-11 w-full text-sm"
        >
          Decline and sign out
        </button>
      </ModalFooter>
    </Modal>
  );
}
