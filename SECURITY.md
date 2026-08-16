# Authentication security

Yappr uses **Supabase Auth (GoTrue)**. The browser talks directly to GoTrue and
to PostgREST; the Express server in `server.ts` only serves the SPA and one push
endpoint. **Sign-in never passes through our server.**

That architecture decides which controls are ours to implement, which are
Supabase's, and which are impossible without changing the architecture. This
document says which is which, honestly, so nobody assumes a protection exists
that doesn't.

---

## 1. Password handling

| Requirement | Status |
|---|---|
| Never store plaintext | ✅ We never store passwords at all |
| bcrypt / argon2id | ⚠️ Not applicable — see below |
| Min length + breach list | ✅ `src/lib/passwordPolicy.ts` |
| Never log passwords | ✅ `src/lib/authErrors.ts` |

**On bcrypt/argon2id.** There is no password store in this application. The
plaintext goes from the input element into the Firebase SDK over TLS and is
discarded; Google hashes and stores it server-side using a memory-hard
**scrypt** variant with a per-project salt and pepper.

Implementing bcrypt would mean **replacing Firebase Auth with a custom
credential store** — writing our own registration, login, session, reset and
lockout logic. That is a strictly worse security outcome than delegating to a
hardened identity provider, and it was not done deliberately. Firebase's scrypt
is memory-hard and satisfies the intent of the requirement (no fast hash, no
MD5/SHA-family alone). If you specifically need Argon2id, the correct move is
migrating to an identity provider that offers it, not hand-rolling auth here.

**Strength enforcement** (`src/lib/passwordPolicy.ts`):
- Minimum **10** characters, maximum 128
- Offline blocklist of the most-guessed passwords
- Rejects passwords containing the user's email local-part or username
- Rejects single-repeated-character and keyboard/number runs
- **HaveIBeenPwned k-anonymity**: SHA-1 the password, send only the **first 5
  hex characters** of the digest to `api.pwnedpasswords.com/range/`, compare
  suffixes locally. The service never sees the password or the full hash. The
  `Add-Padding` header is set so response size leaks nothing.
  - The SHA-1 here is HIBP's wire protocol, **not** password storage.
  - **Fails open**: if the API is unreachable the user is not blocked. A breach
    check that hard-fails turns an HIBP outage into a total signup outage.

**Logging.** `logAuthError()` emits only an error code and a scrubbed message.
`redactSensitive()` strips any key matching `pass|token|secret|otp|credential|
cookie|authorization` plus password/token patterns inside strings and URLs.
The UI previously rendered raw `err.message` — that is gone.

---

## 2. Authentication flow

| Requirement | Status |
|---|---|
| HTTPS only + HSTS | ✅ `server.ts` (308 redirect, 2-year HSTS, preload) |
| Short-lived access token | ✅ Firebase ID tokens, 1 hour, non-configurable |
| Refresh token rotation | ✅ Handled by Firebase |
| Token revocation on logout | ⚠️ Partial — see below |
| HttpOnly cookies for tokens | ❌ Architecturally impossible — see below |
| SameSite / CSRF tokens | ✅ N/A — no auth cookies exist to forge |

**Why tokens are not in HttpOnly cookies.** The Firestore Web SDK authorises
every read and write with an ID token it must be able to read from JavaScript.
Putting that token in an `HttpOnly` cookie would make it unreadable by the SDK
and break all data access. Serving it as a session cookie instead
(`admin.createSessionCookie()`) only helps if **all** data access is proxied
through our server — a rewrite of every Firestore call in the app.

Because the token is necessarily JS-readable, **XSS is the threat that
matters**, and the mitigation is keeping injected script off the page. That is
what the Content-Security-Policy in `server.ts` does. It is the honest
compensating control, not a substitute we're pretending is equivalent.

Firebase stores tokens in IndexedDB (falling back to `localStorage`), not in a
cookie — so there is **no CSRF surface** on authentication. CSRF tokens would
protect nothing here. If you later add cookie-based sessions, they become
mandatory.

**Logout.** `signOut()` clears client state and stops the refresh cycle, but an
already-issued ID token stays valid for up to its 1-hour lifetime. For true
immediate revocation call `admin.auth().revokeRefreshTokens(uid)` server-side;
`server.ts` already passes `checkRevoked: true` to `verifyIdToken`, so revoked
sessions are rejected by our API the moment they're revoked.

---

## 3. Brute-force and abuse protection

| Requirement | Status |
|---|---|
| Rate limit login | ⚠️ Client-side only — see below |
| CAPTCHA after N failures | ✅ Scaffolded, `src/components/CaptchaGate.tsx` |
| Generic error messages | ✅ `src/lib/authErrors.ts` |
| API rate limiting | ✅ Verified: 60 req/min/IP, 20 push/min/uid |

**Login throttling is client-side and bypassable.** `src/lib/loginThrottle.ts`
implements 5 attempts per 15 minutes with exponential backoff (1→2→4→8→15 min),
keyed per account and per device. It runs **in the attacker's browser**. Anyone
willing to POST to `identitytoolkit.googleapis.com` directly skips it entirely.
It is a UX guardrail and a speed bump for unsophisticated credential stuffing.

The real server-side controls must be enabled in the Firebase console:
1. **Firebase App Check** — attests that requests originate from your real app;
   this is the single highest-value item on this list.
2. **Identity Platform** per-IP and per-account abuse throttling.
3. Firebase's built-in `auth/too-many-requests` backoff (already active).

**CAPTCHA** currently renders a local arithmetic challenge after 3 failures.
It stops naive scripts and nothing more. Swap the body of `CaptchaGate` for
Cloudflare Turnstile or reCAPTCHA Enterprise and verify the token server-side;
the `onVerified(token)` contract is already shaped for that.

**User enumeration is closed** on the surfaces we control. Every credential
failure — `user-not-found`, `wrong-password`, `invalid-credential`,
`invalid-email`, `user-disabled` — returns the identical string
`"Invalid email or password."` (asserted by test). Password reset always
returns the same acknowledgement whether or not the address exists.

Residual leaks, both requiring console configuration:
- **Signup** must reject duplicate addresses, which inherently reveals that an
  address is taken. The message is kept vague; enable **Email enumeration
  protection** in the Firebase console to close it at the API level.
- `SearchView` lists user profiles by design — that's a product decision, not
  an auth leak, but it does expose usernames.

---

## 4. Input validation and injection

| Requirement | Status |
|---|---|
| Server-side validation | ✅ `server.ts` validates types, lengths, URL shape |
| Parameterized queries | ✅ N/A — no SQL |
| Email validation + normalization | ✅ `src/lib/emailValidation.ts` |

**No SQL exists in this project.** Firestore is a document store accessed
through a typed SDK that transmits structured values, not concatenated query
strings; SQL injection is not reachable. The equivalent control is
**Firestore security rules** (`firestore.rules`), which enforce field-level
write allowlists server-side.

**Email normalization** lowercases and trims before every lookup and before
throttle keying — otherwise `Bob@x.com` and `bob@x.com` are different rate-limit
buckets and the limiter is bypassed by changing capitalisation. Dots and
`+tags` are deliberately **not** stripped: some providers treat them as
distinct addresses, and merging them would let one person take over another's
account.

---

## 5. Session and account security

| Requirement | Status |
|---|---|
| Invalidate sessions on password change | ✅ Firebase revokes refresh tokens |
| New-device login alert | ✅ `src/lib/securityEvents.ts` (push + audit log) |
| Email alerts | ❌ No mail transport — see below |
| New IP/location alert | ⚠️ Needs a blocking function — see below |
| Secure forgot-password | ✅ Firebase: single-use, time-limited |
| Optional TOTP 2FA | ✅ Scaffolded, `src/lib/mfa.ts` |

**Security event log.** Sign-ins, password changes and 2FA changes append to
`users/{uid}/securityEvents`. Rules make it **append-only and owner-read**:
`allow update, delete: if false`, so an attacker with a live session cannot
erase evidence of their own sign-in.

**New-device detection** uses a random UUID in `localStorage`, not a browser
fingerprint — fingerprinting is a privacy problem and unreliable, and a random
id answers the only question we need ("seen this browser before?").

**Email alerts are not implemented.** There is no mail transport in this
project. `notifyByEmail()` in `securityEvents.ts` logs a warning rather than
silently dropping mail. To finish: add SES/Postmark/Resend behind a
`/api/security-alert` route and call it from that function. Alerts currently
go out over the existing Web Push channel.

**IP/location alerts need a Firebase blocking function.** The browser cannot
read its own public IP, and client-side geolocation prompts the user and is
easily spoofed. A `beforeSignIn` blocking function (Identity Platform) does
receive the request IP and is the correct place for this.

**Forgot-password** uses Firebase's `oobCode`: single-use, invalidated on use
and when a newer one is issued. Default expiry is **1 hour**, not the 15–30
minutes requested — Firebase does not expose that as a setting. Shortening it
requires generating reset links yourself with
`admin.auth().generatePasswordResetLink()` and enforcing your own expiry.

**2FA** is built on Firebase's native TOTP MFA, so the second factor is
enforced at the auth API rather than merely checked in the UI. `AuthView`
already handles the `auth/multi-factor-auth-required` interruption and prompts
for a 6-digit code. **Requires Identity Platform + TOTP enabled in the
console**; until then `isMfaAvailable()` is false and enrolment throws
`auth/operation-not-allowed`. Enrolment UI still needs building in Settings.

---

## Vulnerabilities found and fixed during this work

1. **Unauthenticated push relay.** `POST /api/send-push` accepted any
   `toUserId` from anyone on the internet — an open relay for pushing
   arbitrary notification text to any user. Now requires a valid Firebase ID
   token verified with `checkRevoked: true`, plus per-sender rate limiting and
   input bounds. Verified: unauthenticated and forged tokens both return 401.

2. **VAPID private key committed to source.** `server.ts` had a hardcoded
   fallback private key. Anyone with it can forge push messages this app's
   service worker accepts. Now required from the environment.
   **→ The old keypair is in git history and must be rotated:**
   `npx web-push generate-vapid-keys`

3. **User enumeration oracle.** The login and reset forms rendered raw
   Firebase error messages, distinguishing "no such user" from "wrong
   password". Now collapsed to one generic message.

4. **Boot-time crash on bad push credentials.** `setVapidDetails` throws on a
   malformed key, taking down the whole server. Now caught: push degrades,
   the app stays up.

---

## Required console configuration

Code cannot set these. In rough priority order:

- [ ] **Enable Firebase App Check** — the highest-value item here
- [ ] **Enable Email enumeration protection** (Authentication → Settings)
- [ ] **Upgrade to Identity Platform** and enable **TOTP MFA**
- [ ] **Rotate the leaked VAPID keypair**, set `VAPID_PRIVATE_KEY` /
      `VITE_VAPID_PUBLIC_KEY` in the environment
- [ ] Set authorised domains (Authentication → Settings → Authorized domains)
- [ ] Deploy the updated `firestore.rules`
- [ ] Add a `beforeSignIn` blocking function for IP/location alerting
- [ ] Configure a mail transport for email alerts
- [ ] Consider swapping `CaptchaGate` for Turnstile / reCAPTCHA Enterprise
