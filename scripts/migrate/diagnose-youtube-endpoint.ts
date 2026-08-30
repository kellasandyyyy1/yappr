/**
 * The /api/youtube-search HTTP path, end to end.
 *
 *   npx tsx scripts/migrate/diagnose-youtube-endpoint.ts        (dev, :3000)
 *   BASE=https://yapprr.vercel.app npx tsx scripts/migrate/diagnose-youtube-endpoint.ts
 *
 * test-youtube-search.ts already proves the API KEY works by calling the
 * search module directly. If the picker still shows nothing, the break is in
 * the HTTP path between the browser and that module — the route, the auth, the
 * env var as the *server process* sees it — and this is what walks that path
 * with a real signed-in token and prints the actual status and body.
 */

import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config();

const strip = (v?: string) => (v ?? '').trim().replace(/^['"]|['"]$/g, '');
const BASE = strip(process.env.BASE) || 'http://localhost:3000';
const url = strip(process.env.VITE_SUPABASE_URL);
const anonKey = strip(process.env.VITE_SUPABASE_ANON_KEY);
const serviceKey = strip(process.env.SUPABASE_SERVICE_ROLE_KEY);

const show = async (label: string, res: Response) => {
  const text = await res.text();
  let body = text;
  try { body = JSON.stringify(JSON.parse(text)); } catch { /* not json */ }
  console.log(`  ${res.status}  ${label}`);
  console.log(`         ${body.slice(0, 300)}`);
  return { status: res.status, text };
};

(async () => {
  console.log(`Endpoint: ${BASE}\n`);

  // --- 1. Is anything listening? ---------------------------------------------
  console.log('1. /api/health — what the SERVER PROCESS can see');
  try {
    await show('GET /api/health', await fetch(`${BASE}/api/health`));
  } catch (err) {
    console.log(`   UNREACHABLE — ${(err as Error).message}`);
    console.log(`   Start it with: npm run dev   (or set BASE=<deployed url>)`);
    process.exit(1);
  }

  // --- 2. Unauthenticated ----------------------------------------------------
  console.log('\n2. Without a token (expect 401)');
  await show('GET /api/youtube-search?q=daft+punk', await fetch(`${BASE}/api/youtube-search?q=daft+punk`));

  // --- 3. Authenticated ------------------------------------------------------
  console.log('\n3. With a real signed-in token');
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const stamp = Date.now();
  const email = `yt-${stamp}@privy-test.invalid`;
  const password = 'Corr3ct-Horse-Battery-9!';
  let userId = '';

  try {
    const { data, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
      user_metadata: { username: `yt${stamp}`.slice(0, 30), display_name: 'YT probe' },
    });
    if (error || !data.user) throw new Error(error?.message);
    userId = data.user.id;

    const client = createClient(url, anonKey, { auth: { persistSession: false } });
    const { data: session, error: signInErr } = await client.auth.signInWithPassword({ email, password });
    if (signInErr || !session.session) throw new Error(signInErr?.message);

    const res = await fetch(`${BASE}/api/youtube-search?q=daft%20punk%20one%20more%20time`, {
      headers: { Authorization: `Bearer ${session.session.access_token}` },
    });
    const { status, text } = await show('GET /api/youtube-search (authed)', res);

    console.log('\n' + '─'.repeat(60));
    if (status === 200) {
      const n = JSON.parse(text)?.tracks?.length ?? 0;
      console.log(n > 0 ? `ENDPOINT OK — ${n} tracks` : 'ENDPOINT reachable but returned 0 tracks');
    } else if (status === 503) {
      console.log('503 — the SERVER process has no YOUTUBE_API_KEY.');
      console.log('  In dev: server.ts loads .env.local, so restart it after adding the key.');
      console.log('  On Vercel: add YOUTUBE_API_KEY in Project Settings → Environment Variables,');
      console.log('  then REDEPLOY — env changes do not apply to an existing deployment.');
    } else if (status === 404) {
      console.log('404 — the route is not registered on this server.');
      console.log('  A deployed build made before api/youtube-search.ts existed will do this.');
    } else if (status === 401) {
      console.log('401 — the token was rejected.');
    } else {
      console.log(`${status} — see the body above.`);
    }
  } catch (err) {
    console.log(`  harness: ${(err as Error).message}`);
  } finally {
    if (userId) await admin.auth.admin.deleteUser(userId).catch(() => {});
  }
})();
