/**
 * Location search and its history, end to end.
 *
 *   npx tsx scripts/migrate/test-location-search.ts
 *
 * Hits Nominatim for real, because the things worth checking are exactly the
 * ones a mock would paper over: whether their policy accepts our User-Agent,
 * whether a partial query returns anything usable, and whether the throttle
 * actually spaces requests out.
 *
 * Deliberately sparing with live calls — the policy allows 1/second for the
 * whole application, and a test suite is not a licence to ignore that.
 */

import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { geocode, GeocodeError } from '../../api/_nominatim';

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

(async () => {
  console.log(`Location search on ${url}\n`);
  const created: string[] = [];

  try {
    // --- 1. Live geocoding ---------------------------------------------------
    console.log('1. Nominatim (live)');

    let results: Awaited<ReturnType<typeof geocode>> = [];
    try {
      // A whole word, not a prefix. Nominatim is a GEOCODER, not an
      // autocomplete engine, and prefix matching is unreliable: probed
      // directly, "edinbur" returns 0 and "edinburgh" returns 2, while
      // "lond" happens to return 2. Asserting on a prefix would make this
      // test fail for a limitation of the service rather than a fault in the
      // code. The behaviour is checked explicitly further down instead.
      results = await geocode('edinburgh', 5);
      results.length > 0
        ? ok('a place search returns results', `${results.length} for "edinburgh"`)
        : bad('a place search returns results', '0 — the query matched nothing');
    } catch (err) {
      err instanceof GeocodeError && err.status === 429
        ? bad('a place search returns results', `throttled: ${err.message}`)
        : bad('a place search returns results', String(err));
    }

    if (results.length) {
      const first = results[0];
      console.log(`\n     first result: "${first.name}" — ${first.context.slice(0, 60)}`);
      Number.isFinite(first.latitude) && Number.isFinite(first.longitude)
        ? ok('coordinates are numbers', `${first.latitude}, ${first.longitude}`)
        : bad('coordinates are numbers', `${first.latitude}, ${first.longitude}`);
      Math.abs(first.latitude) <= 90 && Math.abs(first.longitude) <= 180
        ? ok('coordinates are in range')
        : bad('coordinates are in range');
      first.name ? ok('has a short name for the first line', first.name) : bad('has a short name');
      first.label ? ok('has a full label to store on history') : bad('has a full label');
      // Edinburgh is ~55.95 N, ~3.19 W. A prefix search should land near it.
      Math.abs(first.latitude - 55.95) < 1.5 && Math.abs(first.longitude + 3.19) < 1.5
        ? ok('the result is actually Edinburgh', `${first.latitude.toFixed(2)}, ${first.longitude.toFixed(2)}`)
        : bad('the result is actually Edinburgh', `${first.latitude}, ${first.longitude}`);
    }

    // --- 2. Guards -----------------------------------------------------------
    console.log('\n2. Guards');
    (await geocode('ed', 5)).length === 0
      ? ok('a 2-character query spends no request')
      : bad('a 2-character query spends no request');

    // Must repeat the SAME query as the live one above — a different string is
    // a different cache key, and "edinbur" was measuring a cache miss.
    const t0 = Date.now();
    await geocode('edinburgh', 5);
    const cached = Date.now() - t0;
    cached < 50
      ? ok('a repeat query is served from cache', `${cached}ms — no request to Nominatim`)
      : bad('a repeat query is served from cache', `${cached}ms — the cache is not being hit`);

    // The throttle has to actually space calls out, or the policy is breached
    // by the second keystroke.
    const t1 = Date.now();
    await geocode('glasgow', 3);
    await geocode('aberdeen', 3);
    const spacing = Date.now() - t1;
    spacing >= 1000
      ? ok('two fresh queries are spaced >= 1s apart', `${spacing}ms`)
      : bad('two fresh queries are spaced >= 1s apart', `${spacing}ms — the 1/sec policy is being breached`);

    // Documents the limitation rather than hiding it: a partial word is not
    // reliably matched, which is why the UI says "no matches yet" instead of
    // "no such place". Reported, never failed — it is the service behaving as
    // designed, and if it ever DOES start matching prefixes that is worth
    // knowing too.
    console.log('\n   Prefix behaviour (reported, not asserted):');
    for (const prefix of ['edinbur', 'lond']) {
      try {
        const partial = await geocode(prefix, 3);
        console.log(`     "${prefix}" -> ${partial.length} result(s)`);
      } catch (err) {
        console.log(`     "${prefix}" -> ${String(err)}`);
      }
    }
    console.log('     Nominatim has no autocomplete endpoint. Photon (photon.komoot.io)');
    console.log('     is the OSM-family service built for prefix search, also free.');

    // --- 3. History ----------------------------------------------------------
    console.log('\n3. Search history');
    const stamp = Date.now();
    const mk = async (name: string) => {
      const email = `geo-${name}-${stamp}@privy-test.invalid`;
      const password = 'Corr3ct-Horse-Battery-9!';
      const { data, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { username: `geo${name}${stamp}`.slice(0, 30).toLowerCase(), display_name: name },
      });
      if (error || !data.user) throw new Error(`${name}: ${error?.message}`);
      created.push(data.user.id);
      const client = createClient(url, anonKey, { auth: { persistSession: false } });
      await client.auth.signInWithPassword({ email, password });
      return { id: data.user.id, client, name };
    };

    const alice = await mk('alice');
    const bob = await mk('bob');

    const record = (who: typeof alice, q: string, lat: number, lng: number) =>
      who.client.from('location_search_history').upsert(
        {
          user_id: who.id,
          query_text: q,
          latitude: lat,
          longitude: lng,
          label: `${q} label`,
          searched_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,query_text' }
      );

    const { error: firstErr } = await record(alice, 'edinburgh', 55.95, -3.19);
    firstErr ? bad('record a search', `${firstErr.code} ${firstErr.message}`) : ok('record a search');

    // The dedupe is the point: the same search twice is one row, refreshed.
    await new Promise((r) => setTimeout(r, 1100));
    const { error: dupErr } = await record(alice, 'edinburgh', 55.95, -3.19);
    dupErr ? bad('the same search again upserts', `${dupErr.code} ${dupErr.message}`) : ok('the same search again upserts');

    const { data: rows } = await alice.client
      .from('location_search_history')
      .select('id, query_text, searched_at, latitude')
      .eq('user_id', alice.id);
    rows?.length === 1
      ? ok('it is one row, not two', 'deduped on (user_id, query_text)')
      : bad('it is one row, not two', `${rows?.length} rows`);

    await record(alice, 'glasgow', 55.86, -4.25);
    const { data: ordered } = await alice.client
      .from('location_search_history')
      .select('query_text')
      .eq('user_id', alice.id)
      .order('searched_at', { ascending: false });
    ordered?.[0]?.query_text === 'glasgow'
      ? ok('most recent comes first', ordered.map((r: any) => r.query_text).join(', '))
      : bad('most recent comes first', JSON.stringify(ordered));

    // --- 4. It is private ----------------------------------------------------
    console.log('\n4. History is private');
    const { data: bobSees } = await bob.client
      .from('location_search_history').select('id').eq('user_id', alice.id);
    (bobSees ?? []).length === 0
      ? ok("bob cannot read alice's history")
      : bad("bob cannot read alice's history", `${bobSees?.length} row(s)`);

    const { data: bobAll } = await bob.client.from('location_search_history').select('id');
    (bobAll ?? []).length === 0
      ? ok('an unfiltered select returns only your own', '0 rows for bob')
      : bad('an unfiltered select returns only your own', `${bobAll?.length} row(s)`);

    const { error: spoofErr } = await bob.client
      .from('location_search_history')
      .insert({ user_id: alice.id, query_text: 'planted', latitude: 0, longitude: 0 });
    spoofErr
      ? ok('bob cannot write into her history', spoofErr.code)
      : bad('bob cannot write into her history', 'the insert succeeded');

    const { error: bobEditErr } = await bob.client
      .from('location_search_history')
      .update({ query_text: 'hijacked' })
      .eq('user_id', alice.id)
      .select('id');
    const { data: afterEdit } = await admin
      .from('location_search_history').select('query_text').eq('user_id', alice.id);
    (afterEdit ?? []).every((r: any) => r.query_text !== 'hijacked')
      ? ok('bob cannot edit her history', bobEditErr ? bobEditErr.code : 'update matched no rows')
      : bad('bob cannot edit her history', 'a row was changed');
  } catch (err) {
    bad('harness', (err as Error).message);
  } finally {
    for (const id of created) await admin.auth.admin.deleteUser(id).catch(() => {});
    console.log(`\n  teardown: ${created.length} account(s) removed`);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(failures === 0 ? 'LOCATION SEARCH OK' : `${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
})();
