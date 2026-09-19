/**
 * Notes & Reminders behaviour suite against the live project.
 *
 *   npx tsx scripts/migrate/08-notes-rls-suite.ts
 *   npm run test:notes
 *
 * This is the automated half of the feature's acceptance test. It creates two
 * real users, signs them in through GoTrue, and makes every request with that
 * user's actual access token — so the policies from 0025 execute exactly as
 * they will in the browser, with a real auth.uid() rather than a parse check.
 *
 * WHAT IT COVERS, against the brief:
 *   • create a notes space, invite a second account
 *   • confirm the invitee has NO access while pending
 *   • accept, confirm access is granted
 *   • add a note and a reminder, confirm BOTH members see both
 *   • confirm the due-reminder sweep notifies both members, exactly once
 *   • confirm completing syncs — one member ticks, the other reads it back
 *
 * WHAT IT DOES NOT COVER: the UI. Nothing here renders a component or drives a
 * browser. "Both accounts see it" is proven at the data layer, which is where
 * the sharing rules live; that two screens then draw it is a separate claim,
 * and the manual pass in the summary is what checks it.
 *
 * The reminder sweep is exercised by REPLICATING the query in
 * api/reminders-due.ts, not by calling the deployed route — the route needs a
 * CRON_SECRET and a deployment, and neither exists while developing. That
 * means this proves the sweep's SELECT and its once-only stamp; it does not
 * prove the route's auth check or its push dispatch.
 *
 * DESTRUCTIVE: creates and deletes users and their content. Guarded to the
 * staging project ref; override with ALLOW_PROJECT if you mean another.
 * Everything it creates is removed in the teardown, including on failure.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseConfig, projectRef, assertStaging } from './config';

assertStaging();

const { url, serviceKey, anonKey } = supabaseConfig();
if (!anonKey) {
  console.error('Anon key required (VITE_SUPABASE_ANON_KEY). RLS runs as a normal client.');
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// --- Assertion helpers -------------------------------------------------------

let passed = 0;
const failures: string[] = [];

function ok(label: string, detail = '') {
  passed++;
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}
function bad(label: string, detail: string) {
  failures.push(`${label} — ${detail}`);
  console.log(`  FAIL  ${label} — ${detail}`);
}

/** RLS filters SELECTs rather than erroring, so "no access" is zero rows. */
async function expectNoRows(label: string, query: PromiseLike<{ data: unknown[] | null; error: unknown }>) {
  const { data, error } = await query;
  if (error) { ok(label, 'denied with an error'); return; }
  if ((data?.length ?? 0) === 0) { ok(label, 'filtered to 0 rows'); return; }
  bad(label, `LEAKED ${data!.length} row(s)`);
}

async function expectRowCount(
  label: string,
  query: PromiseLike<{ data: unknown[] | null; error: any }>,
  expected: number
) {
  const { data, error } = await query;
  if (error) { bad(label, `unexpectedly denied: ${error.message}`); return; }
  const got = data?.length ?? 0;
  if (got === expected) { ok(label, `${got} row(s)`); return; }
  bad(label, `expected ${expected} row(s), got ${got}`);
}

async function expectWriteAllowed(label: string, query: PromiseLike<{ error: any }>) {
  const { error } = await query;
  if (error) bad(label, `unexpectedly denied: ${error.message}`);
  else ok(label);
}

async function expectWriteDenied(label: string, query: PromiseLike<{ data: unknown; error: any }>) {
  const { data, error } = await query;
  if (error) { ok(label, `denied (${error.code ?? 'error'})`); return; }
  // An INSERT/UPDATE/DELETE filtered to zero rows by RLS succeeds silently —
  // still a denial, just a quiet one.
  if (Array.isArray(data) && data.length === 0) { ok(label, 'affected 0 rows'); return; }
  bad(label, 'WRITE SUCCEEDED but should have been blocked');
}

function expectEqual(label: string, actual: unknown, expected: unknown) {
  if (actual === expected) ok(label, String(actual));
  else bad(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// --- Test actors -------------------------------------------------------------

const STAMP = Date.now();
const PASSWORD = `Notes-Suite-${STAMP}-xQ7`;

interface Actor {
  name: string;
  id: string;
  client: SupabaseClient;
}

const createdUsers: string[] = [];
/**
 * Note spaces are tracked separately for the same reason 07 tracks
 * conversations: note_spaces.created_by is ON DELETE CASCADE from users, so
 * deleting the owner does clear them — but a space created by a user whose
 * deletion fails would otherwise be left behind with no way to find it again.
 */
const createdSpaces: string[] = [];

async function makeActor(name: string): Promise<Actor> {
  const email = `notes-${name}-${STAMP}@privy-test.invalid`;
  const username = `notes_${name}_${STAMP}`.slice(0, 30).toLowerCase();

  const { data, error } = await admin.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser(${name}): ${error?.message}`);
  createdUsers.push(data.user.id);

  const { error: profileError } = await admin.from('users').insert({
    id: data.user.id, username, display_name: name, email,
  });
  if (profileError) throw new Error(`profile(${name}): ${profileError.message}`);

  const client = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (signInError) throw new Error(`signIn(${name}): ${signInError.message}`);

  return { name, id: data.user.id, client };
}

async function teardown() {
  console.log('\nTearing down test data…');

  for (const id of createdSpaces) {
    const { error } = await admin.from('note_spaces').delete().eq('id', id);
    if (error) console.log(`  could not delete space ${id.slice(0, 8)}: ${error.message}`);
  }
  if (createdSpaces.length > 0) console.log(`  removed ${createdSpaces.length} space(s)`);

  for (const id of createdUsers) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) console.log(`  could not delete ${id}: ${error.message}`);
  }
  console.log(`  removed ${createdUsers.length} test user(s)`);
}

/**
 * The due-reminder sweep, as api/reminders-due.ts performs it. Kept in step
 * with that file by hand — if the route's query changes and this does not,
 * this suite stops testing the thing that runs.
 */
async function runSweep(): Promise<{ due: number; notified: number }> {
  const { data: due, error } = await admin
    .from('notes')
    .select('id, space_id, content, due_date')
    .lte('due_date', new Date().toISOString())
    .eq('completed', false)
    .is('notified_at', null)
    .limit(100);
  if (error) throw new Error(`sweep select: ${error.message}`);
  if (!due?.length) return { due: 0, notified: 0 };

  const spaceIds = [...new Set(due.map((n) => n.space_id))];
  const { data: members, error: memberError } = await admin
    .from('note_space_members')
    .select('space_id, user_id')
    .in('space_id', spaceIds)
    .eq('status', 'accepted');
  if (memberError) throw new Error(`sweep members: ${memberError.message}`);

  const bySpace = new Map<string, string[]>();
  for (const m of members ?? []) {
    bySpace.set(m.space_id, [...(bySpace.get(m.space_id) ?? []), m.user_id]);
  }

  const rows = due.flatMap((note) =>
    (bySpace.get(note.space_id) ?? []).map((userId) => ({
      recipient_id: userId,
      actor_id: null,
      type: 'note_reminder',
      content: note.content,
      note_space_id: note.space_id,
      note_id: note.id,
    }))
  );

  if (rows.length) {
    const { error: insertError } = await admin.from('notifications').insert(rows);
    if (insertError) throw new Error(`sweep insert: ${insertError.message}`);
  }

  const { error: stampError } = await admin
    .from('notes')
    .update({ notified_at: new Date().toISOString() })
    .in('id', due.map((n) => n.id));
  if (stampError) throw new Error(`sweep stamp: ${stampError.message}`);

  return { due: due.length, notified: rows.length };
}

// --- The suite ---------------------------------------------------------------

async function run() {
  console.log(`Notes & Reminders suite against "${projectRef()}"\n`);
  console.log('Creating test users…');
  const owner = await makeActor('owner');
  const guest = await makeActor('guest');
  const stranger = await makeActor('stranger');

  // === 1. Create a space =====================================================
  console.log('\nCreating a notes space:');

  const { data: spaceRow, error: spaceError } = await owner.client
    .from('note_spaces')
    .insert({ name: `Suite space ${STAMP}`, created_by: owner.id })
    .select('id')
    .single();

  if (spaceError || !spaceRow) {
    bad('owner creates a notes space', spaceError?.message ?? 'no row returned');
    throw new Error('cannot continue without a space');
  }
  const spaceId = spaceRow.id as string;
  createdSpaces.push(spaceId);
  // The INSERT ... RETURNING case the created_by branch of
  // note_spaces_select_member exists for. If this line is reached, it worked.
  ok('owner creates a notes space (INSERT ... RETURNING)');

  await expectWriteAllowed(
    'owner inserts their own accepted membership',
    owner.client.from('note_space_members')
      .insert({ space_id: spaceId, user_id: owner.id, role: 'owner', status: 'accepted' })
  );

  // === 2. Invite, and confirm pending grants nothing =========================
  console.log('\nInvited but not accepted:');

  await expectWriteAllowed(
    'owner invites guest (pending)',
    owner.client.from('note_space_members')
      .insert({ space_id: spaceId, user_id: guest.id, role: 'member', status: 'pending' })
  );

  // Something to be denied access TO.
  const { data: seedNote, error: seedError } = await owner.client
    .from('notes')
    .insert({ space_id: spaceId, author_id: owner.id, content: 'Owner note before acceptance' })
    .select('id')
    .single();
  if (seedError || !seedNote) {
    bad('owner adds a note', seedError?.message ?? 'no row returned');
  } else {
    ok('owner adds a note (INSERT ... RETURNING)');
  }

  await expectNoRows(
    'pending guest CANNOT read notes',
    guest.client.from('notes').select('id').eq('space_id', spaceId)
  );

  await expectWriteDenied(
    'pending guest CANNOT write a note',
    guest.client.from('notes')
      .insert({ space_id: spaceId, author_id: guest.id, content: 'should not exist' })
      .select()
  );

  await expectRowCount(
    'pending guest sees ONLY their own membership row',
    guest.client.from('note_space_members').select('user_id').eq('space_id', spaceId),
    1
  );

  await expectRowCount(
    'pending guest CAN read the space name (to answer the invite)',
    guest.client.from('note_spaces').select('id, name').eq('id', spaceId),
    1
  );

  await expectWriteDenied(
    'pending guest CANNOT promote themselves to owner',
    guest.client.from('note_space_members')
      .update({ role: 'owner', status: 'accepted' })
      .eq('space_id', spaceId).eq('user_id', guest.id)
      .select()
  );

  // === 3. The stranger, who was never invited ================================
  console.log('\nNever invited:');

  await expectNoRows(
    'stranger CANNOT see the space',
    stranger.client.from('note_spaces').select('id').eq('id', spaceId)
  );
  await expectNoRows(
    'stranger CANNOT read notes',
    stranger.client.from('notes').select('id').eq('space_id', spaceId)
  );
  await expectWriteDenied(
    'stranger CANNOT invite themselves',
    stranger.client.from('note_space_members')
      .insert({ space_id: spaceId, user_id: stranger.id, status: 'accepted' })
      .select()
  );

  // === 4. Accept ==============================================================
  console.log('\nAfter accepting:');

  await expectWriteAllowed(
    'guest accepts their own invitation',
    guest.client.from('note_space_members')
      .update({ status: 'accepted' })
      .eq('space_id', spaceId).eq('user_id', guest.id)
  );

  await expectRowCount(
    'guest CAN now read the existing note',
    guest.client.from('notes').select('id').eq('space_id', spaceId),
    1
  );

  await expectRowCount(
    'guest CAN now see the full roster',
    guest.client.from('note_space_members').select('user_id').eq('space_id', spaceId),
    2
  );

  // === 5. A note and a reminder, both visible to both ========================
  console.log('\nNotes and reminders:');

  await expectWriteAllowed(
    'guest adds a plain note',
    guest.client.from('notes')
      .insert({ space_id: spaceId, author_id: guest.id, content: 'Guest plain note' })
  );

  // Already due, so the sweep picks it up on this run rather than in an hour.
  const dueAt = new Date(Date.now() - 60_000).toISOString();
  const { data: reminder, error: reminderError } = await owner.client
    .from('notes')
    .insert({
      space_id: spaceId, author_id: owner.id,
      content: 'Suite reminder', due_date: dueAt,
    })
    .select('id')
    .single();
  if (reminderError || !reminder) {
    bad('owner adds a reminder', reminderError?.message ?? 'no row returned');
    throw new Error('cannot continue without a reminder');
  }
  ok('owner adds a reminder with a due date');

  await expectRowCount(
    'owner sees all three',
    owner.client.from('notes').select('id').eq('space_id', spaceId),
    3
  );
  await expectRowCount(
    'guest sees all three',
    guest.client.from('notes').select('id').eq('space_id', spaceId),
    3
  );
  await expectNoRows(
    'stranger still sees none',
    stranger.client.from('notes').select('id').eq('space_id', spaceId)
  );

  // === 6. The due sweep ======================================================
  console.log('\nDue-reminder sweep:');

  const first = await runSweep();
  ok('sweep ran', `${first.due} due, ${first.notified} notification(s)`);

  const { data: ownerNotifs } = await admin
    .from('notifications')
    .select('id')
    .eq('note_id', reminder.id)
    .eq('recipient_id', owner.id);
  expectEqual('owner got exactly one reminder notification', ownerNotifs?.length ?? 0, 1);

  const { data: guestNotifs } = await admin
    .from('notifications')
    .select('id')
    .eq('note_id', reminder.id)
    .eq('recipient_id', guest.id);
  expectEqual('guest got exactly one reminder notification', guestNotifs?.length ?? 0, 1);

  // The once-only guarantee: notified_at is set, so a second sweep a minute
  // later must find nothing.
  const second = await runSweep();
  expectEqual('a second sweep re-notifies nobody', second.notified, 0);

  // Moving the due date re-arms it — the trigger clears notified_at, because a
  // reminder rescheduled to a new time has not been announced for that time.
  await expectWriteAllowed(
    'owner reschedules the reminder',
    owner.client.from('notes')
      .update({ due_date: new Date(Date.now() - 30_000).toISOString() })
      .eq('id', reminder.id)
  );
  const third = await runSweep();
  expectEqual('rescheduling re-arms the sweep', third.notified, 2);

  // === 7. Completing syncs ===================================================
  console.log('\nCompleting syncs across accounts:');

  await expectWriteAllowed(
    "guest completes the OWNER's reminder",
    guest.client.from('notes').update({ completed: true }).eq('id', reminder.id)
  );

  const { data: asOwner } = await owner.client
    .from('notes')
    .select('completed, author_id, updated_by')
    .eq('id', reminder.id)
    .single();

  expectEqual('owner reads it back as completed', asOwner?.completed, true);
  // The stamping trigger: the editor is recorded, and authorship is not
  // silently transferred to whoever touched it last.
  expectEqual('updated_by is the guest who ticked it', asOwner?.updated_by, guest.id);
  expectEqual('author is still the owner', asOwner?.author_id, owner.id);

  // A completed reminder is not swept again even though it is past due.
  await admin.from('notes').update({ notified_at: null }).eq('id', reminder.id);
  const fourth = await runSweep();
  expectEqual('a completed reminder is never swept', fourth.notified, 0);

  // === 8. Leaving ============================================================
  console.log('\nLeaving:');

  await expectWriteAllowed(
    'guest leaves the space',
    guest.client.from('note_space_members')
      .delete().eq('space_id', spaceId).eq('user_id', guest.id)
  );
  // Every one of these is about the note the guest wrote THEMSELVES. Authorship
  // is the thing that outlived membership in 0025, so it is the thing each
  // assertion here is aimed at — a check that only used someone else's note
  // would have passed against the broken policy.
  await expectNoRows(
    'guest CANNOT read notes after leaving (including their own)',
    guest.client.from('notes').select('id').eq('space_id', spaceId)
  );
  await expectNoRows(
    'guest CANNOT see the space after leaving',
    guest.client.from('note_spaces').select('id').eq('id', spaceId)
  );

  // The author's own note, found by the service role because the guest can no
  // longer see it to name it.
  const { data: guestNote } = await admin
    .from('notes').select('id').eq('space_id', spaceId).eq('author_id', guest.id).single();

  if (guestNote) {
    await expectWriteDenied(
      'guest CANNOT delete their own note after leaving',
      guest.client.from('notes').delete().eq('id', guestNote.id).select()
    );
    await expectWriteDenied(
      'guest CANNOT edit their own note after leaving',
      guest.client.from('notes').update({ content: 'edited from outside' }).eq('id', guestNote.id).select()
    );
    await expectWriteDenied(
      'guest CANNOT add a note after leaving',
      guest.client.from('notes')
        .insert({ space_id: spaceId, author_id: guest.id, content: 'back again' })
        .select()
    );
    // The note itself must survive their departure — leaving a shared list
    // does not retract what you contributed to it.
    const { data: still } = await admin.from('notes').select('id').eq('id', guestNote.id);
    expectEqual("the guest's note stays in the space", still?.length ?? 0, 1);
  } else {
    bad("guest's own note", 'not found — cannot test post-departure access');
  }

  // === 9. Categories (0027) ==================================================
  // The DATA half of the category feature. Which entries get a checkbox is a
  // pure function of the category (listStyleFor in src/lib/notes.ts) and is
  // decided in the browser, so the assertions here are the ones the database
  // is actually responsible for: the column accepts each value, defaults
  // safely, and does not disturb rows written before it existed.
  console.log('\nCategories:');

  const CATEGORIES = [
    'cooking', 'trip', 'date_ideas', 'movies', 'gifts', 'bucket_list', 'general',
  ] as const;

  for (const category of CATEGORIES) {
    const { data, error } = await owner.client
      .from('note_spaces')
      .insert({ name: `Suite ${category} ${STAMP}`, created_by: owner.id, category })
      .select('id, category')
      .single();

    if (error || !data) {
      bad(`owner creates a ${category} space`, error?.message ?? 'no row returned');
      continue;
    }
    createdSpaces.push(data.id);
    if (data.category === category) ok(`${category} space stores its category`);
    else bad(`${category} space stores its category`, `got ${JSON.stringify(data.category)}`);
  }

  // A space created the way every space was created before 0027 — no category
  // in the payload at all. This is the "existing spaces still work" case, and
  // it is answered by the column default rather than by a backfill.
  const { data: legacy, error: legacyError } = await owner.client
    .from('note_spaces')
    .insert({ name: `Suite legacy ${STAMP}`, created_by: owner.id })
    .select('id, category')
    .single();

  if (legacyError || !legacy) {
    bad('a space created without a category', legacyError?.message ?? 'no row returned');
  } else {
    createdSpaces.push(legacy.id);
    expectEqual("a space created without a category defaults to 'general'", legacy.category, 'general');
  }

  // The enum is a real constraint, not documentation.
  await expectWriteDenied(
    'an unknown category is rejected',
    owner.client.from('note_spaces')
      .insert({ name: `Suite bogus ${STAMP}`, created_by: owner.id, category: 'knitting' })
      .select()
  );

  // The original space predates every category insert above and was created
  // without one — so it must read back as 'general' too, which is the real
  // "no data migration needed" claim.
  const { data: original } = await owner.client
    .from('note_spaces').select('category').eq('id', spaceId).single();
  expectEqual('the suite\'s first space is still readable and general', original?.category, 'general');

  // === 10. Anonymous =========================================================
  console.log('\nUnauthenticated access:');
  const anon = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  for (const table of ['note_spaces', 'note_space_members', 'notes']) {
    await expectNoRows(`anon CANNOT read ${table}`, anon.from(table).select('*').limit(5));
  }
}

async function main() {
  try {
    await run();
  } catch (err) {
    console.error('\nSuite aborted:', (err as Error).message);
    failures.push(`suite aborted: ${(err as Error).message}`);
  } finally {
    await teardown();
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${passed} passed, ${failures.length} failed`);

  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  ✗ ${f}`);
    console.log('\nNOTES SUITE FAILED.');
    process.exit(1);
  }
  console.log('\nNOTES SUITE PASSED — invites gate access and reminders fire once.');
}

main();
