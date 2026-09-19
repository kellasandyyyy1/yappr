import type { SupabaseClient } from '@supabase/supabase-js';
import type webpush from 'web-push';

/**
 * The due-reminder sweep itself, with no HTTP and no environment.
 *
 * Extracted so the Vercel function (api/reminders-due.ts) and the dev-server
 * twin (server.ts) run the SAME code. The alternative — writing it twice —
 * is how a route ends up behaving one way locally and another in production,
 * and this is the one route nobody can watch running: it fires on a schedule,
 * to other people's devices, with no user in front of it.
 *
 * Same convention as api/_giphy.ts, _nominatim.ts and _youtube.ts, which exist
 * for exactly this reason.
 *
 * Everything it needs is passed in, so the caller owns configuration and
 * authorisation, and this owns the behaviour.
 */

export interface SweepDeps {
  /** Service-role client. RLS is bypassed deliberately: this reads notes
   *  across every space and writes notifications addressed to people the
   *  caller is not. No policy would ever allow that, and none should. */
  admin: SupabaseClient;
  /** Configured web-push, or null to write the in-app rows and skip delivery.
   *  A missing VAPID key degrades push; it must not stop the notifications. */
  push: typeof webpush | null;
  /** Newest-first cap, so a backlog drains over several runs rather than
   *  turning one invocation into a thousand push round trips. */
  limit?: number;
  /** Injectable for tests; defaults to now. */
  now?: Date;
}

export interface SweepResult {
  due: number;
  notified: number;
  delivered: number;
  pruned: number;
  /** Set when the rows were written but the stamp failed — the next run will
   *  send them again, which is worth shouting about. */
  warning?: string;
}

export async function sweepDueReminders({
  admin,
  push,
  limit = 100,
  now = new Date(),
}: SweepDeps): Promise<SweepResult> {
  // --- what is due ----------------------------------------------------------
  // Matches notes_due_idx exactly: due, not done, not yet announced.
  const { data: due, error: dueError } = await admin
    .from('notes')
    .select('id, space_id, content, due_date, note_spaces(name)')
    .lte('due_date', now.toISOString())
    .eq('completed', false)
    .is('notified_at', null)
    .order('due_date', { ascending: true })
    .limit(limit);

  if (dueError) throw new Error(`reading due reminders: ${dueError.message}`);
  if (!due || due.length === 0) return { due: 0, notified: 0, delivered: 0, pruned: 0 };

  // --- who is in those spaces ----------------------------------------------
  // One query for every space in the batch rather than one per note: several
  // reminders in the same space is the normal case, not the exception.
  const spaceIds = [...new Set(due.map((n: any) => n.space_id))];
  const { data: members, error: memberError } = await admin
    .from('note_space_members')
    .select('space_id, user_id')
    .in('space_id', spaceIds)
    .eq('status', 'accepted');

  if (memberError) throw new Error(`reading space members: ${memberError.message}`);

  const bySpace = new Map<string, string[]>();
  for (const m of members ?? []) {
    bySpace.set(m.space_id, [...(bySpace.get(m.space_id) ?? []), m.user_id]);
  }

  // --- the durable half: notification rows ---------------------------------
  // actor_id is null: a reminder falling due is not an act by a person, and
  // NotificationsView renders it without a name for that reason.
  //
  // Everyone accepted is notified, the author included. They asked to be
  // reminded; "never notify yourself" is a rule about social noise, not about
  // an alarm you set.
  const rows = due.flatMap((note: any) =>
    (bySpace.get(note.space_id) ?? []).map((userId) => ({
      recipient_id: userId,
      actor_id: null,
      type: 'note_reminder',
      content: note.content,
      note_space_id: note.space_id,
      note_id: note.id,
    }))
  );

  if (rows.length > 0) {
    const { error: insertError } = await admin.from('notifications').insert(rows);
    // Nothing is stamped, so the next sweep retries the same notes. That is
    // the right failure: a reminder delivered late beats one silently dropped.
    if (insertError) throw new Error(`writing notifications: ${insertError.message}`);
  }

  // --- stamp, so this never fires twice ------------------------------------
  let warning: string | undefined;
  const { error: stampError } = await admin
    .from('notes')
    .update({ notified_at: now.toISOString() })
    .in('id', due.map((n: any) => n.id));

  if (stampError) {
    // The notifications are already in. Say so loudly — the next sweep will
    // send them again, and a duplicate is the visible symptom of this line.
    warning = `notified but NOT stamped, duplicates likely: ${stampError.message}`;
  }

  // --- push: best effort, and last -----------------------------------------
  // The in-app rows are the delivery that matters; this is the buzz in
  // someone's pocket. It runs after the durable work so a push failure can
  // never cost a notification.
  let delivered = 0;
  const expired: string[] = [];

  if (push && rows.length > 0) {
    const recipients = [...new Set(rows.map((r) => r.recipient_id))];
    const { data: subs } = await admin
      .from('push_subscriptions')
      .select('id, user_id, endpoint, p256dh, auth')
      .in('user_id', recipients);

    const byUser = new Map<string, any[]>();
    for (const s of subs ?? []) byUser.set(s.user_id, [...(byUser.get(s.user_id) ?? []), s]);

    await Promise.all(
      due.flatMap((note: any) => {
        const spaceName = note.note_spaces?.name ?? 'your notes';
        const payload = JSON.stringify({
          title: `Reminder — ${spaceName}`,
          body: note.content,
          url: '/',
        });
        return (bySpace.get(note.space_id) ?? []).flatMap((userId) =>
          (byUser.get(userId) ?? []).map(async (sub) => {
            try {
              await push.sendNotification(
                { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                payload
              );
              delivered += 1;
            } catch (err) {
              const status = (err as { statusCode?: number }).statusCode;
              // 404/410 mean the browser dropped the subscription.
              if (status === 404 || status === 410) expired.push(sub.id);
              else console.error('Reminder push failed:', status, (err as Error).message);
            }
          })
        );
      })
    );

    if (expired.length > 0) {
      const { error } = await admin.from('push_subscriptions').delete().in('id', expired);
      if (error) console.error('Could not prune expired subscriptions:', error.message);
    }
  }

  return { due: due.length, notified: rows.length, delivered, pruned: expired.length, warning };
}
