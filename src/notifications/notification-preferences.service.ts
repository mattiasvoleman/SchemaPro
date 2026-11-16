import { BadRequestException, Injectable } from '@nestjs/common';
import type { NotificationType } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { requireSchoolId, requireUserId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';
import type { NotificationPreferencesDto } from './dto/notification-preferences.dto';
import { REQUIRED_BY_ROLE, isChoosingRole, typesFor } from './notification-types';
import type { NotificationKind } from './notifications.service';

export interface NotificationPreference {
  type: NotificationKind;
  /** Sent outside the app (e-mail and push). */
  enabled: boolean;
  /** The school must send it; the switch is shown and cannot be turned off. */
  required: boolean;
}

export const NOTIFICATION_TYPE_NOT_OFFERED = 'NOTIFICATION_TYPE_NOT_OFFERED';
export const NOTIFICATION_TYPE_REQUIRED = 'NOTIFICATION_TYPE_REQUIRED';

/**
 * A person's own choice of what leaves SchemaPro (e-mail and push), per type
 * (NotificationOptOuts, 20261013100000). Own rows only, under the caller's
 * RLS, and every write names the owner (deleteMany by the caller's own id,
 * never an unfiltered deleteMany): the e2e mocks cannot prove RLS, so the
 * service does not lean on it for whose rows these are.
 */
@Injectable()
export class NotificationPreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  async get(user: AuthenticatedUser): Promise<{ types: NotificationPreference[] }> {
    // Huvudman: the huvudman's reader has no row at the school, so nothing to
    // be told and nothing opted out of; the page reads, and saving is
    // refused (RolesGuard, HUVUDMAN_READS_ONLY).
    if (user.huvudman && !user.userId) return { types: this.listFor(user.role, new Set(), user.teaches) };
    const userId = requireUserId(user);
    const rows = await this.prisma.queryWithRls(user, (db) =>
      db.notificationOptOut.findMany({ where: { userId }, select: { type: true } }),
    );
    return { types: this.listFor(user.role, new Set((rows ?? []).map((row) => row.type as NotificationKind)), user.teaches) };
  }

  async put(dto: NotificationPreferencesDto, user: AuthenticatedUser): Promise<{ types: NotificationPreference[] }> {
    const userId = requireUserId(user);
    const schoolId = requireSchoolId(user);
    // An administrator who teaches (Users.teaches) is offered the teacher's three notices besides their own.
    const offered = isChoosingRole(user.role) ? typesFor(user.role, user.teaches) : [];
    const required = isChoosingRole(user.role) ? REQUIRED_BY_ROLE[user.role] : new Set<NotificationKind>();
    for (const type of dto.optOut as NotificationKind[]) {
      if (required.has(type)) {
        throw new BadRequestException({
          message: `optOut: ${type} skickas alltid och kan inte väljas bort.`,
          code: NOTIFICATION_TYPE_REQUIRED,
          params: { type },
        });
      }
      if (!offered.includes(type)) {
        throw new BadRequestException({
          message: `optOut: ${type} är inget du får.`,
          code: NOTIFICATION_TYPE_NOT_OFFERED,
          params: { type },
        });
      }
    }
    const chosen = [...new Set(dto.optOut as NotificationKind[])];
    await this.prisma.withRls(user, async (tx) => {
      await tx.notificationOptOut.deleteMany({ where: { userId } });
      if (chosen.length > 0) {
        await tx.notificationOptOut.createMany({
          data: chosen.map((type) => ({ userId, schoolId, type: type as NotificationType })),
        });
      }
    });
    return { types: this.listFor(user.role, new Set(chosen), user.teaches) };
  }

  private listFor(role: string, optedOut: ReadonlySet<NotificationKind>, teaches: boolean | undefined): NotificationPreference[] {
    if (!isChoosingRole(role)) return [];
    const required = REQUIRED_BY_ROLE[role];
    return typesFor(role, teaches).map((type) => ({
      type,
      enabled: required.has(type) || !optedOut.has(type),
      required: required.has(type),
    }));
  }
}
