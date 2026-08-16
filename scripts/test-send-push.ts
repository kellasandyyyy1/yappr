/**
 * Executes api/send-push.ts for real, without Vercel.
 *
 *   npx tsx scripts/test-send-push.ts
 *
 * The handler is a plain function of (req, res), so it can be called directly
 * with stand-in objects. No `vercel dev`, no linked project, no deploy — which
 * matters, because this endpoint has now been silently broken twice in ways
 * that typechecked cleanly:
 *
 *   1. It verified a Firebase ID token after the client had moved to Supabase.
 *   2. It read subscriptions from Firestore after they had moved to Postgres.
 *
 * Both would have compiled and deployed happily and 401'd or 500'd in
 * production. This runs the actual authentication, validation and dispatch
 * paths against the live project.
 *
 * Creates one throwaway account and one fake push subscription, then removes
 * both.
 */

import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config();

const strip = (v?: string) => (v ?? '').trim().replace(/^['"]|['"]$/g, '');
const url = strip(process.env.VITE_SUPABASE_URL);
const anonKey = strip(process.env.VITE_SUPABASE_ANON_KEY);
const serviceKey = strip(process.env.SUPABASE_SERVICE_ROLE_KEY);

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

let failures = 0;
const ok = (l: string, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l: string, d = '') => { console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures++; };

/** Minimal stand-ins for Vercel's req/res. */
function makeReq(overrides: Record<string, unknown> = {}) {
  return { method: 'POST', headers: {}, body: {}, query: {}, cookies: {}, ...overrides } as any;
}
function makeRes() {
  const captured: { status: number; body: any; headers: Record<string, string> } = {
    status: 0, body: null, headers: {},
  };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(payload: any) { captured.body = payload; return res; },
    setHeader(k: string, v: string) { captured.headers[k] = String(v); return res; },
    end() { return res; },
  };
  return { res, captured };
}

async function call(handler: any, req: any) {
  const { res, captured } = makeRes();
  await handler(req, res);
  return captured;
}

(async () => {
  console.log(`Executing api/send-push.ts against ${url}\n`);

  const { default: handler } = await import('../api/send-push.js').catch(
    () => import('../api/send-push.ts' as string)
  );

  // --- Unauthenticated / malformed paths -------------------------------------
  console.log('Rejections:');

  let r = await call(handler, makeReq({ method: 'GET' }));
  r.status === 405 ? ok('GET is rejected', '405') : bad('GET is rejected', `got ${r.status}`);

  r = await call(handler, makeReq());
  r.status === 401 ? ok('no Authorization header', '401') : bad('no Authorization header', `got ${r.status} ${JSON.stringify(r.body)}`);

  r = await call(handler, makeReq({ headers: { authorization: 'Bearer not-a-real-token' } }));
  r.status === 401 ? ok('forged token', '401') : bad('forged token', `got ${r.status} ${JSON.stringify(r.body)}`);

  // --- A real signed-in caller ------------------------------------------------
  const stamp = Date.now();
  const email = `push-${stamp}@privy-test.invalid`;
  const username = `push${stamp}`.slice(0, 30);
  const password = 'Corr3ct-Horse-Battery-9!';

  const { data: made, error: makeErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { username, display_name: 'Push Test' },
  });
  if (makeErr || !made.user) { bad('create test user', makeErr?.message); process.exit(1); }
  const userId = made.user.id;

  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data: session, error: signInErr } = await client.auth.signInWithPassword({ email, password });
  if (signInErr || !session.session) { bad('sign in test user', signInErr?.message); process.exit(1); }
  const token = session.session.access_token;

  const auth = { authorization: `Bearer ${token}` };

  console.log('\nValidation (authenticated):');

  r = await call(handler, makeReq({ headers: auth, body: {} }));
  r.status === 400 ? ok('empty body', '400') : bad('empty body', `got ${r.status}`);

  r = await call(handler, makeReq({ headers: auth, body: { toUserId: userId, title: 'x', body: 'y', url: 'https://evil.example.com' } }));
  r.status === 400
    ? ok('absolute URL rejected', '400 — cannot redirect a recipient off-origin')
    : bad('absolute URL rejected', `got ${r.status}`);

  r = await call(handler, makeReq({ headers: auth, body: { toUserId: userId, title: 'x'.repeat(200), body: 'y' } }));
  r.status === 400 ? ok('over-long title rejected', '400') : bad('over-long title rejected', `got ${r.status}`);

  console.log('\nDispatch:');

  // No subscriptions yet.
  r = await call(handler, makeReq({ headers: auth, body: { toUserId: userId, title: 'Hello', body: 'World' } }));
  r.status === 200 && r.body?.delivered === 0
    ? ok('no subscriptions', 'delivered: 0')
    : bad('no subscriptions', `got ${r.status} ${JSON.stringify(r.body)}`);

  // Insert a syntactically valid but dead subscription. web-push will get a
  // 404/410 from FCM, which is exactly the prune path.
  const { error: subErr } = await admin.from('push_subscriptions').insert({
    user_id: userId,
    endpoint: `https://fcm.googleapis.com/fcm/send/dead-${stamp}`,
    p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
    auth: 'tBHItJI5svbpez7KI4CCXg',
  });
  subErr ? bad('insert test subscription', subErr.message) : ok('inserted a dead subscription');

  r = await call(handler, makeReq({ headers: auth, body: { toUserId: userId, title: 'Hello', body: 'World', url: '/feed' } }));
  console.log(`        response: ${r.status} ${JSON.stringify(r.body)}`);
  if (r.status === 200) {
    ok('dispatch completed without throwing');
    r.body?.pruned >= 1
      ? ok('expired subscription pruned', `pruned: ${r.body.pruned}`)
      : console.log(`  NOTE  nothing pruned — the push service may have accepted or soft-failed`);
  } else if (r.status === 503) {
    bad('dispatch', 'VAPID keys not configured in this environment');
  } else {
    bad('dispatch', `got ${r.status} ${JSON.stringify(r.body)}`);
  }

  const { count: left } = await admin
    .from('push_subscriptions').select('*', { count: 'exact', head: true }).eq('user_id', userId);
  console.log(`        subscriptions remaining for this user: ${left ?? 0}`);

  // --- Authorisation boundary ---------------------------------------------------
  console.log('\nAuthorisation:');
  r = await call(handler, makeReq({ headers: auth, body: { toUserId: '00000000-0000-4000-8000-000000000001', title: 'x', body: 'y' } }));
  r.status === 200 && r.body?.delivered === 0
    ? ok('sending to an unknown user is a no-op', 'delivered: 0, no error leaked')
    : bad('unknown recipient', `got ${r.status} ${JSON.stringify(r.body)}`);

  // --- Teardown -------------------------------------------------------------
  await admin.from('push_subscriptions').delete().eq('user_id', userId);
  await admin.auth.admin.deleteUser(userId);
  console.log('\n  teardown: test user and subscriptions removed');

  console.log('\n' + '─'.repeat(60));
  console.log(failures === 0 ? 'SEND-PUSH OK — handler executes correctly.' : `${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
})();
