import type { PrismaClient } from '@prisma/client';
import type { NotificationsService } from '../notifications/notifications.service';
import type { CrisisKind, CrisisMode } from './crisis-views';

/**
 * WHAT AN ALARM TELLS, AND TO WHOM (Krisläge, F2).
 *
 * Three notices, each in the inbox and as a push, none by e-mail (an e-mail
 * is read when it is read, and an alarm is not):
 *
 *   CRISIS_ALARM           to all the school's staff but the one who started
 *                          it: that an alarm is going, and whether it is an
 *                          exercise. Delivered whatever the person chose
 *                          (notification-types.ts, deliveredRegardless).
 *   CRISIS_ENDED           to the same: that it is over.
 *   CRISIS_GUARDIAN_AFTER  to the guardians of the pupils on the lists, after a
 *                          real alarm, and only when the school has chosen to
 *                          tell them: that it happened and ended.
 *
 * The meta holds the alarm's id, its kind, its mode and its times, and no
 * pupil, no group, no room and no teacher; the push says less (push-messages.ts:
 * not even the kind). What the person has to do is read behind the login,
 * where the groups are, and for a teacher only their own.
 *
 * Sent after the writing transaction has committed, in a transaction of its
 * own, so an alarm that failed to start told nobody.
 */

interface AlarmFacts {
  schoolId: string;
  alarmId: string;
  kind: CrisisKind;
  mode: CrisisMode;
  startedAt: Date;
}

/** The alarm, to the staff. */
export async function sendAlarm(
  notifications: NotificationsService,
  tx: PrismaClient,
  args: AlarmFacts & { recipientIds: readonly string[] },
): Promise<number> {
  return notifications.notifyUsers(tx, {
    schoolId: args.schoolId,
    userIds: [...args.recipientIds],
    type: 'CRISIS_ALARM',
    meta: { alarmId: args.alarmId, kind: args.kind, mode: args.mode, startedAt: args.startedAt.toISOString() },
  });
}

/** The end, to the staff. */
export async function sendEnded(
  notifications: NotificationsService,
  tx: PrismaClient,
  args: AlarmFacts & { endedAt: Date; recipientIds: readonly string[] },
): Promise<number> {
  return notifications.notifyUsers(tx, {
    schoolId: args.schoolId,
    userIds: [...args.recipientIds],
    type: 'CRISIS_ENDED',
    meta: {
      alarmId: args.alarmId,
      kind: args.kind,
      mode: args.mode,
      startedAt: args.startedAt.toISOString(),
      endedAt: args.endedAt.toISOString(),
    },
  });
}

/** That it happened and ended, to the guardians of the pupils on the lists. No alarm id: they read none. */
export async function sendGuardianAfter(
  notifications: NotificationsService,
  tx: PrismaClient,
  args: AlarmFacts & { endedAt: Date; guardianIds: readonly string[] },
): Promise<number> {
  return notifications.notifyUsers(tx, {
    schoolId: args.schoolId,
    userIds: [...args.guardianIds],
    type: 'CRISIS_GUARDIAN_AFTER',
    meta: { kind: args.kind, startedAt: args.startedAt.toISOString(), endedAt: args.endedAt.toISOString() },
  });
}
