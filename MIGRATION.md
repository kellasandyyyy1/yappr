# Firebase → Supabase migration

## Status

| Step | State |
|---|---|
| 1. Schema design | **Done and validated** — `0001_schema.sql` |
| 1b. Triggers / derived state | **Done and validated** — `0002_triggers.sql` |
| 2. Export / transform / import / verify | **Done** — `scripts/migrate/` |
| 3. Auth migration | **Done**, with an unavoidable caveat (see A1) |
| 4. Storage migration | **Done** — `scripts/migrate/04-migrate-storage.ts` |
| 5. Rules → RLS | **Done and verified live** — `0001`–`0008` all applied to staging, 55/55 RLS suite passing |
| 6. Cloud Functions | **N/A** — none exist, but `server.ts` still verifies Firebase tokens (see below) |
| 7. Frontend rewiring | **Done** — no file under `src/` imports the Firebase SDK |
| 8. Cutover plan | **Written** (below), not executed |

### Step 7 progress

| File | State |
|---|---|
| `src/lib/db.ts` | **Done** — the data-access layer everything else uses |
| `src/lib/supabase.ts` | **Done** — client, storage helpers, signed URLs |
| `src/lib/auth-migration.ts` | **Done** — forced-reset flow |
| `src/lib/securityEvents.ts` | **Done** — append-only `security_events` table |
| `src/lib/mfa.ts` | **Done** — rewritten on Supabase MFA; see A8 |
| `src/App.tsx` | **Done** — auth session, badges, delivery receipts, aal gate |
| `src/components/Feed.tsx` | **Done** — keyset pagination, joins, realtime |
| `ChatView.tsx` | **Done** — realtime, presence, private-bucket attachments |
| `CommentsModal.tsx` | **Done** — joined authors, per-row reactions, uploads |
| `ProfileView.tsx` | **Done** — RLS-enforced visibility, cascading deletes |
| `SearchView.tsx` | **Done** — real indexed `ILIKE` over the trigram indexes |
| `AuthView.tsx` | **Done** — signup/profile split, aal-aware 2FA |
| `lib/authErrors.ts` | **Done** — GoTrue codes; see A9, this one was load-bearing |
| `lib/legal.ts` | **Done** — consent timestamp moved server-side (0007) |
| `lib/pushNotifications.ts` | **Done** — upsert on the unique endpoint |
| `lib/sendPush.ts` | **Done** — sends the Supabase access token |
| 10 remaining components | **Done** — `CreateGroupModal`, `CreatePostModal`, `NotificationsView`, `PostDetailModal`, `PresenceTracker`, `ProfilePreviewCard`, `RightRail`, `SharedPostPreview`, `ShareModal`, `ThemeSongSearch`, `UsersListModal` |

`grep -r "from 'firebase/" src/` returns nothing. `npx tsc --noEmit` and
`npx vite build` both pass. The bundle dropped from **1,769 kB (489 kB gzip)**
to **1,246 kB (366 kB gzip)** — the entire Firebase SDK is out.

`src/lib/firebase.ts` is left in place but is now imported by nothing. Deleting
it is a one-line cutover step; keeping it until then preserves an easy rollback.

**Still not runnable end-to-end**, for one reason that is not frontend work:
`server.ts` still verifies **Firebase** ID tokens on `POST /api/send-push`,
while `sendPush.ts` now sends a **Supabase** access token. Push will 401 until
`server.ts` is switched to `supabase.auth.getUser(jwt)`.

Nothing has been run against live *user* data. The transform was verified end-to-end
against a synthetic export covering every edge case listed below; the import,
storage and verify steps refuse to run without `SUPABASE_SERVICE_ROLE_KEY` and
have only been exercised in dry-run.

---

## ⚠ Flagged risks — read before running anything

### A1. Passwords cannot migrate. Every user must reset.

Firebase hashes with a modified **scrypt** parameterised by a project-specific
signer key, salt separator, rounds and memory cost. Supabase Auth (GoTrue)
verifies **bcrypt** and **argon2**. There is no conversion between them without
the plaintext password, which nobody has.

Accounts are created in Supabase with **no password**. `src/lib/auth-migration.ts`
routes users into a reset flow instead of a hard lockout, and the account,
username, id and all content survive intact.

**This is user-visible and needs announcing by email before cutover, not
discovering at the sign-in screen.** There is currently no mail transport in
this project (see `SECURITY.md`), so that announcement has to be sent manually
or a provider wired up first.

### A2. Two live bugs in the current Firestore data model

Both are fixed *structurally* by the new schema, which means the migrated data
will behave differently from production today. That is a correction, but it is
a behaviour change and you should know about it.

**Like document ids are built in two different orders.** `Feed.tsx`,
`ProfileView.tsx` and `CommentsModal.tsx` write `` `${postId}_${userId}` ``, but
`PostDetailModal.tsx:42` reads `` `${userId}_${postId}` ``. The post detail modal
therefore always shows a post as un-liked. The new `likes` table uses a
composite primary key `(post_id, user_id)`, so order cannot vary.

**Comments are read from a collection nothing writes to.** `CommentsModal`
writes to `posts/{postId}/comments`; `PostDetailModal.tsx:57` counts from a
top-level `comments` collection. That count is always 0. The export includes
the legacy top-level collection so you can confirm it is empty — the transform
raises an **error** (not a warning) if it contains anything, rather than
discarding it.

### A3. Receipt timestamps are approximate

Firestore stored `readBy[]` / `deliveredTo[]` as arrays of uids with **no
per-user timestamp**. The normalised `message_receipts` table has
`delivered_at` and `read_at` columns, and the migration fills both with the
*message's* `created_at` because nothing better exists.

So "Seen" times on historical messages are wrong — they will read as though
every recipient opened the message the instant it was sent. Messages sent after
cutover are accurate. The transform logs a warning with the affected count.

### A4. Post visibility was never actually enforced

`firestore.rules` had `allow read: if isSignedIn()` on posts, and the
followers-only / private filter ran in the client. Anyone querying Firestore
directly could read every post regardless of its `visibility` field.

The new `can_view_post()` RLS policy enforces it in the database. **Some posts
that were de-facto public will become genuinely private after migration.** If
anyone relied on seeing them, that access disappears.

### A5. Orphan records are dropped, loudly

The transform cannot place a row whose foreign key does not resolve. In every
case it writes an entry to `migration-data/issues-transform.json` and the run
prints a grouped summary. Verified categories:

- Firestore profile with no Firebase Auth user → **error**, no `users` row is
  possible (nothing for `users.id` to reference)
- Auth user with no email → **error**, cannot be recreated
- Post / comment / message whose author no longer exists → **error**, skipped
- Like or follow referencing a deleted user or post → warning, dropped
- Reaction from an unknown user → warning, dropped
- Duplicate follows (Firestore's `addDoc` permitted them) → warning, collapsed
- Duplicate usernames (never unique in Firestore) → warning, second one renamed
  with a numeric suffix
- Unparseable dates → warning, set to epoch so they are *visibly* wrong rather
  than plausibly wrong

**Review `issues-transform.json` before importing.** A non-zero error count
means real records will not exist in Supabase.

### A6. Chat media access level changes

Firebase Storage download URLs carry an unguessable token, so chat images were
protected by URL secrecy. A public Supabase bucket would be strictly weaker, so
`04-migrate-storage.ts` puts chat media in a **private** bucket and stores
`supabase://chat/<path>` in the database. Reads must go through
`resolveStorageUrl()` in `src/lib/supabase.ts`, which mints a signed URL.

Any code that renders `message.image_url` directly will show a broken image
until it is updated. This is part of step 7.

### A7. Typing indicators should not become a table

`chats/{id}/typing` is ephemeral, high-churn state. Writing it to Postgres
would generate a row write per keystroke. It is deliberately **not** in the
schema — reimplement it with Supabase Realtime **Presence**, which is designed
for exactly this and costs no database writes.

### A8. Two-factor authentication means something different here

**`0006_require_aal2.sql` must be applied or 2FA becomes decoration.**

Firebase and Supabase disagree about what a second factor *is*:

| | Firebase | Supabase |
|---|---|---|
| Password step with a factor enrolled | **rejects** with `auth/multi-factor-auth-required` | **succeeds**, issues an `aal1` session |
| Session before the code is entered | none exists | a real, usable one |
| Enforcement point | the auth API | whatever checks the `aal` claim — by default, nothing |

Ported naively, an attacker holding only the password could close the 2FA
prompt and keep using the `aal1` session. The second factor would be a screen,
not a control.

Three things close the gap, and all three are in place:

1. `0006_require_aal2.sql` wraps every one of the 51 policies in
   `mfa_satisfied() and (…)`. That predicate is true unless the account has a
   **verified** factor and the token is still `aal1`. Accounts without 2FA are
   unaffected — for them `aal1` is the top level, and demanding `aal2` would
   lock out the entire user base. An enrolment that was started and never
   confirmed also cannot lock anyone out.
2. `abandonTotpChallenge()` signs the half-authenticated session out when the
   user backs out of the prompt.
3. `App.tsx` treats a pending challenge as "not signed in", so an `aal1`
   session cannot render the app.

The rewrite in 0006 is generated, not hand-written: it reads each policy's
current expression back out of `pg_policies` and re-issues it wrapped. The
original condition is preserved verbatim, so the migration can only make a
policy stricter, never looser. Coverage is asserted afterwards rather than
assumed — `mfa_guard_coverage()` lists any policy the loop missed, and
`06-verify-live-schema.ts` fails if that list is non-empty.

**Applied to staging and verified live.** Against `llgsamvklytdtgxumpzm`, with a
throwaway auth user and a real `auth.mfa_factors` row, driving the `aal` claim
through `request.jwt.claims`:

| check | expected | actual |
|---|---|---|
| no factor @ aal1 → allowed | true | true |
| verified factor @ aal1 → **blocked** | false | false |
| verified factor @ aal2 → allowed | true | true |
| unverified enrolment @ aal1 → allowed | true | true |

Coverage went from `guarded: 0` before to `guarded: 51, unguarded: 0` after,
and `07-rls-suite.ts` still passes 55/55 — which is the check that matters for
the "accounts without 2FA are unaffected" claim, since none of its test users
have a factor.

### A9. Two silent regressions caught while porting the auth libs

Neither would have thrown, logged, or failed a build. Recording them because
"it compiles and the screen looks right" was true of both.

**`isCredentialFailure()` would have stopped recognising failures.**
`authErrors.ts` matched exclusively on Firebase `auth/*` codes. That function is
what drives `recordFailure()`, and therefore the 5-attempt lockout and the
CAPTCHA gate. The moment `AuthView` started producing GoTrue errors, every
failed sign-in would have been classified as "not a credential failure": no
attempt counted, no lockout, no CAPTCHA — and no error anywhere to say the
throttle had stopped working. It now matches Supabase codes, keeps the Firebase
ones, and falls back to message text then HTTP status (400/422 only — counting a
429 or a 5xx would lock a user out for someone else's failure).

**`recordConsent()` would have started dating its own compliance record.**
The Firestore version wrote `serverTimestamp()`. The natural port sends
`new Date().toISOString()` from the browser, which any modified client can
back-date — the exact claim the record exists to withstand. `0007` moves the
stamp into a trigger and revokes the column from the client grant, which is
strictly stronger than what it replaces: `serverTimestamp()` still required the
client to *ask* for a server clock.

Also removed rather than ported: `handleFirestoreError()` serialised the
signed-in user's email, verification state and every linked provider identity
into `console.error` on any failed read, then re-threw the same as JSON. A
permission denial wrote PII to the console and to whatever was scraping it.

### A10. The CSP failed the whole app closed, silently

Converting all 22 files to Supabase did nothing for the `Content-Security-Policy`
in `server.ts`, whose `connect-src` still allowlisted only Firebase. The browser
refused every Supabase request — auth, PostgREST, Storage, Realtime — before it
left the page.

What made it expensive to diagnose is how it surfaces. A CSP block gives
JavaScript a bare `TypeError: Failed to fetch`: **no HTTP status, no error
code**, indistinguishable from being offline, and frequently with no Network tab
entry at all. `authErrors.ts` had nothing to match on, so it fell through to
"Something went wrong. Please try again." for both sign-in and sign-up.

The tell was that `auth.users` was empty. Had the request reached GoTrue, signup
would have created a row even if everything afterwards failed.

`connect-src` now carries `https://*.supabase.co` **and** `wss://*.supabase.co`
— the websocket is not covered by the https entry, and omitting it leaves chat,
notifications and live counters silently dead while everything else works.
`img-src` and `media-src` gained the same origin for Storage.

Three diagnostics exist now so this class of failure is never guesswork again:

- `diagnoseAuthError()` classifies failures as `blocked` / `credentials` /
  `authorization` / `rate-limit` / `server`. **`blocked` is defined as the
  no-status-no-code signature**, and carries a hint pointing at `connect-src`.
- A `securitypolicyviolation` listener (dev only) logs the exact directive and
  blocked URI — the one thing that names a CSP block as a CSP block.
- `AuthDebugPanel`, dev only, showing code / status / message / what the user
  saw. Gated on `import.meta.env.DEV` so it is compiled out of production:
  shipping it would undo the vague messaging that stops the login form being a
  user-enumeration oracle.

Firebase entries were left in `connect-src` rather than removed. The storage
ones are still needed until `04-migrate-storage.ts` runs; the auth ones are dead
and should go when Firebase is decommissioned. Removing them is a tightening,
not part of this fix.

### A11. Signup created accounts with no profile

`AuthView` called `signUp` and then inserted `public.users` as a **second**
call from the browser. That cannot work with email confirmation enabled
(`mailer_autoconfirm = false`, this project's setting): GoTrue returns a user
with no session, so the insert ran unauthenticated, `users_insert_own` rejected
it with `42501`, and the account was left half-created.

That state does not heal. On the next sign-in `App.tsx` finds no profile and
bounces the user back to the auth screen, permanently — the account exists,
cannot be used, and cannot be re-registered because the email is taken. Even
with confirmation off it was two writes with no transaction around them.

`0009_profile_on_signup.sql` moves it into an `after insert on auth.users`
trigger, so the profile and the account are created together or not at all.
Signup passes username, display name and consent version through
`options.data`; the trigger reads them from `raw_user_meta_data`.

The `? 'username'` guard matters: admin-API-created users (the RLS suite, the
migration importer) carry no such metadata and are skipped, so those scripts
keep inserting their own profile rows. Without it the trigger would insert first
and every one of them would fail on a duplicate id. Both behaviours are asserted
in `validate-schema.ts`.

Verified live via `diagnose-signup.ts`: profile row created, username, display
name, email, consent version and server-stamped consent time all carried
through, teardown clean.

**Note on email rate limits.** Supabase's built-in SMTP allows only a handful of
confirmation emails per hour, and testing exhausts it — signup then fails with
`over_email_send_rate_limit`, which is a quota issue and not a regression.
Configure a real SMTP provider before doing any volume of signup testing.

**Accounts created outside the signup form.** The trigger's metadata guard means
an account added through the Supabase dashboard gets no profile row. The app
used to react by logging to the console and returning the user to the sign-in
screen with nothing displayed — they had just typed the correct password, so it
read as the login silently failing, and retrying could never fix it.

`App.tsx` now attempts `users.ensureProfile()` first, which recreates the row as
the signed-in user under `users_insert_own` (no elevated privileges; it can only
ever create the caller's own row). If there is no username in the metadata it
declines rather than inventing one — a username is public, unique and permanent,
so deriving one from an email address would hand someone a handle they never
chose. In that case the app signs the session out and shows a specific
explanation. Both branches are covered by `diagnose-profile-repair.ts`.

**Unconfirmed sign-in gets its own message.** `email_not_confirmed` was
originally collapsed into the generic credential error. Measured against the
live project, the codes differ:

    correct password, unconfirmed -> 400 email_not_confirmed
    wrong password,   unconfirmed -> 400 invalid_credentials

GoTrue only reports "not confirmed" after accepting the password, so a specific
message reveals the account exists only to someone who already holds valid
credentials — not an enumeration oracle. It is now its own message, and is
excluded from the lockout counter: the password was right, and someone who
cannot find a confirmation email should not be locked out for retrying.

### A12. Outstanding database linter findings

Supabase's linter was run after applying 0006/0007. Three findings were defects
in those two migrations and are fixed in `0008_harden_new_functions.sql`
(mutable `search_path` on `stamp_consent_time`, plus both new functions being
reachable over `/rest/v1/rpc/`). Getting the revoke right took three attempts —
see the header of 0008; the short version is that a function carries a PUBLIC
grant *and* per-role grants from Supabase's default privileges, so a narrow
revoke silently does nothing.

**`mfa_satisfied()` intentionally remains executable by `authenticated`** and
will keep showing up under lint 0029. RLS policy expressions are evaluated with
the querying role's privileges, so revoking it would make all 51 policies fail
with "permission denied for function". The same applies to `follows_user`,
`is_conversation_member`, `is_conversation_creator` and `is_conversation_admin`.

Still open, all pre-existing, none introduced by this migration:

| finding | items | note |
|---|---|---|
| Mutable `search_path` (0011) | `set_updated_at`, `direct_conversation_key`, `recompute_counters`, `can_view_post`, `guard_user_immutable_columns` | Mechanical fix; add `set search_path` to each |
| Trigger functions exposed over RPC (0028/0029) | `bump_post_likes_count`, `bump_post_comments_count`, `fan_out_message_receipts`, `register_direct_conversation`, `touch_conversation` | Safe to revoke from all roles — now **verified**, not assumed: 0008 revoked `stamp_consent_time` from every role and the suite still passes 55/55, including the profile update that fires it. Triggers do not need the invoking role to hold EXECUTE. |
| Predicate functions exposed to `anon` (0028) | `follows_user`, `is_conversation_*` | Revoke from `anon` only; `authenticated` must keep it |
| `pg_trgm` in `public` (0014) | — | Requires dropping and recreating the two GIN indexes on `users`; search degrades to a seq scan in between |
| RLS enabled, no policies (0008, INFO) | `direct_conversation_keys`, `migration_issues` | **Working as designed** — see the comment in 0003. No policies means no client role can touch them. |

---

## Cloud Functions

There are none. The only backend is `server.ts`, an Express server that serves
the SPA and exposes `POST /api/send-push`. It uses `firebase-admin` for two
things:

1. Verifying the caller's Firebase ID token → replace with
   `supabase.auth.getUser(jwt)` or verify the Supabase JWT directly
2. Reading the `subscriptions` collection → replace with a `push_subscriptions`
   query using the service role key

Either keep `server.ts` (smallest change) or move it to a Supabase Edge
Function. Web Push itself is unaffected — VAPID keys and subscriptions carry
over unchanged.

---

## Validating the schema locally

```bash
npm run db:validate
```

Applies every migration to an in-process Postgres (PGlite — no Docker, no
network) and runs 16 structural smoke tests: constraints, cascades, and each
trigger actually firing. Run it after any schema edit; it is much faster than
finding a typo on staging.

Current state: **161/161 statements apply, 16/16 tests pass, every public table
has RLS enabled.** Four statements are skipped locally (`pg_trgm`, `pgcrypto`
and the two trigram indexes) because PGlite does not bundle those extensions —
Supabase does, so they apply there.

What it does **not** cover: PGlite has no `auth.uid()`, so RLS policies are
parsed and accepted but their *logic* is never executed. Behavioural RLS
testing — "can Bob read Alice's private post?" — still has to happen on
staging with real JWTs.

## Running the migration

```bash
# 0. Apply the schema to a STAGING project first
supabase login                                    # opens a browser
supabase link --project-ref llgsamvklytdtgxumpzm  # ← the project in .env.local
supabase db push          # applies supabase/migrations/*.sql in order

# 1. Export from Firebase (read-only; writes migration-data/firestore/)
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
npx tsx scripts/migrate/01-export-firestore.ts

# 2. Transform to Postgres rows (offline, no network — safe to re-run)
npx tsx scripts/migrate/02-transform.ts
#    → REVIEW migration-data/issues-transform.json BEFORE CONTINUING

# 3. Create auth users + import rows
export SUPABASE_SERVICE_ROLE_KEY=<staging service_role key>
npx tsx scripts/migrate/03-import-supabase.ts --dry-run   # rehearse
npx tsx scripts/migrate/03-import-supabase.ts

# 4. Copy files and rewrite URLs (run AFTER step 3)
npx tsx scripts/migrate/04-migrate-storage.ts

# 5. Verify the data migration — exits non-zero on failure
npx tsx scripts/migrate/05-verify.ts
```

## Verifying the schema push

Run these immediately after `db:push`, before any data or frontend work.
`db push` exiting 0 only means the CLI sent the files.

```bash
npm run db:verify   # every table/column present, RLS on, functions callable
npm run db:rls      # RLS *behaviour* with real JWTs — the check PGlite can't do
```

`db:rls` creates three users (alice, bob, carol) on staging, signs each in
through GoTrue, and makes every request with that user's real access token. It
tears them down afterwards even if it fails. It is guarded to the staging
project ref and refuses to run elsewhere unless you set `ALLOW_PROJECT`.

Coverage: private/followers-only post reads, cross-user profile writes, direct
message isolation, group message isolation, non-admin group edits, counter
tampering (the column-grant fix), receipt forgery, append-only security events,
private tables, live cascade deletes for both a post and a user, and
unauthenticated access to every table.

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are already in `.env.local`. The service
role key is not, and must not be committed — it bypasses RLS entirely.

### Optional helper for the SQL integrity checks

`05-verify.ts` runs orphan checks through an RPC that does not exist by
default. Without it those checks are skipped (and say so). To enable:

```sql
create or replace function migration_scalar(query text)
returns numeric language plpgsql security definer as $$
declare result numeric;
begin execute query into result; return result; end;
$$;
revoke execute on function migration_scalar(text) from public, anon, authenticated;
```

**Drop this function before production.** It executes arbitrary SQL; it is a
migration tool, not an application feature.

---

## Cutover plan

**Phase 1 — staging rehearsal.** Run all five steps against a staging project.
Fix whatever `issues-*.json` surfaces, re-run from step 2 (the transform is
deterministic, so re-running produces byte-identical output). Repeat until
`05-verify.ts` exits 0.

**Phase 2 — frontend on staging.** Complete step 7 against staging. Exercise
every surface: feed pagination, posting with images, direct and group chat with
two accounts, realtime delivery, reactions, notifications, profile edit,
avatar upload, search.

**Phase 3 — announce.** Email every user about the forced password reset (A1)
with a date. Without this, cutover looks like a breach to your users.

**Phase 4 — production cutover.**
1. Put the Firebase app in read-only mode (tighten `firestore.rules` to
   `allow read: if isSignedIn(); allow write: if false;`) — this is the point
   after which no new Firebase data is created
2. Re-run steps 1–5 against **production** Supabase
3. Confirm `05-verify.ts` exits 0 and row counts match the read-only Firebase
4. Deploy the Supabase frontend
5. Watch `migration_issues` and error logs

**Phase 5 — keep Firebase.** Leave the project read-only for at least 30 days.
It is the only rollback and the only source for anything found missing later.
Do not delete it on cutover day.

**Rollback:** redeploy the Firebase frontend and lift the read-only rules. Any
data created in Supabase after cutover is lost, so decide fast — this window
should be hours, not days.

---

## Remaining work: step 7, frontend rewiring

22 files, roughly 220 Firebase call sites:

| File | Calls | Notes |
|---|---|---|
| `ChatView.tsx` | 42 | Largest. Realtime subscriptions, pagination, typing |
| `CommentsModal.tsx` | 33 | Realtime comments, reactions, uploads |
| `Feed.tsx` | 31 | Keyset pagination replaces `startAfter` cursors |
| `ProfileView.tsx` | 21 | Profile edit, avatar upload, post grid |
| `App.tsx` | 15 | Auth state, unread counts, delivery receipts |
| `SearchView.tsx` | 10 | Becomes a real `ILIKE` query against the trigram index |
| Others (16 files) | 2–8 each | Mechanical |

The three patterns that are not a like-for-like swap:

**Realtime.** `onSnapshot(query)` attaches to an arbitrary query. Supabase
Realtime subscribes to *table* changes with a single-column filter
(`filter: 'conversation_id=eq.<id>'`) and pushes row deltas, not result sets.
Anywhere the code relies on a snapshot re-running a compound query, the client
has to merge deltas into local state itself.

**Pagination.** `startAfter(docSnapshot)` becomes keyset pagination:
`.lt('created_at', cursor).order('created_at', { ascending: false }).limit(n)`.
The `posts_created_at_idx` index on `(created_at desc, id desc)` exists for
this.

**Fan-out reads.** Feed currently issues an `in` query per 30-user chunk then
fetches each author individually. In Postgres that is one query with a join:
`.select('*, users!inner(username, display_name, photo_url)')`.

I stopped here rather than half-converting 22 files. The foundation is the part
where mistakes are expensive and hard to reverse; the rewiring is mechanical,
reviewable file by file, and safe to do incrementally against staging. Say the
word and I'll work through them — `ChatView`, `Feed` and `App` are the ones
worth doing first since they exercise every pattern above.
