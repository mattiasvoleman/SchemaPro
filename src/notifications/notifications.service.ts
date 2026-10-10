import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import type { OutboxEntry } from './notification-outbox';

export type NotificationKind =
  | 'ABSENCE_UNREPORTED'
  | 'LEAVE_DECIDED'
  | 'LESSON_CANCELLED'
  | 'LESSON_SUBSTITUTE'
  | 'LESSON_ROOM_CHANGED'
  | 'SCHEDULE_CHANGED'
  | 'ROOM_BOOKING_DECIDED'
  | 'TEACHER_ABSENCE_REPORTED'
  | 'LESSON_COVER_WITHDRAWN';

const MAX_RECIPIENTS = 500;

/** Where a transaction's outbox is kept (PrismaService.commitLocal). */
const OUTBOX = {};

/**
 * In-app notifications, mirrored to e-mail after the commit.
 *
 * Rows are written inside the caller's RLS transaction (staff-insert policy)
 * with ids the gateway gives them, and never read back: a TEACHER may insert
 * a notification for a pupil's guardian but not SELECT it, and an INSERT …
 * RETURNING applies the SELECT arms to the new rows, so createManyAndReturn
 * would fail every attendance submit that tells a guardian (RLS 29h).
 *
 * Everything beyond the inbox happens after the commit: the notice joins the
 * transaction's outbox, and one PrismaService.onCommit hook hands the whole
 * outbox to NotificationDeliveryService once the transaction has committed.
 * A rolled-back write tells nobody.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly delivery: NotificationDeliveryService,
  ) {}

  /**
   * Writes one notification per recipient. When the notice has somewhere to
   * go beyond the inbox, e-mail addresses are resolved inside the
   * transaction (as (userId, address) pairs) and the notice is delivered
   * after the commit — never blocking or failing the mutation.
   */
  async notifyUsers(
    tx: PrismaClient,
    options: {
      schoolId: string;
      userIds: string[];
      type: NotificationKind;
      meta: Record<string, unknown>;
      email?: { subject: string; body: string };
    },
  ): Promise<number> {
    const userIds = [...new Set(options.userIds)].slice(0, MAX_RECIPIENTS);
    if (userIds.length === 0) return 0;

    const rows = userIds.map((userId) => ({
      id: randomUUID(),
      schoolId: options.schoolId,
      userId,
      type: options.type,
      meta: options.meta as Prisma.InputJsonValue,
    }));
    await tx.notification.createMany({ data: rows });

    if (!this.delivery.wants({ type: options.type, email: options.email })) return userIds.length;

    const emailRecipients =
      options.email && this.delivery.emailConfigured()
        ? (
            await tx.user.findMany({
              where: { id: { in: userIds }, isActive: true },
              select: { id: true, email: true },
            })
          ).map((r) => ({ userId: r.id, email: r.email }))
        : [];

    const outbox = this.prisma.commitLocal<OutboxEntry[]>(tx, OUTBOX, () => {
      const entries: OutboxEntry[] = [];
      this.prisma.onCommit(tx, async () => this.delivery.enqueue(entries));
      return entries;
    });
    if (!outbox) {
      // Not a withRls transaction: there is no commit to wait for, and
      // delivering now could tell somebody about a write that never lands.
      this.logger.warn(`Notice not delivered: no transaction to wait for [type=${options.type}]`);
      return userIds.length;
    }
    outbox.push({
      schoolId: options.schoolId,
      type: options.type,
      meta: options.meta,
      recipients: rows.map((row) => ({ userId: row.userId, notificationId: row.id })),
      ...(options.email
        ? { email: { subject: options.email.subject, body: options.email.body, recipients: emailRecipients } }
        : {}),
    });

    return userIds.length;
  }

  /**
   * Recipients for group-wide notices: active students of the class(es) plus
   * all their guardians.
   */
  async recipientsForGroups(
    tx: PrismaClient,
    studentGroupIds: string[],
  ): Promise<string[]> {
    if (studentGroupIds.length === 0) return [];
    const students = await tx.user.findMany({
      where: {
        role: 'STUDENT',
        isActive: true,
        studentGroupId: { in: studentGroupIds },
      },
      select: { id: true },
    });
    const studentIds = students.map((s) => s.id);
    const guardians = await tx.guardianStudent.findMany({
      where: { studentId: { in: studentIds } },
      select: { guardianId: true },
    });
    return [...studentIds, ...guardians.map((g) => g.guardianId)];
  }

  /** Guardians of the given students. */
  async guardiansOf(tx: PrismaClient, studentIds: string[]): Promise<string[]> {
    if (studentIds.length === 0) return [];
    const links = await tx.guardianStudent.findMany({
      where: { studentId: { in: studentIds } },
      select: { guardianId: true },
    });
    return links.map((link) => link.guardianId);
  }
}
