/**
 * Chat message clustering rules.
 *
 *   npx tsx scripts/migrate/test-message-clustering.ts
 *
 * Exercises src/lib/messageGroups.ts directly — the same functions ChatView
 * calls per message to decide where a run of messages starts and ends, which
 * drives the avatar, the sender name, the corner radii and the timestamp row.
 *
 * The interesting cases are the boundaries: exactly at the window, one
 * millisecond past it, a reply from the same sender, and a message still in
 * flight with no timestamp.
 */

import {
  messageTime,
  startsNewCluster,
  CLUSTER_WINDOW_MS,
} from '../../src/lib/messageGroups';

let failures = 0;
const ok = (l: string, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l: string, d = '') => { console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures++; };
const eq = (label: string, got: unknown, want: unknown) =>
  got === want ? ok(label, `${got}`) : bad(label, `got ${got}, want ${want}`);

const T0 = new Date('2026-08-18T10:00:00.000Z').getTime();
let seq = 0;
const msg = (senderId: string, offsetMs: number, extra: Record<string, any> = {}): any => ({
  id: `m${++seq}`,
  senderId,
  content: 'x',
  type: 'text',
  createdAt: new Date(T0 + offsetMs).toISOString(),
  ...extra,
});

console.log(`Message clustering (window = ${CLUSTER_WINDOW_MS / 1000}s)\n`);

// --- timestamp shapes --------------------------------------------------------
console.log('Timestamp parsing:');
eq('ISO string', messageTime(msg('a', 0)), T0);
eq('Date object', messageTime({ createdAt: new Date(T0) } as any), T0);
eq('Firestore-style .toDate()', messageTime({ createdAt: { toDate: () => new Date(T0) } } as any), T0);
eq('missing createdAt → 0', messageTime({ } as any), 0);
eq('unparseable createdAt → 0', messageTime({ createdAt: 'not a date' } as any), 0);

// --- run boundaries ----------------------------------------------------------
console.log('\nRun boundaries:');
eq('first message of a day opens a run', startsNewCluster(msg('a', 0), undefined), true);
eq('same sender, 30s later continues', startsNewCluster(msg('a', 30_000), msg('a', 0)), false);
eq('different sender opens a run', startsNewCluster(msg('b', 30_000), msg('a', 0)), true);
eq('same sender exactly at the window continues',
   startsNewCluster(msg('a', CLUSTER_WINDOW_MS), msg('a', 0)), false);
eq('same sender 1ms past the window opens a run',
   startsNewCluster(msg('a', CLUSTER_WINDOW_MS + 1), msg('a', 0)), true);
eq('a reply opens a run even from the same sender',
   startsNewCluster(msg('a', 10_000, { replyToId: 'm0' }), msg('a', 0)), true);
eq('an unsent message stays attached to the run',
   startsNewCluster({ ...msg('a', 0), createdAt: null }, msg('a', 0)), false);

// --- a whole transcript ------------------------------------------------------
console.log('\nTranscript walk:');
seq = 0;
const list: any[] = [
  msg('a', 0),                              // 0  opens
  msg('a', 20_000),                         // 1  continues
  msg('a', 40_000),                         // 2  continues, closes (b speaks next)
  msg('b', 60_000),                         // 3  opens, closes (a speaks next)
  msg('a', 90_000),                         // 4  opens, and closes: the reply
                                            //    below starts a run of its own,
                                            //    so this one stands alone
  msg('a', 95_000, { replyToId: 'm3' }),    // 5  reply → opens, closes
  msg('a', 20 * 60_000),                    // 6  20min gap → opens, closes (last)
];

const first = list.map((m, i) => startsNewCluster(m, list[i - 1]));
const last = list.map((m, i) => startsNewCluster(list[i + 1], m));

const wantFirst = [true, false, false, true, true, true, true];
const wantLast = [false, false, true, true, true, true, true];

JSON.stringify(first) === JSON.stringify(wantFirst)
  ? ok('run starts', JSON.stringify(first))
  : bad('run starts', `got ${JSON.stringify(first)}, want ${JSON.stringify(wantFirst)}`);

JSON.stringify(last) === JSON.stringify(wantLast)
  ? ok('run ends', JSON.stringify(last))
  : bad('run ends', `got ${JSON.stringify(last)}, want ${JSON.stringify(wantLast)}`);

// Every run must be well formed: exactly one start and one end per run, and the
// last message of the transcript must always close its run — otherwise a
// conversation would render with no avatar and no timestamp on its newest
// message.
const starts = first.filter(Boolean).length;
const ends = last.filter(Boolean).length;
eq('every run that starts also ends', starts, ends);
eq('the newest message closes its run', last[last.length - 1], true);

// A run must never span two senders — that would put one person's avatar on
// another person's message.
let mixed = 0;
let runSender = '';
list.forEach((m, i) => {
  if (first[i]) runSender = m.senderId;
  else if (m.senderId !== runSender) mixed++;
});
eq('no run spans two senders', mixed, 0);

console.log('\n' + '─'.repeat(60));
console.log(failures === 0 ? 'MESSAGE CLUSTERING OK' : `${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
