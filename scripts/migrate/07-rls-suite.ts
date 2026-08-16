/**
 * Step 6b — RLS behaviour suite against the live staging project.
 *
 *   npx tsx scripts/migrate/07-rls-suite.ts
 *
 * This is the check PGlite could not perform. Locally there is no `auth.uid()`
 * and no JWT, so policies were only parsed. Here three real users are created,
 * signed in through GoTrue, and every request is made with that user's actual
 * access token — so the policies execute exactly as they will in the app.
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
const surprises: string[] = [];

function ok(label: string, detail = '') {
  passed++;
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}
function bad(label: string, detail: string) {
  failures.push(`${label} — ${detail}`);
  console.log(`  FAIL  ${label} — ${detail}`);
}
/** Divergence between what PGlite implied and what the live policies do. */
function note(message: string) {
  surprises.push(message);
  console.log(`  NOTE  ${message}`);
}

/** Asserts a read returned nothing (RLS filters rather than errors on SELECT). */
async function expectNoRows(label: string, query: PromiseLike<{ data: unknown[] | null; error: unknown }>) {
  const { data, error } = await query;
  if (error) { ok(label, 'denied with an error'); return; }
  if ((data?.length ?? 0) === 0) { ok(label, 'filtered to 0 rows'); return; }
  bad(label, `LEAKED ${data!.length} row(s)`);
}

async function expectRows(label: string, query: PromiseLike<{ data: unknown[] | null; error: any }>) {
  const { data, error } = await query;
  if (error) { bad(label, `unexpectedly denied: ${error.message}`); return; }
  if ((data?.length ?? 0) === 0) { bad(label, 'returned 0 rows but should have data'); return; }
  ok(label, `${data!.length} row(s)`);
}

async function expectWriteAllowed(label: string, query: PromiseLike<{ error: any }>) {
  const { error } = await query;
  if (error) bad(label, `unexpectedly denied: ${error.message}`);
  else ok(label);
}

async function expectWriteDenied(label: string, query: PromiseLike<{ data: unknown; error: any }>) {
  const { data, error } = await query;
  if (error) { ok(label, `denied (${error.code ?? 'error'})`); return; }
  // An UPDATE/DELETE filtered to zero rows by RLS succeeds silently — that is
  // still a denial, just a quiet one.
  if (Array.isArray(data) && data.length === 0) { ok(label, 'affected 0 rows'); return; }
  bad(label, 'WRITE SUCCEEDED but should have been blocked');
}

// --- Test actors -------------------------------------------------------------

const STAMP = Date.now();
const PASSWORD = `Rls-Suite-${STAMP}-xQ7`;

interface Actor {
  name: string;
  id: string;
  email: string;
  username: string;
  client: SupabaseClient;
}

const created: string[] = [];
/**
 * Conversations must be tracked separately. `conversations.created_by` is
 * ON DELETE SET NULL, not CASCADE — deleting the test users orphans the
 * threads rather than removing them, so each run would leave junk behind.
 */
const createdConversations: string[] = [];

async function makeActor(name: string): Promise<Actor> {
  const email = `rls-${name}-${STAMP}@privy-test.invalid`;
  const username = `rls_${name}_${STAMP}`.slice(0, 30).toLowerCase();

  const { data, error } = await admin.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser(${name}): ${error?.message}`);
  created.push(data.user.id);

  // Profile row via service role — signup normally does this transactionally.
  const { error: profileError } = await admin.from('users').insert({
    id: data.user.id, username, display_name: name, email,
  });
  if (profileError) throw new Error(`profile(${name}): ${profileError.message}`);

  // A client bound to this user's real access token.
  const client = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (signInError) throw new Error(`signIn(${name}): ${signInError.message}`);

  return { name, id: data.user.id, email, username, client };
}

async function teardown() {
  console.log('\nTearing down test data…');

  // Conversations FIRST, and explicitly. Deleting the auth users does not
  // remove them: conversations.created_by is ON DELETE SET NULL, so the thread
  // survives with a null owner and every run leaves orphans behind. Messages,
  // members, receipts and reactions all cascade from the conversation.
  let convsRemoved = 0;
  for (const id of createdConversations) {
    const { error } = await admin.from('conversations').delete().eq('id', id);
    if (error) console.log(`  could not delete conversation ${id.slice(0, 8)}: ${error.message}`);
    else convsRemoved++;
  }
  if (createdConversations.length > 0) {
    console.log(`  removed ${convsRemoved}/${createdConversations.length} conversation(s)`);
  }

  for (const id of created) {
    // Deleting the auth user cascades through public.users into everything else.
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) console.log(`  could not delete ${id}: ${error.message}`);
  }
  console.log(`  removed ${created.length} test user(s)`);
}

// --- The suite ---------------------------------------------------------------

async function run() {
  console.log(`RLS behaviour suite against "${projectRef()}"\n`);
  console.log('Creating test users…');
  const alice = await makeActor('alice');
  const bob = await makeActor('bob');
  const carol = await makeActor('carol');
  console.log(`  alice ${alice.id.slice(0, 8)} · bob ${bob.id.slice(0, 8)} · carol ${carol.id.slice(0, 8)}\n`);

  // === Own data ==============================================================
  console.log('Own data:');

  await expectRows('alice reads her own profile',
    alice.client.from('users').select('id, username').eq('id', alice.id));

  await expectWriteAllowed('alice updates her own display_name',
    alice.client.from('users').update({ display_name: 'Alice Updated' }).eq('id', alice.id));

  await expectWriteDenied("alice CANNOT update bob's profile",
    alice.client.from('users').update({ display_name: 'hacked' }).eq('id', bob.id).select());

  // === Post visibility =======================================================
  console.log('\nPost visibility:');

  const mkPost = async (actor: Actor, visibility: string, content: string) => {
    const { data, error } = await actor.client.from('posts')
      .insert({ user_id: actor.id, content, visibility }).select('id').single();
    if (error) throw new Error(`create ${visibility} post: ${error.message}`);
    return data.id as string;
  };

  const publicPost = await mkPost(alice, 'public', 'alice public');
  const privatePost = await mkPost(alice, 'private', 'alice private');
  const followersPost = await mkPost(alice, 'followers', 'alice followers-only');

  await expectRows('alice reads her own private post',
    alice.client.from('posts').select('id').eq('id', privatePost));

  await expectRows("bob reads alice's PUBLIC post",
    bob.client.from('posts').select('id').eq('id', publicPost));

  // ── The headline check ──
  await expectNoRows("bob CANNOT read alice's PRIVATE post",
    bob.client.from('posts').select('id').eq('id', privatePost));

  await expectNoRows("bob CANNOT read alice's FOLLOWERS-ONLY post (not following)",
    bob.client.from('posts').select('id').eq('id', followersPost));

  await expectWriteAllowed('bob follows alice',
    bob.client.from('follows').insert({ follower_id: bob.id, following_id: alice.id }));

  await expectRows('bob CAN read the followers-only post after following',
    bob.client.from('posts').select('id').eq('id', followersPost));

  // Writing to a post you cannot read. No read access is gained, but it lets a
  // stranger attach content to a private post and inflate its counters.
  // Regression guard for 0005.
  await expectWriteDenied('carol CANNOT like a post she cannot see',
    carol.client.from('likes').insert({ post_id: privatePost, user_id: carol.id }).select());

  await expectWriteDenied('carol CANNOT comment on a post she cannot see',
    carol.client.from('comments')
      .insert({ post_id: privatePost, user_id: carol.id, content: 'intruder' }).select());

  await expectWriteDenied('carol CANNOT react to a post she cannot see',
    carol.client.from('post_reactions')
      .insert({ post_id: privatePost, user_id: carol.id, emoji: '🔥' }).select());

  await expectWriteDenied("bob CANNOT edit alice's post",
    bob.client.from('posts').update({ content: 'defaced' }).eq('id', publicPost).select());

  await expectWriteDenied("bob CANNOT delete alice's post",
    bob.client.from('posts').delete().eq('id', publicPost).select());

  // === Counter tampering — the column-grant fix ==============================
  console.log('\nCounter integrity:');

  const { error: counterError } = await alice.client.from('posts')
    .update({ likes_count: 9999 }).eq('id', publicPost);
  if (counterError) {
    ok('owner CANNOT write likes_count directly', `denied (${counterError.code ?? 'error'})`);
  } else {
    const { data: check } = await admin.from('posts').select('likes_count').eq('id', publicPost).single();
    if (check?.likes_count === 9999) {
      bad('owner CANNOT write likes_count directly', 'counter was overwritten — column grant not applied');
    } else {
      ok('owner CANNOT write likes_count directly', 'value unchanged');
    }
  }

  await expectWriteAllowed('bob likes the public post',
    bob.client.from('likes').insert({ post_id: publicPost, user_id: bob.id }));

  const { data: counted } = await admin.from('posts').select('likes_count').eq('id', publicPost).single();
  if (counted?.likes_count === 1) ok('likes_count trigger fired live', 'count = 1');
  else bad('likes_count trigger fired live', `expected 1, got ${counted?.likes_count}`);

  await expectWriteDenied('bob CANNOT like on behalf of carol',
    bob.client.from('likes').insert({ post_id: publicPost, user_id: carol.id }).select());

  // === Direct conversations ==================================================
  console.log('\nDirect messages:');

  // Also exercises the is_conversation_creator() fix — without it, neither the
  // RETURNING select nor adding the second member is permitted.
  const { data: convRow, error: convError } = await alice.client.from('conversations')
    .insert({ type: 'direct', created_by: alice.id }).select('id').single();

  if (convError || !convRow) {
    bad('alice creates a direct conversation', convError?.message ?? 'no row returned');
    note('Conversation creation failed live — is_conversation_creator() may not have applied.');
  } else {
    ok('alice creates a direct conversation');
    const convId = convRow.id as string;
    createdConversations.push(convId);

    await expectWriteAllowed('alice adds herself as a member',
      alice.client.from('conversation_members').insert({ conversation_id: convId, user_id: alice.id }));

    await expectWriteAllowed('alice adds bob (creator privilege)',
      alice.client.from('conversation_members').insert({ conversation_id: convId, user_id: bob.id }));

    const { data: msgRow, error: msgError } = await alice.client.from('messages')
      .insert({ conversation_id: convId, sender_id: alice.id, content: 'private hello' })
      .select('id').single();
    if (msgError) bad('alice sends a message', msgError.message);
    else ok('alice sends a message');

    await expectRows('bob (member) reads the message',
      bob.client.from('messages').select('id, content').eq('conversation_id', convId));

    // ── The headline check ──
    await expectNoRows("carol CANNOT read a DM she is not part of",
      carol.client.from('messages').select('id, content').eq('conversation_id', convId));

    await expectNoRows('carol CANNOT see the conversation itself',
      carol.client.from('conversations').select('id').eq('id', convId));

    await expectNoRows('carol CANNOT enumerate its members',
      carol.client.from('conversation_members').select('user_id').eq('conversation_id', convId));

    await expectWriteDenied('carol CANNOT inject a message into it',
      carol.client.from('messages')
        .insert({ conversation_id: convId, sender_id: carol.id, content: 'intruder' }).select());

    // Privilege escalation: a bare `user_id = auth.uid()` insert policy let a
    // stranger join any thread and read all of it. Regression guard for 0005.
    await expectWriteDenied('carol CANNOT add herself to it',
      carol.client.from('conversation_members')
        .insert({ conversation_id: convId, user_id: carol.id }).select());

    await expectWriteDenied('carol CANNOT add a third party to it',
      carol.client.from('conversation_members')
        .insert({ conversation_id: convId, user_id: bob.id }).select());

    // Guard against over-correcting: an existing member must still be able to
    // add someone, which is what the app's group flow relies on.
    await expectWriteAllowed('bob (existing member) CAN add carol',
      bob.client.from('conversation_members')
        .insert({ conversation_id: convId, user_id: carol.id }));

    await expectWriteAllowed('carol (now a member) can be removed again',
      admin.from('conversation_members')
        .delete().eq('conversation_id', convId).eq('user_id', carol.id));

    if (msgRow) {
      await expectWriteDenied("bob CANNOT mark carol's receipt as read",
        bob.client.from('message_receipts')
          .update({ read_at: new Date().toISOString() })
          .eq('message_id', msgRow.id).eq('user_id', carol.id).select());
    }
  }

  // === Groups ================================================================
  console.log('\nGroups:');

  const { data: groupRow, error: groupError } = await alice.client.from('conversations')
    .insert({ type: 'group', name: 'RLS Test Group', created_by: alice.id }).select('id').single();

  if (groupError || !groupRow) {
    bad('alice creates a group', groupError?.message ?? 'no row');
  } else {
    ok('alice creates a group');
    const groupId = groupRow.id as string;
    createdConversations.push(groupId);

    await expectWriteAllowed('alice joins as admin',
      alice.client.from('conversation_members')
        .insert({ conversation_id: groupId, user_id: alice.id, role: 'admin' }));

    await expectWriteAllowed('alice adds bob to the group',
      alice.client.from('conversation_members')
        .insert({ conversation_id: groupId, user_id: bob.id, role: 'member' }));

    await expectWriteAllowed('bob posts in the group',
      bob.client.from('messages')
        .insert({ conversation_id: groupId, sender_id: bob.id, content: 'group hello' }));

    // ── The headline check ──
    await expectNoRows('carol CANNOT read messages in a group she is not in',
      carol.client.from('messages').select('id, content').eq('conversation_id', groupId));

    await expectWriteDenied('carol CANNOT rename the group',
      carol.client.from('conversations').update({ name: 'hijacked' }).eq('id', groupId).select());

    await expectWriteDenied('bob (non-admin) CANNOT rename the group',
      bob.client.from('conversations').update({ name: 'bob was here' }).eq('id', groupId).select());
  }

  // === Security events =======================================================
  console.log('\nSecurity event log:');

  await expectWriteAllowed('alice records her own security event',
    alice.client.from('security_events')
      .insert({ user_id: alice.id, type: 'sign_in', device_id: 'test-device' }));

  await expectNoRows("bob CANNOT read alice's security events",
    bob.client.from('security_events').select('id').eq('user_id', alice.id));

  await expectWriteDenied('alice CANNOT delete her own security event (append-only)',
    alice.client.from('security_events').delete().eq('user_id', alice.id).select());

  await expectWriteDenied('alice CANNOT forge an event for bob',
    alice.client.from('security_events')
      .insert({ user_id: bob.id, type: 'sign_in', device_id: 'forged' }).select());

  // === Private tables ========================================================
  console.log('\nPrivate tables:');

  await expectWriteAllowed('alice writes her own push subscription',
    alice.client.from('push_subscriptions').insert({
      user_id: alice.id, endpoint: `https://push.test/${STAMP}`, p256dh: 'k', auth: 'a',
    }));

  await expectNoRows("bob CANNOT read alice's push subscriptions",
    bob.client.from('push_subscriptions').select('id').eq('user_id', alice.id));

  await expectNoRows("bob CANNOT read alice's music history",
    bob.client.from('music_history').select('id').eq('user_id', alice.id));

  await expectNoRows('nobody can read migration_issues',
    alice.client.from('migration_issues').select('id'));

  // === Cascades, verified live ===============================================
  console.log('\nCascade deletes (live):');

  const cascadePost = await mkPost(alice, 'public', 'cascade target');
  await admin.from('post_images').insert({ post_id: cascadePost, position: 0, url: 'https://x/c.jpg' });
  await admin.from('comments').insert({ post_id: cascadePost, user_id: bob.id, content: 'doomed' });
  await admin.from('likes').insert({ post_id: cascadePost, user_id: bob.id });
  await admin.from('post_reactions').insert({ post_id: cascadePost, user_id: bob.id, emoji: '🔥' });

  await expectWriteAllowed('alice deletes her post',
    alice.client.from('posts').delete().eq('id', cascadePost));

  const orphanCounts = await Promise.all([
    admin.from('post_images').select('*', { count: 'exact', head: true }).eq('post_id', cascadePost),
    admin.from('comments').select('*', { count: 'exact', head: true }).eq('post_id', cascadePost),
    admin.from('likes').select('*', { count: 'exact', head: true }).eq('post_id', cascadePost),
    admin.from('post_reactions').select('*', { count: 'exact', head: true }).eq('post_id', cascadePost),
  ]);
  const orphans = orphanCounts.reduce((n, r) => n + (r.count ?? 0), 0);
  if (orphans === 0) ok('post delete cascaded', 'no orphaned images/comments/likes/reactions');
  else bad('post delete cascaded', `${orphans} orphaned row(s) remain`);

  // User cascade — carol is expendable.
  const carolPost = await mkPost(carol, 'public', 'carol post');
  await admin.from('comments').insert({ post_id: carolPost, user_id: carol.id, content: 'carol comment' });

  const { error: deleteUserError } = await admin.auth.admin.deleteUser(carol.id);
  if (deleteUserError) {
    bad('user delete cascaded', deleteUserError.message);
  } else {
    created.splice(created.indexOf(carol.id), 1); // already gone
    const after = await Promise.all([
      admin.from('users').select('*', { count: 'exact', head: true }).eq('id', carol.id),
      admin.from('posts').select('*', { count: 'exact', head: true }).eq('user_id', carol.id),
      admin.from('comments').select('*', { count: 'exact', head: true }).eq('user_id', carol.id),
    ]);
    const leftovers = after.reduce((n, r) => n + (r.count ?? 0), 0);
    if (leftovers === 0) ok('user delete cascaded', 'profile, posts and comments all removed');
    else bad('user delete cascaded', `${leftovers} row(s) survived`);
  }

  // === Anonymous access ======================================================
  console.log('\nUnauthenticated access:');
  const anon = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  for (const table of ['users', 'posts', 'messages', 'conversations', 'security_events']) {
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

  if (surprises.length > 0) {
    console.log('\nDivergence from the local PGlite check:');
    for (const s of surprises) console.log(`  • ${s}`);
  }

  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  ✗ ${f}`);
    console.log('\nRLS SUITE FAILED — do not proceed to the frontend conversion.');
    process.exit(1);
  }
  console.log('\nRLS SUITE PASSED — policies enforce correctly with real JWTs.');
}

main();
