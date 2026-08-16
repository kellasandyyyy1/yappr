/**
 * Resolves Firebase project settings for the migration scripts.
 *
 * firebase-applet-config.json used to be the source and is no longer present
 * (it was removed from the repo — it contained an API key). Environment
 * variables are authoritative; the JSON file is honoured only if someone still
 * has a local copy.
 */

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

// Load .env.local first so `npx tsx scripts/...` picks up the same values the
// app uses, without needing them exported into the shell.
dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config();

interface FirebaseProjectConfig {
  projectId: string;
  storageBucket: string;
  firestoreDatabaseId: string;
}

function fromJsonFile(): Partial<FirebaseProjectConfig> {
  const file = path.join(process.cwd(), 'firebase-applet-config.json');
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function firebaseConfig(): FirebaseProjectConfig {
  const json = fromJsonFile();

  const projectId =
    process.env.VITE_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || json.projectId;
  const storageBucket =
    process.env.VITE_FIREBASE_STORAGE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET || json.storageBucket;
  const firestoreDatabaseId =
    process.env.VITE_FIREBASE_DATABASE_ID || process.env.FIREBASE_DATABASE_ID ||
    json.firestoreDatabaseId || '(default)';

  if (!projectId) {
    throw new Error(
      'Firebase project id not found. Set VITE_FIREBASE_PROJECT_ID in .env.local.'
    );
  }
  if (!storageBucket) {
    throw new Error(
      'Firebase storage bucket not found. Set VITE_FIREBASE_STORAGE_BUCKET in .env.local.'
    );
  }

  return { projectId, storageBucket, firestoreDatabaseId };
}

/**
 * Supabase credentials for the scripts.
 *
 * Accepts the unprefixed names already in .env.local as well as the VITE_
 * variants, so nothing has to be duplicated.
 */
export function supabaseConfig(): { url: string; serviceKey: string; anonKey: string } {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const anonKey =
    process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';

  if (!url) throw new Error('SUPABASE_URL is not set (checked .env.local and the shell).');
  if (!serviceKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not set.\n' +
      'Find it in Supabase → Project Settings → API → service_role.\n' +
      'It bypasses RLS — keep it out of the repo and never expose it to the browser.'
    );
  }
  return { url, serviceKey, anonKey };
}

/** Project URL and publishable key. Does not require the service role key,
 *  so read-only tooling can run without it. */
export function supabasePublicConfig(): { url: string; anonKey: string } {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
  if (!url) throw new Error('SUPABASE_URL is not set (checked .env.local and the shell).');
  return { url, anonKey };
}

/** Project ref parsed out of the URL, used for the staging safety check. */
export function projectRef(): string {
  const { url } = supabasePublicConfig();
  return url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1] ?? 'unknown';
}

/**
 * Refuses to run destructive test tooling against anything but the known
 * staging project. Override with ALLOW_PROJECT=<ref> when you genuinely mean
 * a different one.
 */
export const STAGING_REF = 'llgsamvklytdtgxumpzm';

export function assertStaging(): void {
  const ref = projectRef();
  const allowed = process.env.ALLOW_PROJECT || STAGING_REF;
  if (ref !== allowed) {
    throw new Error(
      `Refusing to run against project "${ref}".\n` +
      `This tool creates and deletes users. Expected staging ("${allowed}").\n` +
      `If you really mean it: ALLOW_PROJECT=${ref} npx tsx <script>`
    );
  }
}
