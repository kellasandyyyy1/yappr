/**
 * Step 3 — Create Supabase Auth users, then import all rows.
 *
 *   npx tsx scripts/migrate/03-import-supabase.ts [--dry-run]
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * ── PASSWORDS DO NOT MIGRATE ─────────────────────────────────────────────────
 * Firebase hashes with a modified scrypt using project-scoped parameters
 * (signer key, salt separator, rounds, memory cost). Supabase Auth (GoTrue)
 * verifies bcrypt and argon2 only. There is no import path and no way to
 * convert one to the other — a hash cannot be "translated" without the
 * plaintext.
 *
 * Users are therefore created WITHOUT a password. Nobody can sign in with
 * their old credentials, and the app must route them through a reset. That is
 * implemented in src/lib/auth-migration.ts. This is a real, unavoidable
 * user-visible consequence of the migration, not an oversight.
 */

import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseConfig } from './config';
import { readJson, writeJson, OUT_DIR, RAW_DIR, DATA_DIR, IssueLog, chunk } from './shared';

const DRY_RUN = process.argv.includes('--dry-run');

// Reads .env.local as well as the shell, and accepts the unprefixed names
// already present there. Throws with instructions if the service key is absent.
const { url: SUPABASE_URL, serviceKey: SERVICE_KEY } = supabaseConfig();

const supabase: SupabaseClient = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const issues = new IssueLog();

/**
 * Insert order matters: a child row cannot reference a parent that does not
 * exist yet. This is the topological order of the foreign keys.
 */
const IMPORT_ORDER = [
  'songs',
  'users',
  'follows',
  'posts',
  'post_images',
  'post_edits',
  'likes',
  'comments',           // self-FK resolved in a second pass
  'post_reactions',
  'comment_reactions',
  'conversations',
  'conversation_members',
  'messages',           // self-FK resolved in a second pass
  'message_receipts',
  'message_reactions',
  'notifications',
  'music_history',
  'push_subscriptions',
  'security_events',
] as const;

/** Tables with a self-referencing FK: insert without it, then patch. */
const SELF_REFERENCING: Record<string, string> = {
  comments: 'reply_to_id',
  messages: 'reply_to_id',
};

const BATCH = 500;

async function createAuthUsers(): Promise<Map<string, string>> {
  interface UserRow { id: string; firebase_uid: string; email: string; display_name: string }
  const users = readJson<UserRow[]>(path.join(OUT_DIR, 'users.json'));
  const mapping = new Map<string, string>();

  console.log(`\nCreating ${users.length} Supabase Auth users…`);
  let created = 0, existing = 0, failed = 0;

  for (const user of users) {
    if (DRY_RUN) { mapping.set(user.firebase_uid, user.id); continue; }

    // Pre-seeding the id with the deterministic UUID from the transform keeps
    // auth.users.id and public.users.id aligned, so every FK computed offline
    // stays valid.
    const { data, error } = await supabase.auth.admin.createUser({
      id: user.id,
      email: user.email,
      email_confirm: true,        // they were verified in Firebase
      password: undefined,        // no password — see the header comment
      user_metadata: {
        firebase_uid: user.firebase_uid,
        display_name: user.display_name,
        migrated_at: new Date().toISOString(),
        requires_password_reset: true,
      },
    });

    if (error) {
      if (/already.*registered|already exists|duplicate/i.test(error.message)) {
        // Re-run of the import: adopt the existing account rather than failing.
        const { data: found } = await supabase.auth.admin.listUsers({ perPage: 1000 });
        const match = (found?.users ?? []).find(
          (u: { id: string; email?: string }) => u.email?.toLowerCase() === user.email
        );
        if (match) { mapping.set(user.firebase_uid, match.id); existing++; continue; }
      }
      issues.error(`auth/${user.firebase_uid}`, `Could not create auth user: ${error.message}`,
        { email: user.email }, 'auth.users');
      failed++;
      continue;
    }

    mapping.set(user.firebase_uid, data.user!.id);
    created++;
    if ((created + existing) % 25 === 0) {
      process.stdout.write(`\r  ${created} created, ${existing} already present…`);
    }
  }

  process.stdout.write('\r');
  console.log(`  created: ${created}   already present: ${existing}   failed: ${failed}`);

  if (failed > 0) {
    console.log('  Failed users are listed in issues-import.json — their rows will be skipped.');
  }
  return mapping;
}

async function importTable(table: string): Promise<{ inserted: number; failed: number }> {
  const rows = readJson<Record<string, unknown>[]>(path.join(OUT_DIR, `${table}.json`));
  if (rows.length === 0) return { inserted: 0, failed: 0 };

  const selfRefColumn = SELF_REFERENCING[table];
  const payload = rows.map((row) => {
    const copy = { ...row };
    // Strip undefined so Postgres applies its own defaults.
    for (const key of Object.keys(copy)) if (copy[key] === undefined) delete copy[key];
    if (selfRefColumn) copy[selfRefColumn] = null;
    return copy;
  });

  let inserted = 0, failed = 0;

  for (const batch of chunk(payload, BATCH)) {
    if (DRY_RUN) { inserted += batch.length; continue; }

    const { error } = await supabase.from(table).insert(batch);
    if (!error) { inserted += batch.length; continue; }

    // A batch failure hides which row was at fault, so retry individually to
    // isolate the bad records instead of losing the whole batch.
    for (const row of batch) {
      const { error: rowError } = await supabase.from(table).insert(row);
      if (rowError) {
        issues.error(`${table}/${row.firebase_id ?? JSON.stringify(row).slice(0, 80)}`,
          `Insert rejected: ${rowError.message}`, row, table);
        failed++;
      } else inserted++;
    }
  }

  return { inserted, failed };
}

/** Second pass for reply chains, once every row in the table exists. */
async function patchSelfReferences(table: string, column: string): Promise<number> {
  const rows = readJson<Record<string, any>[]>(path.join(OUT_DIR, `${table}.json`));
  const withRef = rows.filter((r) => r[column]);
  if (withRef.length === 0 || DRY_RUN) return withRef.length;

  let patched = 0;
  for (const row of withRef) {
    const { error } = await supabase.from(table).update({ [column]: row[column] }).eq('id', row.id);
    if (error) {
      issues.warn(`${table}/${row.id}`, `Could not set ${column}: ${error.message}`, null, table);
    } else patched++;
  }
  return patched;
}

async function main() {
  console.log(`Importing into ${SUPABASE_URL}`);
  if (DRY_RUN) console.log('DRY RUN — nothing will be written.\n');

  const uidMapping = await createAuthUsers();
  writeJson(path.join(DATA_DIR, 'firebase-to-supabase-uid.json'), Object.fromEntries(uidMapping));

  console.log('\nImporting tables…');
  const summary: Record<string, { inserted: number; failed: number }> = {};

  for (const table of IMPORT_ORDER) {
    const result = await importTable(table);
    summary[table] = result;
    const flag = result.failed > 0 ? `  ${result.failed} FAILED` : '';
    console.log(`  ${table.padEnd(22)} ${String(result.inserted).padStart(7)} inserted${flag}`);
  }

  console.log('\nResolving reply chains…');
  for (const [table, column] of Object.entries(SELF_REFERENCING)) {
    const patched = await patchSelfReferences(table, column);
    console.log(`  ${table}.${column}: ${patched} linked`);
  }

  if (!DRY_RUN) {
    console.log('\nRecomputing denormalised counters from source rows…');
    const { error } = await supabase.rpc('recompute_counters');
    if (error) console.log(`  recompute_counters failed: ${error.message}`);
    else console.log('  done');
  }

  console.log('\nIssues:');
  issues.report('import');
  issues.save(path.join(DATA_DIR, 'issues-import.json'));

  // Mirror the issue log into the database so it is queryable alongside the data.
  if (!DRY_RUN && issues.all.length > 0) {
    await supabase.from('migration_issues').insert(
      issues.all.map((i) => ({
        source_path: i.sourcePath, target_table: i.targetTable,
        severity: i.severity, reason: i.reason, payload: i.payload ?? null,
      }))
    );
  }

  const totalFailed = Object.values(summary).reduce((n, s) => n + s.failed, 0);
  console.log(
    totalFailed === 0
      ? '\nAll rows imported. Run 05-verify.ts next.'
      : `\n${totalFailed} row(s) failed. Review issues-import.json — do NOT cut over yet.`
  );
}

main().catch((err) => { console.error('\nImport failed:', err); process.exit(1); });
