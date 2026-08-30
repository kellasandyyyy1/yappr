/// <reference types="vite/client" />
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase client — the replacement for src/lib/firebase.ts.
 *
 * Notable differences from the Firebase setup this replaces:
 *
 *  • Session storage. Firebase kept tokens in IndexedDB/localStorage where
 *    JavaScript could read them; Supabase does the same by default. Neither
 *    can use HttpOnly cookies while the browser talks to the database
 *    directly, so CSP remains the XSS control (see SECURITY.md). Setting
 *    `flowType: 'pkce'` at least removes the token from the redirect URL.
 *
 *  • Realtime. Firestore's onSnapshot attaches to a *query*; Supabase Realtime
 *    subscribes to table changes and you filter server-side. Filters are much
 *    more limited — see subscribeToConversation() in src/lib/db.ts for the
 *    shape that actually works.
 */

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set. ' +
    'Copy .env.example and fill in your project values.'
  );
}

if (import.meta.env.DEV) {
  // Printed once at import, before any auth call can fire, so a bad or stale
  // env var is visible without guessing. The key's value is never logged — only
  // its length and prefix, which are enough to tell a publishable key from a
  // legacy JWT from an accidentally-pasted secret key.
  const keyKind =
    SUPABASE_ANON_KEY.startsWith('sb_publishable_') ? 'publishable'
    : SUPABASE_ANON_KEY.startsWith('eyJ') ? 'legacy JWT anon'
    : SUPABASE_ANON_KEY.startsWith('sb_secret_') ? 'SECRET KEY — must never ship to a browser'
    : 'unrecognised';

  // Head and tail of the key, never the middle. Enough to spot a wrong project,
  // a truncation or a stray character — the exact failure this hit, where two
  // junk characters on the end made every request 401 "Invalid API key".
  const keyHead = SUPABASE_ANON_KEY.slice(0, 20);
  const keyTail = SUPABASE_ANON_KEY.slice(-10);

  console.info('[supabase] client config', {
    url: SUPABASE_URL,
    trailingSlash: SUPABASE_URL.endsWith('/'),
    keyKind,
    keyLength: SUPABASE_ANON_KEY.length,
    keyHead,
    keyTail,
    keyPreview: `${keyHead}…${keyTail}`,
    origin: window.location.origin,
    // If this says false you are looking at a cached production bundle, not
    // your source — see the dev cleanup in lib/pwa.ts.
    isDevBuild: import.meta.env.DEV,
  });

  const EXPECTED_URL = 'https://llgsamvklytdtgxumpzm.supabase.co';
  const EXPECTED_KEY_HEAD = 'sb_publishable_R7If';
  if (SUPABASE_URL !== EXPECTED_URL) {
    console.error('[supabase] URL MISMATCH — expected', EXPECTED_URL, 'got', SUPABASE_URL);
  }
  if (!SUPABASE_ANON_KEY.startsWith(EXPECTED_KEY_HEAD)) {
    console.error('[supabase] KEY MISMATCH — expected it to start', EXPECTED_KEY_HEAD, 'got', keyHead);
  }

  // Vite only reads .env* at startup. Editing one and hot-reloading leaves the
  // page running the values from boot, which looks exactly like a wrong value.
  // Compare what is printed above against .env.local; if they differ, restart.

  // A CSP-blocked request is invisible in the Network tab in some browsers, and
  // from JavaScript it is indistinguishable from an offline or DNS failure —
  // every one of them surfaces as a bare `TypeError: Failed to fetch` with no
  // status and no code. This listener names the directive and the blocked URI,
  // which turns that dead end into a one-line diagnosis.
  window.addEventListener('securitypolicyviolation', (event) => {
    console.error('[csp] BLOCKED — this is why a request "failed to fetch"', {
      blockedURI: event.blockedURI,
      violatedDirective: event.violatedDirective,
      effectiveDirective: event.effectiveDirective,
      originalPolicy: event.originalPolicy,
    });
  });
}

export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce',
  },
  realtime: {
    // Caps how fast the server will push; prevents a busy group chat from
    // saturating the connection.
    params: { eventsPerSecond: 10 },
  },
});

/** Current user id, or null. Equivalent to `auth.currentUser?.uid`. */
export async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

/**
 * Signed URL for a private-bucket object.
 *
 * Chat media lives in a private bucket (Firebase's unguessable download tokens
 * made those URLs secret-by-obscurity; a public bucket would be weaker). The
 * database stores `supabase://bucket/path` for these, which this resolves.
 */
export async function resolveStorageUrl(
  stored: string | null | undefined,
  expiresInSeconds = 3600
): Promise<string | null> {
  if (!stored) return null;
  if (!stored.startsWith('supabase://')) return stored; // already a public URL

  const withoutScheme = stored.slice('supabase://'.length);
  const slash = withoutScheme.indexOf('/');
  if (slash === -1) return null;

  const bucket = withoutScheme.slice(0, slash);
  const objectPath = withoutScheme.slice(slash + 1);

  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(objectPath, expiresInSeconds);

  if (error) {
    console.warn('[storage] could not sign URL', { bucket });
    return null;
  }
  return data.signedUrl;
}

/**
 * Turns a Storage failure into something a user and a developer can both act on.
 *
 * Storage errors are easy to misread. The SDK reports `status: 400` while the
 * body carries `statusCode: "403"`, and every distinct cause — no bucket, no
 * INSERT policy, file too large, disallowed MIME — arrives as a generic
 * StorageApiError. Callers were catching that and showing "Couldn't share your
 * post", which is true and useless.
 *
 * Storage RLS is a SEPARATE system from table RLS. Fixing policies on `posts`
 * does nothing for `storage.objects`, and that distinction is invisible from
 * the error text alone, so it is named here.
 */
export class UploadError extends Error {
  constructor(
    message: string,
    readonly bucket: string,
    readonly objectPath: string,
    readonly cause: unknown
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

function describeUploadFailure(bucket: string, error: any): string {
  const raw = String(error?.message ?? '');
  const code = error?.code ?? error?.statusCode ?? error?.status;

  if (/row-level security|Unauthorized|AccessDenied/i.test(raw)) {
    return `Uploads to "${bucket}" are not permitted for your account. The bucket exists but has no INSERT policy — Storage RLS is separate from table RLS. Apply supabase/migrations/0012_storage_policies.sql.`;
  }
  if (/Bucket not found|does not exist/i.test(raw)) {
    return `The "${bucket}" storage bucket does not exist. Run: npx tsx scripts/migrate/create-storage-buckets.ts`;
  }
  if (/exceeded the maximum allowed size|Payload too large|413/i.test(raw) || code === 413) {
    return `That file is too large for "${bucket}".`;
  }
  if (/mime type|not supported/i.test(raw)) {
    return `That file type is not allowed in "${bucket}".`;
  }
  if (/Duplicate|already exists/i.test(raw)) {
    return `An object already exists at that path in "${bucket}".`;
  }
  return `Upload to "${bucket}" failed: ${raw || 'unknown error'}`;
}

/**
 * The buckets this app writes to.
 *
 * Video lives in its own two buckets rather than in `posts`/`chat`: those cap
 * at 25MB and allow only image/* and audio/* MIME types, so a video upload is
 * rejected at the bucket before any policy is consulted. Verified against the
 * live project — see scripts/migrate/diagnose-video-readiness.ts.
 */
export type StorageBucket = 'avatars' | 'posts' | 'chat' | 'post-videos' | 'chat-videos';

/**
 * Buckets whose objects are NOT publicly readable. Reads of these go through
 * resolveStorageUrl(), which mints a short-lived signed URL.
 */
const PRIVATE_BUCKETS = new Set<StorageBucket>(['chat', 'chat-videos']);

/**
 * Uploads with progress.
 *
 * supabase-js's storage client exposes no progress callback, and for a 40MB
 * video that means a UI that sits still for a minute — the same failure mode
 * as the music player stuck on "Warming up". So this posts to the Storage REST
 * endpoint directly via XHR, which does report upload progress.
 *
 * Returns the same value uploadFile() would: a public URL, or the
 * `supabase://bucket/path` scheme form for a private bucket.
 */
export async function uploadFileWithProgress(
  bucket: StorageBucket,
  objectPath: string,
  file: Blob,
  onProgress?: (fraction: number) => void,
  contentType?: string
): Promise<string> {
  const resolvedType = contentType ?? (file as File).type ?? "application/octet-stream";

  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) {
    throw new UploadError("You are signed out. Sign in and try again.", bucket, objectPath, null);
  }

  const endpoint = `${SUPABASE_URL}/storage/v1/object/${bucket}/${objectPath}`;

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", endpoint, true);
    xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);
    xhr.setRequestHeader("apikey", SUPABASE_ANON_KEY);
    xhr.setRequestHeader("Content-Type", resolvedType);
    // Same semantics as the SDK's { upsert: true }.
    xhr.setRequestHeader("x-upsert", "true");

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let message = xhr.responseText;
      try { message = JSON.parse(xhr.responseText)?.message ?? message; } catch { /* not json */ }
      console.error("[storage] upload failed", {
        bucket, objectPath, contentType: resolvedType, sizeBytes: file.size,
        status: xhr.status, message,
      });
      reject(new UploadError(
        describeUploadFailure(bucket, { status: xhr.status, message }),
        bucket, objectPath, { status: xhr.status, message }
      ));
    };

    xhr.onerror = () => reject(new UploadError(
      `Upload to "${bucket}" failed: the network request did not complete.`,
      bucket, objectPath, null));
    xhr.onabort = () => reject(new UploadError("Upload cancelled.", bucket, objectPath, null));

    xhr.send(file);
  });

  onProgress?.(1);

  if (PRIVATE_BUCKETS.has(bucket)) return `supabase://${bucket}/${objectPath}`;
  return supabase.storage.from(bucket).getPublicUrl(objectPath).data.publicUrl;
}

/** Uploads a file and returns the value to store in the database. */
export async function uploadFile(
  bucket: StorageBucket,
  objectPath: string,
  file: Blob,
  contentType?: string
): Promise<string> {
  const resolvedType = contentType ?? (file as File).type ?? 'application/octet-stream';

  const { error } = await supabase.storage.from(bucket).upload(objectPath, file, {
    contentType: resolvedType,
    upsert: true,
  });

  if (error) {
    const anyError = error as any;
    // Everything the response carries, so the console never leaves you guessing
    // which of the four causes it was.
    console.error('[storage] upload failed', {
      bucket,
      objectPath,
      contentType: resolvedType,
      sizeBytes: file.size,
      name: anyError?.name,
      status: anyError?.status,
      statusCode: anyError?.statusCode,
      code: anyError?.code,
      message: anyError?.message,
    });
    throw new UploadError(describeUploadFailure(bucket, anyError), bucket, objectPath, error);
  }

  // Private buckets get the scheme form so reads go through resolveStorageUrl.
  if (PRIVATE_BUCKETS.has(bucket)) return `supabase://${bucket}/${objectPath}`;
  return supabase.storage.from(bucket).getPublicUrl(objectPath).data.publicUrl;
}
