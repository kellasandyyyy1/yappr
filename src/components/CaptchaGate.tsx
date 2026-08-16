import React, { useState, useEffect, useCallback } from 'react';
import { ShieldAlert, RefreshCw } from 'lucide-react';

/**
 * Challenge shown after repeated failed sign-ins.
 *
 * HONEST SCOPE: this is a self-contained arithmetic challenge. It stops naive
 * scripted credential stuffing, and nothing more — a determined attacker reads
 * the answer out of the DOM or skips the UI entirely and posts to Firebase's
 * REST endpoint. It exists as a visible friction step and as a drop-in seam.
 *
 * For a real bot defence, replace the body of this component with Cloudflare
 * Turnstile or reCAPTCHA Enterprise and verify the token server-side. The
 * contract (`onVerified(token)`) is already shaped for that: a hosted provider
 * hands you a token, you forward it, your backend validates it. Nothing else
 * in the sign-in flow needs to change.
 */

interface CaptchaGateProps {
  onVerified: (token: string) => void;
  onReset: () => void;
  verified: boolean;
}

function makeChallenge() {
  const a = Math.floor(Math.random() * 8) + 2;
  const b = Math.floor(Math.random() * 8) + 2;
  return { a, b, answer: a + b };
}

export function CaptchaGate({ onVerified, onReset, verified }: CaptchaGateProps) {
  const [challenge, setChallenge] = useState(makeChallenge);
  const [value, setValue] = useState('');
  const [failed, setFailed] = useState(false);

  const regenerate = useCallback(() => {
    setChallenge(makeChallenge());
    setValue('');
    setFailed(false);
    onReset();
  }, [onReset]);

  useEffect(() => {
    if (verified) return;
    setValue('');
  }, [verified]);

  const submit = (next: string) => {
    setValue(next);
    setFailed(false);
    if (next.trim() === '') return;

    if (Number.parseInt(next, 10) === challenge.answer) {
      // Local marker only. A hosted provider would return a real token here.
      onVerified(`local-challenge:${Date.now()}`);
    } else if (next.trim().length >= String(challenge.answer).length) {
      setFailed(true);
      onReset();
    }
  };

  if (verified) {
    return (
      <div className="mb-5 flex items-center gap-2 rounded-xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-accent">
        <ShieldAlert size={16} />
        Verification complete. You can sign in.
      </div>
    );
  }

  return (
    <div className="mb-5 rounded-xl border border-line-strong bg-surface-2 p-4">
      <div className="mb-3 flex items-start gap-2">
        <ShieldAlert size={16} className="mt-0.5 shrink-0 text-muted" />
        <p className="text-sm leading-relaxed text-muted">
          Several sign-in attempts failed. Answer this to continue.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <label htmlFor="captcha-answer" className="text-sm font-semibold text-fg">
          {challenge.a} + {challenge.b} =
        </label>
        <input
          id="captcha-answer"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={value}
          onChange={(e) => submit(e.target.value.replace(/\D/g, ''))}
          aria-invalid={failed}
          aria-describedby={failed ? 'captcha-error' : undefined}
          className="field h-10 w-20 text-center"
        />
        <button
          type="button"
          onClick={regenerate}
          aria-label="Get a different question"
          title="Get a different question"
          className="tap rounded-full text-muted transition-colors duration-100 hover:text-fg"
        >
          <RefreshCw size={16} />
        </button>
      </div>

      {failed && (
        <p id="captcha-error" role="alert" className="mt-2 text-sm text-danger">
          That's not right. Try again.
        </p>
      )}
    </div>
  );
}
