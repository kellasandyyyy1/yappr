---
title: Privacy Policy
version: 2026-08-16.1
lastUpdated: 2026-08-16
---

> **[PLACEHOLDER — REVIEW WITH LEGAL COUNSEL]**
> This document describes how Yappr actually handles data, based on the
> application as built. It has **not** been reviewed by a lawyer and is not a
> substitute for legal advice. Before publishing, have counsel review it
> against the regimes that apply to you — GDPR (EU/UK), CCPA/CPRA
> (California), the Philippines Data Privacy Act of 2012, and any other
> jurisdiction where your users live. Sections marked as placeholders need
> real legal language; the factual descriptions of data handling are accurate
> to the current build and should be kept accurate as the app changes.

## Introduction

Yappr is a social application where you can publish posts, send direct and
group messages, react to content, and attach a song to your profile. This
policy explains what information the service collects, why, who it is shared
with, and what control you have over it.

By creating an account you agree to the handling described here. If you do not
agree, please do not create an account.

## Data we collect

### Account information

- **Email address** — used to sign in, to send password resets, and to contact
  you about your account.
- **Username and display name** — shown publicly alongside everything you post.
- **Password** — we never see, store, or log your password. Authentication is
  handled by Google Firebase Authentication, which stores only a salted
  cryptographic hash. Our own servers and database never receive it.
- **Consent record** — the version of these documents you accepted and the
  timestamp, kept as a compliance record.

When you choose a password we check it against the
[Have I Been Pwned](https://haveibeenpwned.com/Passwords) breach corpus using
k-anonymity: only the first five characters of a hash of your password are
sent, and the full password never leaves your device.

### Profile content

- Profile photo (avatar)
- Bio text
- Theme song — the YouTube video you select, stored as a video ID, title,
  artist, and thumbnail URL
- Listening history — a record of theme songs you play within the app

### Content you create

- Posts, including text, images, voice notes, and attached songs
- Comments and emoji reactions
- Direct messages and group chat messages, including images and voice notes
- Follows, likes, and group memberships

**Messages are not end-to-end encrypted.** They are encrypted in transit and at
rest, but they are stored in a form the service operator can technically read.
Do not use Yappr to send information you would not want the operator to be
able to access.

### Usage and device data

- **Presence** — an online/idle/offline status and a "last active" timestamp,
  so others can see when you were last online
- **Device records** — when you sign in from a browser we have not seen
  before, we record a randomly generated device identifier and a coarse
  description ("Chrome on Windows") to alert you to unrecognised sign-ins. We
  do **not** use browser fingerprinting
- **Security events** — sign-ins, password changes, and two-factor changes are
  written to a log only you can read
- **Push subscriptions** — if you enable notifications, the browser-issued
  push endpoint and its keys

**IP addresses.** Yappr's own application code does not collect, store, or log
your IP address. Our infrastructure providers (Google Firebase, and whoever
hosts the application) process IP addresses as part of delivering the service
and for abuse prevention, under their own policies linked below.

## How we use your data

- **Providing the service** — showing your posts to people who follow you,
  delivering your messages, rendering your profile
- **Account security** — detecting unrecognised sign-ins, rate-limiting
  repeated failed sign-in attempts, screening passwords against known breaches
- **Safety and moderation** — profanity and slur terms are masked in message
  previews in your inbox list. This filtering runs on your own device; the
  original message text is never altered
- **Notifications** — telling you about likes, comments, follows, mentions,
  and new messages

**We do not use analytics or advertising trackers.** There is no Google
Analytics, no advertising SDK, no behavioural profiling, and we do not sell or
rent personal data.

## Data storage and security

- All traffic is served over HTTPS. HTTP requests are redirected, and HSTS is
  set so browsers refuse to connect insecurely.
- Passwords are hashed by Firebase Authentication using a memory-hard scrypt
  variant. We never receive the plaintext.
- Data is stored in Google Firestore and Google Cloud Storage, encrypted at
  rest by Google.
- Database access is governed by server-enforced security rules that restrict
  each account to its own data.
- A Content Security Policy is applied to limit the impact of code injection.
- Optional two-factor authentication (TOTP) is available where enabled.

Security details are documented in the project's `SECURITY.md`.

No system is perfectly secure. If you believe your account has been accessed
without permission, change your password immediately and contact us.

## Third-party services

| Service | Purpose | What it receives |
|---|---|---|
| Google Firebase Authentication | Sign-in and password storage | Email address, password (hashed by them), IP address |
| Google Cloud Firestore | Database | All content and profile data you create |
| Google Cloud Storage | Images and voice notes | Files you upload |
| YouTube (Google) | Theme song playback | Your IP address and standard request data when a player loads. YouTube may set its own cookies |
| Have I Been Pwned | Breached-password screening | The first five characters of a hash of a candidate password. Never the password, never your identity |
| Web Push services (Google/Mozilla/Apple, per your browser) | Delivering notifications | Notification content and your push endpoint |

Each of these operates under its own privacy policy. Loading a YouTube player
means Google may process data about you under Google's policy, independent of
this one.

> **[PLACEHOLDER — REVIEW WITH LEGAL COUNSEL]** Confirm your hosting provider
> and add it to this table. If you later add analytics, error reporting, or
> email delivery, they must be listed here before launch.

## Data retention and deletion

- **Content you delete** — posts, comments, and messages are removed from the
  database when you delete them. Backups may retain copies for a limited
  period.
- **Messages** — a message deleted by its sender is removed for everyone in
  the conversation.
- **Security event log** — retained so you can audit account activity. It is
  append-only and cannot be edited or deleted from within the app, so that
  someone who gains access to your account cannot erase evidence of it.
- **Account deletion** — see below.

> **[PLACEHOLDER — REVIEW WITH LEGAL COUNSEL]** State a concrete retention
> period (for example "deleted within 30 days, purged from backups within
> 90 days") and make sure your actual infrastructure honours it. GDPR expects
> a specific period or the criteria used to determine one.

## Your rights

Depending on where you live, you may have the right to:

- **Access** the personal data held about you
- **Correct** inaccurate data — your name, bio, avatar, and theme song are all
  editable directly in the app
- **Delete** your account and associated data
- **Export** your data in a portable format
- **Object to or restrict** certain processing
- **Withdraw consent** at any time
- **Complain** to your local data protection authority

To request access, export, or deletion, email the address in
[Contact us](#contact-us). We will respond within the period required by
applicable law.

> **[PLACEHOLDER — REVIEW WITH LEGAL COUNSEL]** Self-service account deletion
> is not yet implemented in the app. Until it is, deletion requests are
> handled manually by email. Add a specific response deadline (GDPR: one
> month) once your process is defined.

## Cookies and local storage

Yappr does not use advertising or analytics cookies. It does use browser
storage for functionality that cannot work without it:

| What | Where | Why |
|---|---|---|
| Authentication tokens | IndexedDB / local storage (set by Firebase) | Keeps you signed in |
| Device identifier | Local storage | Recognising this browser for new-device sign-in alerts |
| Failed sign-in counters | Local storage | Slowing down repeated failed sign-in attempts |
| Recent searches | Local storage | Showing your recent searches on the Explore page |

All of this stays on your device and can be cleared through your browser
settings. Clearing it signs you out.

Loading a theme song embeds a YouTube player, which may set cookies controlled
by Google rather than by us.

## Children's privacy

> **[PLACEHOLDER — REVIEW WITH LEGAL COUNSEL]** Set the minimum age to match
> your target regions before publishing. Common thresholds: **13+** under
> COPPA (US), **16+** in parts of the EU unless a lower age is set locally
> (GDPR Art. 8), **13+** with parental consent considerations under the
> Philippines Data Privacy Act.

Yappr is not intended for children under **13**. We do not knowingly collect
personal data from children under that age. If you believe a child has created
an account, contact us and we will remove it.

## Changes to this policy

If we make material changes, we will update the version and date at the top of
this page and ask you to review and accept the updated documents the next time
you use the app. Minor clarifications may be made without a re-acceptance
prompt.

## Contact us

For privacy questions, data access requests, or account deletion requests:

**privacy@privy.app**

> **[PLACEHOLDER — REVIEW WITH LEGAL COUNSEL]** Replace with a monitored
> address. If you serve EU users you may also need a named data controller,
> a postal address, and possibly an EU representative under GDPR Art. 27.
