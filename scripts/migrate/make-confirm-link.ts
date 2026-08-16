/**
 * Generates a fresh confirmation link and shows exactly where it redirects.
 *
 *   npx tsx scripts/migrate/make-confirm-link.ts <email> [redirectTo]
 *
 * Two jobs:
 *
 *  1. Diagnose the redirect. The link's `redirect_to` parameter is built by
 *     GoTrue from the Site URL (or from an allow-listed redirectTo). Printing
 *     it shows precisely what the dashboard is configured with — a bare
 *     `yapprr.vercel.app` with no scheme gets resolved as a RELATIVE path
 *     against the Supabase origin, producing
 *     `llgsamvklytdtgxumpzm.supabase.co/yapprr.vercel.app`, which is the
 *     malformed URL being reported.
 *
 *  2. Hand back a link that can be clicked immediately, with a full-length
 *     validity window rather than a three-hour-old one.
 *
 * Uses the admin API, so no email is sent and no SMTP quota is consumed.
 */

import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config();

const strip = (v?: string) => (v ?? '').trim().replace(/^['"]|['"]$/g, '');
const url = strip(process.env.VITE_SUPABASE_URL);
const serviceKey = strip(process.env.SUPABASE_SERVICE_ROLE_KEY);

const email = process.argv[2];
const redirectTo = process.argv[3] || 'https://yapprr.vercel.app';

if (!email) {
  console.log('usage: make-confirm-link.ts <email> [redirectTo]');
  process.exit(2);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

(async () => {
  console.log(`Confirmation link for ${email}\n`);

  const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const user = (list?.users ?? []).find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (!user) {
    console.log('  No such account.');
    process.exit(1);
  }
  console.log(`  id        : ${user.id}`);
  console.log(`  confirmed : ${user.email_confirmed_at ? user.email_confirmed_at : 'NO — needs confirming'}`);

  if (user.email_confirmed_at) {
    console.log('\n  Already confirmed; nothing to do. Sign in normally.');
    process.exit(0);
  }

  // `signup` regenerates the original confirmation link for an unconfirmed
  // account. `magiclink` is the fallback: it also marks the email confirmed on
  // first use, so it recovers the account either way.
  let link: string | undefined;
  let usedType = 'signup';

  const attempt = await admin.auth.admin.generateLink({
    type: 'signup',
    email,
    password: `Tmp-${Math.random().toString(36).slice(2)}-9aZ!`,
    options: { redirectTo },
  });

  if (attempt.error) {
    console.log(`\n  signup link failed (${attempt.error.message}); falling back to magiclink`);
    usedType = 'magiclink';
    const magic = await admin.auth.admin.generateLink({ type: 'magiclink', email, options: { redirectTo } });
    if (magic.error) {
      console.log(`  magiclink failed too: ${magic.error.message}`);
      process.exit(1);
    }
    link = magic.data.properties?.action_link;
  } else {
    link = attempt.data.properties?.action_link;
  }

  if (!link) {
    console.log('  No action_link returned.');
    process.exit(1);
  }

  // --- Diagnose the redirect --------------------------------------------------
  const parsed = new URL(link);
  const target = parsed.searchParams.get('redirect_to') ?? '(none)';

  console.log(`\n  link type   : ${usedType}`);
  console.log(`  link host   : ${parsed.host}`);
  console.log(`  redirect_to : ${target}`);

  console.log('\n  Redirect analysis:');
  if (target === '(none)') {
    console.log('    No redirect_to — GoTrue will fall back to the Site URL.');
  } else if (/^https?:\/\//i.test(target)) {
    console.log('    OK — absolute URL with a scheme. This will redirect correctly.');
    if (target.endsWith('/')) console.log('    NOTE: trailing slash present; harmless but tidier without.');
  } else {
    console.log('    *** MALFORMED — no scheme. ***');
    console.log('    A bare host is treated as a relative path, so the browser lands on');
    console.log(`    ${url}/${target} instead of the site.`);
    console.log('    Fix: Authentication → URL Configuration → Site URL must include https://');
  }

  console.log('\n  ── Click this ──\n');
  console.log(link);
  console.log('\n  Links expire (default 24h, and are single use). Generate another if it lapses.');
})();
