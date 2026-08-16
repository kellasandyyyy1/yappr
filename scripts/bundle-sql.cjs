/** Regenerates supabase/ALL_MIGRATIONS.sql from the migration files. */
const fs = require('fs');
const path = require('path');

module.exports = function bundle() {
  const dir = 'supabase/migrations';
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  const header = [
    '-- ============================================================================',
    '-- Yappr — complete schema, generated for one-shot execution.',
    '--',
    '-- GENERATED FILE. Do not edit. Source of truth is supabase/migrations/*.sql;',
    '-- regenerate with:  npm run db:bundle',
    '--',
    '-- HOW TO APPLY (no CLI login or database password needed):',
    '--   1. Supabase Dashboard → your project → SQL Editor → New query',
    '--   2. Paste this entire file',
    '--   3. Run',
    '--',
    '-- Wrapped in a transaction: if any statement fails, nothing is applied and',
    '-- the project is left exactly as it was.',
    '--',
    '-- Concatenated in order: ' + files.join(', '),
    '-- Generated: ' + new Date().toISOString().slice(0, 10),
    '-- ============================================================================',
    '',
    'begin;',
    '',
  ].join('\n');

  /**
   * Strips a migration's own transaction control.
   *
   * Individual migrations may wrap themselves in begin/commit so they are safe
   * to apply standalone. Concatenating them verbatim would nest a transaction
   * inside the bundle's own wrapper — the inner `commit` ends the outer
   * transaction early, so everything before it is committed even if a later
   * statement fails. That destroys the all-or-nothing property that makes
   * pasting this file safe in the first place.
   *
   * Only exact `begin;` / `commit;` at column 0 are removed:
   *   • plpgsql opens a block with `begin` and NO semicolon, so bodies are safe
   *   • `end;` is deliberately NOT stripped — it terminates plpgsql blocks and
   *     appears at column 0 in every function here. Removing it would corrupt
   *     all of them.
   */
  const stripTransactionControl = (sql) =>
    sql.split('\n').filter((line) => !/^(begin|commit);\s*$/i.test(line)).join('\n');

  const body = files.map((f) => [
    '', '-- ' + '='.repeat(74), '-- SOURCE: ' + f, '-- ' + '='.repeat(74), '',
    stripTransactionControl(fs.readFileSync(path.join(dir, f), 'utf8')).trim(),
  ].join('\n')).join('\n\n');

  fs.writeFileSync('supabase/ALL_MIGRATIONS.sql', header + body + '\n\ncommit;\n');
  console.log(`wrote supabase/ALL_MIGRATIONS.sql from ${files.length} migrations`);
};

if (require.main === module) module.exports();
