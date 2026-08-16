# Yappr

A social web app — posts, group chats, direct messages, profiles.

React 19 + TypeScript + Vite, Supabase for auth/database/storage/realtime,
deployed on Vercel as a static build plus serverless functions.

---

## Run locally

**Prerequisites:** Node.js 20+

```bash
npm install
npm run dev          # http://localhost:3000
```

`npm run dev` runs `server.ts`, an Express host with Vite in middleware mode.
It exists for local development only — **Vercel does not run it** (see
[Deployment](#deployment)).

> On Windows `npm run start` fails: `NODE_ENV=production tsx server.ts` is not
> valid cmd syntax. Use `$env:NODE_ENV="production"; npx tsx server.ts` in
> PowerShell, or add `cross-env`.

## Scripts

| Script | Does |
|---|---|
| `npm run dev` | Local dev server on :3000 |
| `npm run build` | Production build to `dist/` |
| `npm run lint` | `tsc --noEmit` |
| `npm run icons` | Regenerate favicons/PWA icons from the brand SVG |
| `npm run verify:pwa` | Assert the PWA installability checklist against a running server |
| `npm run db:validate` | Apply all migrations to in-process Postgres (PGlite) and run smoke tests |
| `npm run db:verify` | Verify the live Supabase schema |
| `npm run db:rls` | Run the RLS behaviour suite against staging with real JWTs |
| `npm run db:bundle` | Regenerate `supabase/ALL_MIGRATIONS.sql` |

## Environment

Copy the variables below into `.env.local` for local work, and into the Vercel
project for deployment. `VITE_`-prefixed variables are **compiled into the
client bundle** — never put a secret behind that prefix.

| Variable | Scope | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL` | client + server | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | client + server | Publishable key (`sb_publishable_…`) |
| `SUPABASE_SERVICE_ROLE_KEY` | **server only** | Bypasses RLS. Never expose to the browser. |
| `VITE_VAPID_PUBLIC_KEY` | client + server | Web Push application server key |
| `VAPID_PRIVATE_KEY` | **server only** | Web Push signing key |
| `VAPID_SUBJECT` | server | `mailto:` contact for push. Defaults to `mailto:support@yappr.app`. |
| `GEMINI_API_KEY` | build | Only if the Gemini integration is used |

Check what the deployed function can actually see:

```
GET /api/health   →   { config: { vapidPrivateKey: true, ... } }
```

It reports presence, never values.

## Deployment

Vercel serves the Vite build statically. **`server.ts` never executes there**,
so everything it did had to move:

| Was in `server.ts` | Now |
|---|---|
| `POST /api/send-push` | `api/send-push.ts` (serverless function) |
| `GET /api/health` | `api/health.ts` |
| CSP + security headers | `vercel.json` → `headers` |
| SPA fallback (`app.get("*")`) | `vercel.json` → `rewrites` |
| HTTPS redirect | Vercel does this natively |
| In-memory rate limiter | Best-effort per-instance only — see the note in `api/send-push.ts` |

The rewrite deliberately excludes `/api/`, `/assets/`, `/favicon/`, `/legal/`,
`/sw.js` and `/manifest.json`. A catch-all that swallowed `sw.js` would break
the PWA and serve HTML where JavaScript was expected.

## Documentation

- `SECURITY.md` — authentication controls, and what is deliberately not covered
- `MIGRATION.md` — the Firebase → Supabase migration, including every flagged
  risk and behavioural change
