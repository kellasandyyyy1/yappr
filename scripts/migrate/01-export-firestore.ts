/**
 * Step 1 — Export everything out of Firebase.
 *
 *   npx tsx scripts/migrate/01-export-firestore.ts
 *
 * Requires GOOGLE_APPLICATION_CREDENTIALS pointing at a service account key
 * with Firestore read + Firebase Auth admin access.
 *
 * Read-only: this script never writes to Firebase. Output lands in
 * migration-data/firestore/ as one JSON file per collection.
 */

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import path from 'node:path';
import { ensureDirs, writeJson, RAW_DIR, IssueLog, DATA_DIR } from './shared';
import { firebaseConfig } from './config';

const config = firebaseConfig();

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error(
    'GOOGLE_APPLICATION_CREDENTIALS is not set.\n' +
    'Create a service account key in the Firebase console\n' +
    '(Project settings → Service accounts → Generate new private key)\n' +
    'and point the variable at the downloaded JSON file.'
  );
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: config.projectId,
});

// Named-database form. `admin.firestore()` only ever returns the default
// database, which would silently export an empty project here.
const db = getFirestore(admin.app(), config.firestoreDatabaseId || '(default)');

const issues = new IssueLog();

/** Top-level collections and the subcollections to walk beneath each doc. */
const PLAN: { name: string; subcollections?: string[] }[] = [
  { name: 'users', subcollections: ['securityEvents'] },
  { name: 'posts', subcollections: ['comments'] },
  { name: 'chats', subcollections: ['messages', 'typing'] },
  { name: 'likes' },
  { name: 'follows' },
  { name: 'notifications' },
  { name: 'musicHistory' },
  { name: 'subscriptions' },
  // Legacy top-level collection. Nothing in the current app writes here, but
  // PostDetailModal reads it — see MIGRATION.md. Exported so we can prove it
  // is empty rather than assume it.
  { name: 'comments' },
];

interface ExportedDoc {
  id: string;
  path: string;
  data: Record<string, unknown>;
  subcollections?: Record<string, ExportedDoc[]>;
}

async function exportCollection(
  name: string,
  subcollections: string[] = []
): Promise<ExportedDoc[]> {
  const docs: ExportedDoc[] = [];
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  const PAGE = 500;

  // Paginated so a large collection does not have to fit in one response.
  for (;;) {
    let query = db.collection(name).orderBy(admin.firestore.FieldPath.documentId()).limit(PAGE);
    if (cursor) query = query.startAfter(cursor);

    const snap = await query.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      const record: ExportedDoc = {
        id: doc.id,
        path: doc.ref.path,
        data: doc.data() as Record<string, unknown>,
      };

      if (subcollections.length > 0) {
        record.subcollections = {};
        for (const sub of subcollections) {
          const subSnap = await doc.ref.collection(sub).get();
          record.subcollections[sub] = subSnap.docs.map((s) => ({
            id: s.id,
            path: s.ref.path,
            data: s.data() as Record<string, unknown>,
          }));
        }
      }

      docs.push(record);
    }

    cursor = snap.docs[snap.docs.length - 1];
    if (snap.size < PAGE) break;
    process.stdout.write(`\r  ${name}: ${docs.length} documents…`);
  }

  return docs;
}

/**
 * Firebase Auth users.
 *
 * `passwordHash` and `passwordSalt` are only populated when the export is run
 * with the Admin SDK against a project using the default scrypt hasher, and
 * even then they are useless to Supabase — see MIGRATION.md. We export the
 * identity fields only and deliberately do NOT persist hash material to disk:
 * writing password hashes into a JSON file in the repo working directory is a
 * far larger risk than the zero benefit of having them.
 */
async function exportAuthUsers() {
  const users: {
    uid: string;
    email: string | undefined;
    emailVerified: boolean;
    displayName: string | undefined;
    photoURL: string | undefined;
    disabled: boolean;
    createdAt: string | undefined;
    lastSignInAt: string | undefined;
    providers: string[];
    hasPassword: boolean;
  }[] = [];

  let pageToken: string | undefined;
  do {
    const page = await admin.auth().listUsers(1000, pageToken);
    for (const u of page.users) {
      if (!u.email) {
        issues.warn(
          `auth/${u.uid}`,
          'Auth user has no email address; cannot be recreated in Supabase',
          { uid: u.uid, providers: u.providerData.map((p) => p.providerId) }
        );
      }
      users.push({
        uid: u.uid,
        email: u.email,
        emailVerified: u.emailVerified,
        displayName: u.displayName,
        photoURL: u.photoURL,
        disabled: u.disabled,
        createdAt: u.metadata.creationTime,
        lastSignInAt: u.metadata.lastSignInTime,
        providers: u.providerData.map((p) => p.providerId),
        hasPassword: !!u.passwordHash,
      });
    }
    pageToken = page.pageToken;
  } while (pageToken);

  return users;
}

async function main() {
  ensureDirs();
  console.log(`Exporting from project "${config.projectId}"`);
  console.log(`Database: ${config.firestoreDatabaseId || '(default)'}\n`);

  const counts: Record<string, number> = {};

  for (const { name, subcollections } of PLAN) {
    try {
      const docs = await exportCollection(name, subcollections);
      writeJson(path.join(RAW_DIR, `${name}.json`), docs);
      counts[name] = docs.length;

      let subTotal = 0;
      for (const doc of docs) {
        for (const list of Object.values(doc.subcollections ?? {})) subTotal += list.length;
      }
      process.stdout.write('\r');
      console.log(
        `  ${name.padEnd(16)} ${String(docs.length).padStart(6)} docs` +
        (subTotal ? `  (+${subTotal} in subcollections)` : '')
      );
    } catch (err) {
      issues.error(name, `Failed to export collection: ${(err as Error).message}`);
      console.log(`  ${name.padEnd(16)} FAILED — ${(err as Error).message}`);
    }
  }

  console.log('\nExporting Firebase Auth users…');
  const authUsers = await exportAuthUsers();
  writeJson(path.join(RAW_DIR, 'auth-users.json'), authUsers);
  counts['auth-users'] = authUsers.length;
  console.log(`  auth-users       ${String(authUsers.length).padStart(6)} users`);

  const withPassword = authUsers.filter((u) => u.hasPassword).length;
  const federatedOnly = authUsers.filter((u) => !u.hasPassword).length;
  console.log(`    ${withPassword} with a password, ${federatedOnly} without`);

  writeJson(path.join(DATA_DIR, 'export-manifest.json'), {
    exportedAt: new Date().toISOString(),
    projectId: config.projectId,
    databaseId: config.firestoreDatabaseId || '(default)',
    counts,
  });

  console.log('\nIssues:');
  issues.report('export');
  issues.save(path.join(DATA_DIR, 'issues-export.json'));

  console.log(`\nWrote ${Object.keys(counts).length} files to ${RAW_DIR}`);
}

main().catch((err) => {
  console.error('\nExport failed:', err);
  process.exit(1);
});
