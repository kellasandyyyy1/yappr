import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import webpush from "web-push";
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import fs from "fs";
import dotenv from "dotenv";

// Vite loads .env.local for the client automatically; this file is plain Node
// and was reading process.env directly, so it never saw any of it. The visible
// symptom was "Push notifications disabled: set VITE_VAPID_PUBLIC_KEY..." on
// every boot despite both keys being present in .env.local — and a hard exit in
// production, where those keys are required.
//
// `override: false` is the default and is what we want: a real environment
// variable from the host always beats the file, so this changes nothing in a
// deployed environment that already sets them properly.
dotenv.config({ path: path.join(process.cwd(), ".env.local") });
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load firebase config for named database if it exists
const firebaseConfigPath = path.join(process.cwd(), "firebase-applet-config.json");
let firebaseConfig: any = {};
if (fs.existsSync(firebaseConfigPath)) {
  firebaseConfig = JSON.parse(fs.readFileSync(firebaseConfigPath, "utf-8"));
}

// Initialize Firebase Admin
if (!admin.apps.length) {
  try {
    const adminConfig: any = {
      projectId: firebaseConfig.projectId,
    };
    
    // In our environment, applicationDefault() might fail if not explicitly set up
    // but the library can often auto-detect when running on GCP
    try {
      adminConfig.credential = admin.credential.applicationDefault();
      console.log("Using applicationDefault credentials");
    } catch (e) {
      console.warn("Could not find default credentials, attempting auto-initialization");
    }

    admin.initializeApp(adminConfig);
    console.log("Firebase Admin initialized for project:", firebaseConfig.projectId || "detect-at-runtime");
  } catch (error) {
    console.error("Firebase Admin initialization FAILED:", error);
    // Ultimate fallback
    try {
      admin.initializeApp();
    } catch (e2) {
      console.error("Ultimate fallback failed:", e2);
    }
  }
}

// Use named database if specified
const databaseId = firebaseConfig.firestoreDatabaseId || "(default)";
const db = getFirestore(databaseId);
console.log("Firestore initialized for database:", databaseId);

// VAPID keys.
//
// The private key previously had a hardcoded fallback committed to source.
// A VAPID private key is a signing credential: anyone holding it can forge
// push messages that this app's service worker will accept. It is now
// required from the environment and the process refuses to start without it.
//
// ROTATE THE OLD KEYPAIR — it is in git history and must be considered
// compromised. Generate a new pair with `npx web-push generate-vapid-keys`.
const VAPID_PUBLIC_KEY = process.env.VITE_VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:support@privy.app";

let pushEnabled = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (pushEnabled) {
  // setVapidDetails throws on a malformed key. Left unguarded that takes the
  // whole server down at boot — a bad push credential should degrade push,
  // not the app.
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY!, VAPID_PRIVATE_KEY!);
  } catch (err) {
    pushEnabled = false;
    console.error(
      "Invalid VAPID keys — push notifications disabled:",
      err instanceof Error ? err.message : String(err)
    );
    if (process.env.NODE_ENV === "production") process.exit(1);
  }
} else if (process.env.NODE_ENV === "production") {
  console.error(
    "FATAL: VAPID_PRIVATE_KEY and VITE_VAPID_PUBLIC_KEY are required in production."
  );
  process.exit(1);
} else {
  console.warn(
    "Push notifications disabled: set VITE_VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to enable."
  );
}

/**
 * Fixed-window rate limiter, in memory.
 *
 * Adequate for a single process. Behind more than one instance each replica
 * keeps its own counters, so the effective limit multiplies by the replica
 * count — move to a shared store (Redis) or an edge rate limiter before
 * scaling out.
 */
function createRateLimiter({ windowMs, max }: { windowMs: number; max: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  // Bound memory: drop expired buckets periodically.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }, windowMs);
  sweeper.unref?.();

  return function rateLimit(key: string): { allowed: boolean; retryAfter: number } {
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfter: 0 };
    }

    entry.count += 1;
    if (entry.count > max) {
      return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
    }
    return { allowed: true, retryAfter: 0 };
  };
}

const apiLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });
const pushLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

/** Trust the first proxy hop for client IP; adjust if behind more than one. */
function clientIp(req: express.Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  const isProduction = process.env.NODE_ENV === "production";

  // Express reports the client IP from X-Forwarded-For only when it trusts
  // the proxy. Without this, every request looks like it came from the load
  // balancer and the rate limiter collapses into one shared bucket.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  // --- Force HTTPS -------------------------------------------------------
  // Redirect before anything else so no handler ever sees a cleartext
  // request, and no cookie or token can be emitted over one.
  app.use((req, res, next) => {
    if (!isProduction) return next();
    const proto = req.headers["x-forwarded-proto"];
    if (proto && proto !== "https") {
      return res.redirect(308, `https://${req.headers.host}${req.originalUrl}`);
    }
    next();
  });

  // --- Security headers --------------------------------------------------
  app.use((req, res, next) => {
    if (isProduction) {
      // Two years, subdomains included, preload-eligible.
      res.setHeader(
        "Strict-Transport-Security",
        "max-age=63072000; includeSubDomains; preload"
      );
    }

    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader(
      "Permissions-Policy",
      "camera=(self), microphone=(self), geolocation=(), payment=(), usb=()"
    );
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("X-DNS-Prefetch-Control", "off");

    // CSP is the meaningful XSS control here. Because the Supabase client needs
    // a JS-readable access token to authorise PostgREST reads, an HttpOnly
    // cookie cannot protect the session — keeping injected script off the page
    // is what protects it instead. See SECURITY.md.
    //
    // The Supabase origins below are load-bearing, not optional. Without them
    // the browser refuses every auth, database, storage and realtime request
    // before it leaves the page, and JavaScript sees only a bare
    // `TypeError: Failed to fetch` with no status and no error code — which
    // looks identical to being offline. Adding them was missed when the app was
    // converted off Firebase, and the whole auth page failed closed as a result.
    //
    // Dev needs unsafe-inline/unsafe-eval for Vite HMR; production does not.
    const scriptSrc = isProduction
      ? "'self' https://apis.google.com https://www.youtube.com https://s.ytimg.com"
      : "'self' 'unsafe-inline' 'unsafe-eval' https://apis.google.com https://www.youtube.com https://s.ytimg.com";

    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        `script-src ${scriptSrc}`,
        // Tailwind and motion set inline styles; style-src cannot be locked
        // down without a nonce pipeline.
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:",
        // Supabase Storage serves both public objects and signed URLs from the
        // project origin, so avatars, post images and voice notes all need it.
        [
          "img-src 'self' data: blob:",
          "https://*.supabase.co",
          "https://firebasestorage.googleapis.com",
          "https://*.googleusercontent.com",
          "https://img.youtube.com",
          "https://i.ytimg.com",
          // GIPHY serves GIFs from media0..media4.giphy.com and i.giphy.com
          // depending on the rendition.
          "https://*.giphy.com",
          // Leaflet map tiles. CartoDB's dark basemap, served from
          // a.. d.basemaps.cartocdn.com — no key, no billing.
          "https://*.basemaps.cartocdn.com",
        ].join(" "),
        [
          "media-src 'self' blob: data:",
          "https://*.supabase.co",
          "https://firebasestorage.googleapis.com",
        ].join(" "),
        [
          "connect-src 'self'",
          // Auth (GoTrue), database (PostgREST) and Storage.
          "https://*.supabase.co",
          // Realtime is a websocket and is NOT covered by the https entry —
          // omitting this leaves chat, notifications and live counters silently
          // dead while everything else works, which is a miserable thing to
          // debug.
          "wss://*.supabase.co",
          // Breached-password screening (k-anonymity; only a SHA-1 prefix is
          // sent). Still in use.
          "https://api.pwnedpasswords.com",
          // Google Fonts, for the SERVICE WORKER specifically.
          //
          // The page loads these through `@import` in index.css, which is
          // governed by style-src and font-src — both already allow them. But
          // once the worker intercepts those requests it re-issues them with
          // fetch(), and a worker's own fetches are checked against the
          // connect-src of the CSP served with the worker script. Without these
          // two entries the font caching routes fail closed and every font
          // request 404s from cache on a repeat visit.
          //
          // fonts.googleapis.com happens to be covered by the *.googleapis.com
          // wildcard below, but that entry is Firebase legacy and slated for
          // removal — naming it here means deleting that line later cannot
          // silently break fonts.
          "https://fonts.googleapis.com",
          "https://fonts.gstatic.com",
          // Firebase. Retained only because migrated rows can still hold
          // firebasestorage URLs until 04-migrate-storage.ts has run and the
          // data is cut over. The auth endpoints below are already dead — no
          // code calls them — and should be dropped once Firebase is
          // decommissioned. Left in place rather than removed here so this
          // change stays a fix and not an unreviewed tightening.
          "https://*.googleapis.com",
          "https://*.firebaseio.com",
          "wss://*.firebaseio.com",
          "https://identitytoolkit.googleapis.com",
          "https://securetoken.googleapis.com",
        ].join(" "),
        "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
        "worker-src 'self'",
        "manifest-src 'self'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        ...(isProduction ? ["upgrade-insecure-requests"] : []),
      ].join("; ")
    );

    next();
  });

  // Cap body size — the default is 100kb but being explicit prevents a
  // future change from opening a memory-exhaustion vector.
  app.use(express.json({ limit: "64kb" }));

  // --- API rate limiting -------------------------------------------------
  app.use("/api", (req, res, next) => {
    const { allowed, retryAfter } = apiLimiter(clientIp(req));
    if (!allowed) {
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ error: "Too many requests" });
    }
    next();
  });

  /**
   * Verifies the caller's Firebase ID token.
   *
   * Without this, /api/send-push accepted any `toUserId` from anyone on the
   * internet — an open relay for pushing arbitrary notification text to any
   * user of the app. The token is verified with the Admin SDK, so a forged
   * or expired one is rejected.
   */
  async function requireAuth(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    try {
      // checkRevoked catches tokens belonging to a session that was signed
      // out or whose password changed.
      const decoded = await admin.auth().verifyIdToken(token, true);
      (req as express.Request & { uid?: string }).uid = decoded.uid;
      next();
    } catch {
      // No detail in the response: the caller learns only that it failed.
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  /**
   * Verifies the caller's SUPABASE access token.
   *
   * Deliberately not requireAuth() above: that one calls
   * admin.auth().verifyIdToken(), a FIREBASE check. The client has sent a
   * Supabase token since the migration, so requireAuth rejects every real
   * request — see the note at the top of api/send-push.ts. Rather than leave
   * this new route depending on a check that cannot pass, it verifies against
   * the same service the client actually authenticates with.
   */
  async function requireSupabaseAuth(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    const url = process.env.VITE_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) {
      return res.status(503).json({ error: "Server is not configured" });
    }

    try {
      const { createClient } = await import("@supabase/supabase-js");
      const supa = createClient(url, serviceKey, { auth: { persistSession: false } });
      const { data, error } = await supa.auth.getUser(token);
      if (error || !data?.user) return res.status(401).json({ error: "Unauthorized" });
      (req as express.Request & { uid?: string }).uid = data.user.id;
      next();
    } catch {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  /**
   * GET /api/youtube-search — the dev-server twin of api/youtube-search.ts.
   *
   * npm run dev serves the app through this file, not through Vercel's
   * functions, so without this route song search only works in production.
   * Both share api/_youtube.ts so the behaviour cannot drift.
   */
  app.get("/api/youtube-search", requireSupabaseAuth, async (req, res) => {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
      console.error("YOUTUBE_API_KEY is not set — song search is disabled");
      return res.status(503).json({ error: "Song search is not configured" });
    }

    const q = typeof req.query.q === "string" ? req.query.q : "";
    if (q.trim().length < 2) return res.json({ tracks: [] });

    try {
      const { searchMusic, YouTubeSearchError } = await import("./api/_youtube");
      try {
        return res.json({ tracks: await searchMusic(q, apiKey) });
      } catch (err) {
        if (err instanceof YouTubeSearchError) {
          return res.status(err.status).json({ error: err.message });
        }
        throw err;
      }
    } catch (err) {
      console.error("youtube-search failed:", err);
      return res.status(502).json({ error: "Song search failed" });
    }
  });

  /**
   * GET /api/gif-search — the dev-server twin of api/gif-search.ts.
   *
   * npm run dev serves the app through this file, not through Vercel's
   * functions, so without this route GIF search only works in production.
   * Both share api/_giphy.ts so the behaviour cannot drift.
   */
  app.get("/api/gif-search", requireSupabaseAuth, async (req, res) => {
    const apiKey = process.env.GIPHY_API_KEY;
    if (!apiKey) {
      console.error("GIPHY_API_KEY is not set — GIF search is disabled");
      return res.status(503).json({ error: "GIF search is not configured" });
    }

    const q = typeof req.query.q === "string" ? req.query.q : "";

    try {
      const { searchGifs, GifSearchError } = await import("./api/_giphy");
      try {
        return res.json({ gifs: await searchGifs(q, apiKey) });
      } catch (err) {
        if (err instanceof GifSearchError) {
          return res.status(err.status).json({ error: err.message });
        }
        throw err;
      }
    } catch (err) {
      console.error("gif-search failed:", err);
      return res.status(502).json({ error: "GIF search failed" });
    }
  });

  /**
   * GET /api/geocode — the dev-server twin of api/geocode.ts.
   *
   * npm run dev serves the app through this file, not through Vercel's
   * functions, so without this route location search only works in
   * production. Both share api/_nominatim.ts — including its User-Agent and
   * its 1 request/second throttle — so the behaviour cannot drift.
   */
  app.get("/api/geocode", requireSupabaseAuth, async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";

    try {
      const { geocode, GeocodeError } = await import("./api/_nominatim");
      try {
        return res.json({ results: await geocode(q) });
      } catch (err) {
        if (err instanceof GeocodeError) {
          return res.status(err.status).json({ error: err.message });
        }
        throw err;
      }
    } catch (err) {
      console.error("geocode failed:", err);
      return res.status(502).json({ error: "Location search failed." });
    }
  });

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.post("/api/send-push", requireAuth, async (req, res) => {
    if (!pushEnabled) {
      return res.status(503).json({ error: "Push notifications are not configured" });
    }

    const senderUid = (req as express.Request & { uid?: string }).uid!;

    // Per-sender limit on top of the per-IP one, so a single authenticated
    // account can't fan out notification spam.
    const senderLimit = pushLimiter(`uid:${senderUid}`);
    if (!senderLimit.allowed) {
      res.setHeader("Retry-After", String(senderLimit.retryAfter));
      return res.status(429).json({ error: "Too many requests" });
    }

    const { toUserId, title, body, url } = req.body ?? {};

    // Validate types and bound lengths — these strings end up rendered in an
    // OS notification on someone else's device.
    const isSafeString = (v: unknown, max: number) =>
      typeof v === "string" && v.trim().length > 0 && v.length <= max;

    if (!isSafeString(toUserId, 128) || !isSafeString(title, 100) || !isSafeString(body, 500)) {
      return res.status(400).json({ error: "Invalid request" });
    }
    if (url !== undefined && (typeof url !== "string" || url.length > 300 || !url.startsWith("/"))) {
      // Only same-origin paths: an absolute URL here would let a caller
      // redirect a recipient anywhere from a trusted notification.
      return res.status(400).json({ error: "Invalid request" });
    }

    try {
      // Find subscriptions for this user
      const subscriptionsSnap = await db.collection("subscriptions")
        .where("userId", "==", toUserId)
        .get()
        .catch(err => {
          console.error("Firestore Query Error (PERMISSION_DENIED?):", err);
          throw err;
        });

      if (subscriptionsSnap.empty) {
        return res.json({ success: true, delivered: 0 });
      }

      const payload = JSON.stringify({ 
        title, 
        body, 
        url: url || "/"
      });

      const promises = subscriptionsSnap.docs.map(dDoc => {
        const sub = dDoc.data();
        // Construct the subscription object web-push expects
        const pushSub = {
          endpoint: sub.endpoint,
          keys: sub.keys
        };

        return webpush.sendNotification(pushSub, payload)
          .catch(async (err: any) => {
            if (err.statusCode === 404 || err.statusCode === 410) {
              // Subscription expired or no longer valid, delete it
              try {
                await dDoc.ref.delete();
              } catch (e) {
                console.error("Failed to delete expired subscription:", e);
              }
            } else {
              console.error("Push Error for endpoint:", sub.endpoint, err.message);
            }
          });
      });

      await Promise.all(promises);
      res.json({ success: true, delivered: subscriptionsSnap.size });
    } catch (error) {
      console.error("Server Push Error:", error);
      res.status(500).json({ error: "Failed to send push notification" });
    }
  });

  /**
   * Any /api/* request reaching this point matched no route above.
   *
   * Without it the request falls through to Vite's dev middleware, which
   * resolves the URL against the filesystem and returns the TRANSFORMED SOURCE
   * of api/youtube-search.ts with HTTP 200 — or, for a path with no matching
   * file, index.html. The client then calls res.json() on a JavaScript module
   * or an HTML page and reports a parse error, which says nothing at all about
   * the real problem: this process has no such route.
   *
   * That is precisely how a dev server left running from before a route was
   * added presents itself, and it cost a debugging session. A 404 says it in
   * one line. No secret leaked either way — Vite only substitutes what is in
   * `define`, so process.env references stay references — but server-side
   * source has no business being served over HTTP regardless.
   */
  app.use("/api", (req, res) => {
    res.status(404).json({
      error: "No such API route",
      path: req.originalUrl,
      hint: "If this route was added recently, restart the server.",
    });
  });

  // Vite integration
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Error starting server:", err);
  process.exit(1);
});
