import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';

export type NotificationKind =
  | 'ABSENCE_UNREPORTED'
  | 'LEAVE_DECIDED'
  | 'LESSON_CANCELLED'
  | 'LESSON_SUBSTITUTE'
  | 'LESSON_ROOM_CHANGED'
  | 'SCHEDULE_CHANGED'
  | 'ROOM_BOOKING_DECIDED';

const MAX_RECIPIENTS = 500;

/**
 * In-app notifications, optionally mirrored to email.
 *
 * Rows are written inside the caller's RLS transaction (staff-insert policy).
 * Email delivery is best-effort and fire-and-forget via Resend's HTTP API —
 * configured with `RESEND_API_KEY` + `EMAIL_FROM`; when unset, email is
 * skipped and only the in-app inbox is used. No SDK dependency: plain fetch.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  /**
   * Writes one notification per recipient. When `email` is set, recipient
   * addresses are resolved inside the transaction and mails are dispatched
   * after the call returns (never blocking or failing the mutation).
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

    await tx.notification.createMany({
      data: userIds.map((userId) => ({
        schoolId: options.schoolId,
        userId,
        type: options.type,
        meta: options.meta as Prisma.InputJsonValue,
      })),
    });

    if (options.email && process.env.RESEND_API_KEY) {
      const recipients = await tx.user.findMany({
        where: { id: { in: userIds }, isActive: true },
        select: { email: true },
      });
      const addresses = recipients.map((r) => r.email).filter(Boolean);
      // Fire-and-forget: email must never fail or delay the mutation.
      void this.sendEmails(addresses, options.email.subject, options.email.body);
    }

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

  private async sendEmails(
    addresses: string[],
    subject: string,
    body: string,
  ): Promise<void> {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM ?? 'SchemaPro <noreply@schemapro.app>';
    if (!apiKey || addresses.length === 0) return;

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          // BCC so recipients never see each other's addresses.
          to: [from.replace(/^.*<|>$/g, '')],
          bcc: addresses,
          subject,
          text: body,
        }),
      });
      if (!response.ok) {
        this.logger.warn(`Email dispatch failed [status=${response.status}]`);
      }
    } catch {
      this.logger.warn('Email dispatch failed [network]');
    }
  }
}
