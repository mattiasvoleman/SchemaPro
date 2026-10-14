import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import { rostersOf, type RosterScope } from '../calendar/lesson-roster';
import { PrismaService } from '../database/prisma.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import { RECIPIENT_CHUNK, type OutboxEntry } from './notification-outbox';

export type NotificationKind =
  | 'ABSENCE_UNREPORTED'
  | 'LEAVE_DECIDED'
  | 'LESSON_CANCELLED'
  | 'LESSON_SUBSTITUTE'
  | 'LESSON_ROOM_CHANGED'
  | 'SCHEDULE_CHANGED'
  | 'ROOM_BOOKING_DECIDED'
  | 'TEACHER_ABSENCE_REPORTED'
  | 'LESSON_COVER_WITHDRAWN'
  | 'LESSON_REINSTATED'
  | 'LESSON_SUPERVISED_STUDY'
  | 'CANCELLATION_DIGEST'
  | 'LEAVE_REQUESTED';


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
   * after the commit — never blocking or failing the mutation. Recipients
   * are taken RECIPIENT_CHUNK at a time, each chunk its own statement and
   * its own outbox entry; every recipient is written.
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
    const userIds = [...new Set(options.userIds)];
    if (userIds.length === 0) return 0;
    const external = this.delivery.wants({ type: options.type, email: options.email });
    const mails = Boolean(options.email) && this.delivery.emailConfigured();

    for (let at = 0; at < userIds.length; at += RECIPIENT_CHUNK) {
      const chunk = userIds.slice(at, at + RECIPIENT_CHUNK);
      const rows = chunk.map((userId) => ({
        id: randomUUID(),
        schoolId: options.schoolId,
        userId,
        type: options.type,
        meta: options.meta as Prisma.InputJsonValue,
      }));
      await tx.notification.createMany({ data: rows });
      if (!external) continue;

      const emailRecipients = mails
        ? (
            await tx.user.findMany({
              where: { id: { in: chunk }, isActive: true },
              select: { id: true, email: true },
            })
          ).map((r) => ({ userId: r.id, email: r.email }))
        : [];

      const outbox = this.outboxOf(tx);
      if (!outbox) {
        // Not a withRls transaction: there is no commit to wait for, and
        // delivering now could tell somebody about a write that never lands.
        // The inbox rows are still written, every chunk of them.
        if (at === 0) this.logger.warn(`Notice not delivered: no transaction to wait for [type=${options.type}]`);
        continue;
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
    }

    return userIds.length;
  }

  /**
   * Hands notices already written in `tx` to the delivery after the commit,
   * as notifyUsers does with its own rows. For the one writer that is not
   * notifyUsers: app.leave_request_notify (20261023091000), which writes a
   * guardian's or a pupil's LEAVE_REQUESTED notice to the mentors because
   * the filer may neither insert a teacher's notification nor read a
   * teacher's address. The e-mail goes only when it is configured, and
   * nothing goes outside a withRls transaction.
   */
  deliver(tx: PrismaClient, entry: OutboxEntry): void {
    if (entry.recipients.length === 0) return;
    if (!this.delivery.wants({ type: entry.type, email: entry.email })) return;
    const outbox = this.outboxOf(tx);
    if (!outbox) {
      this.logger.warn(`Notice not delivered: no transaction to wait for [type=${entry.type}]`);
      return;
    }
    const { email, ...rest } = entry;
    outbox.push(email && this.delivery.emailConfigured() ? { ...rest, email } : rest);
  }

  /** The transaction's outbox, delivered by one hook after its commit; undefined outside withRls. */
  private outboxOf(tx: PrismaClient): OutboxEntry[] | undefined {
    return this.prisma.commitLocal<OutboxEntry[]>(tx, OUTBOX, () => {
      const entries: OutboxEntry[] = [];
      this.prisma.onCommit(tx, async () => this.delivery.enqueue(entries));
      return entries;
    });
  }

  /**
   * Everybody a notice about these lessons reaches: the active pupils on
   * their rosters (calendar/lesson-roster.ts: home classes, teaching groups
   * and pupils named on the lesson) and all their guardians.
   */
  async recipientsForLessons(tx: PrismaClient, scopes: readonly RosterScope[]): Promise<string[]> {
    const rosters = await rostersOf(tx, scopes, { pupils: 'ACTIVE' });
    const pupils = [...new Set(rosters.flatMap((roster) => [...roster]))];
    return [...pupils, ...(await this.guardiansOf(tx, pupils))];
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
