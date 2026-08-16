/**
 * Validates the VAPID keypair in .env.local.
 *
 *   npm run verify:vapid
 *
 * Three things, none of which anything else checks:
 *
 *  1. Format — a P-256 VAPID public key is 65 raw bytes (87–88 base64url
 *     chars), the private key 32 bytes (43 chars).
 *
 *  2. **The two keys are actually a pair.** `webpush.setVapidDetails()` only
 *     validates each key's shape, not that the public one derives from the
 *     private one. A mismatched pair configures cleanly, sends without error,
 *     and is then rejected by every push service — the failure surfaces as
 *     "notifications just don't arrive", with nothing in the logs. This derives
 *     the public key from the private key and compares.
 *
 *  3. Freshness — that neither key matches one found in git history. This repo
 *     had its VAPID pair committed once already.
 *
 * Prints truncated fingerprints only, never key material.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';

const fp = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const b64urlToBuf = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const bufToB64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let failures = 0;
const pass = (l, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const fail = (l, d = '') => { console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures++; };

const env = {};
for (const raw of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const i = raw.indexOf('=');
  if (i > 0 && !raw.trimStart().startsWith('#')) {
    env[raw.slice(0, i).trim()] = raw.slice(i + 1).trim().replace(/^['"]/, '').replace(/['"]$/, '');
  }
}

const pub = env.VITE_VAPID_PUBLIC_KEY || '';
const priv = env.VAPID_PRIVATE_KEY || '';

console.log('VAPID keypair check\n');

if (!pub || !priv) {
  fail('both keys present', `public=${pub ? 'set' : 'MISSING'} private=${priv ? 'set' : 'MISSING'}`);
  process.exit(1);
}
pass('both keys present');
console.log(`        public  fingerprint ${fp(pub)}  (${pub.length} chars)`);
console.log(`        private fingerprint ${fp(priv)}  (${priv.length} chars)`);

// --- 1. Format ---------------------------------------------------------------
console.log('\nFormat:');
const pubBuf = b64urlToBuf(pub);
const privBuf = b64urlToBuf(priv);
pubBuf.length === 65 ? pass('public is 65 raw bytes') : fail('public is 65 raw bytes', `got ${pubBuf.length}`);
privBuf.length === 32 ? pass('private is 32 raw bytes') : fail('private is 32 raw bytes', `got ${privBuf.length}`);
pubBuf[0] === 0x04
  ? pass('public is an uncompressed EC point (0x04 prefix)')
  : fail('public is an uncompressed EC point', `first byte 0x${pubBuf[0]?.toString(16)}`);
/^[A-Za-z0-9_-]+$/.test(pub) && /^[A-Za-z0-9_-]+$/.test(priv)
  ? pass('both are base64url (no +, /, or = padding)')
  : fail('both are base64url', 'standard base64 will be rejected by the push service');

// --- 2. Do they actually pair? ------------------------------------------------
console.log('\nPairing:');
try {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(privBuf);
  const derived = bufToB64url(ecdh.getPublicKey());
  derived === pub
    ? pass('public key derives from the private key', 'genuine pair')
    : fail('public key derives from the private key',
        `derived fingerprint ${fp(derived)} ≠ configured ${fp(pub)} — MISMATCHED PAIR, push will silently fail`);
} catch (err) {
  fail('private key is a valid P-256 scalar', err.message);
}

// --- 3. Freshness --------------------------------------------------------------
console.log('\nFreshness:');
let hist = '';
try {
  hist = execSync('git log --all -p', { maxBuffer: 256 * 1024 * 1024 }).toString();
} catch {
  console.log('  SKIP  git history unavailable');
}
if (hist) {
  const leakedPriv = new Set([...hist.matchAll(/VAPID_PRIVATE_KEY[^\n]*?["']([A-Za-z0-9_-]{30,})["']/g)].map((m) => m[1]));
  const leakedPub = new Set([...hist.matchAll(/(B[A-Za-z0-9_-]{85,88})/g)].map((m) => m[1]));
  leakedPriv.has(priv)
    ? fail('private key is not one from git history', 'THIS IS THE LEAKED KEY — regenerate')
    : pass('private key does not appear in git history');
  leakedPub.has(pub)
    ? fail('public key is not one from git history', 'THIS IS THE LEAKED KEY — regenerate')
    : pass('public key does not appear in git history');
  console.log(`        (${leakedPriv.size} private / ${leakedPub.size} public key(s) found in history)`);
}

console.log('\n' + '─'.repeat(58));
console.log(failures === 0 ? 'VAPID OK — fresh, well-formed, genuine pair.' : `${failures} problem(s).`);
process.exit(failures === 0 ? 0 : 1);
