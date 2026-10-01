import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ConstraintResource,
  type AvailabilityConstraint,
  type PrismaClient,
} from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { assertWholeMinutes, minutesOf } from '../common/solver-grid';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { parseDateString, parseTimeString, toWallClock } from '../common/utils/time';
import type {
  CreateAvailabilityConstraintDto,
  UpdateAvailabilityConstraintDto,
} from './dto/availability-constraint.dto';

@Injectable()
export class AvailabilityConstraintsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    dto: CreateAvailabilityConstraintDto,
    user: AuthenticatedUser,
  ): Promise<AvailabilityConstraint> {
    const schoolId = requireSchoolId(user);
    this.assertResourceShape(dto);
    if (!dto.dayOfWeek && !dto.date) {
      throw new BadRequestException('Provide either dayOfWeek or date.');
    }
    assertWindow(dto.startTime, dto.endTime);

    try {
      return await this.prisma.withRls(user, (tx) =>
        tx.availabilityConstraint.create({
          data: {
            schoolId,
            resourceType: dto.resourceType,
            userId: dto.userId ?? null,
            roomId: dto.roomId ?? null,
            studentGroupId: dto.studentGroupId ?? null,
            minGradeLevel: dto.minGradeLevel ?? null,
            maxGradeLevel: dto.maxGradeLevel ?? null,
            dayOfWeek: dto.dayOfWeek ?? null,
            date: dto.date ? parseDateString(dto.date) : null,
            startTime: parseTimeString(dto.startTime),
            endTime: parseTimeString(dto.endTime),
            ...(dto.type !== undefined ? { type: dto.type } : {}),
            reason: dto.reason ?? null,
          },
        }),
      );
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  async update(
    id: string,
    dto: UpdateAvailabilityConstraintDto,
    user: AuthenticatedUser,
  ): Promise<AvailabilityConstraint> {
    // create() has always checked this; update() never did, so a PATCH could
    // change a rule's resource type without supplying the matching id and
    // leave behind exactly the shapeless row create() refuses to make.
    this.assertResourceShape(dto);

    // THE WINDOW IS CHECKED AS IT WILL END UP, NOT AS IT ARRIVED. Both bounds
    // are optional here, so a PATCH carrying only `endTime` says nothing about
    // the `startTime` already on the row, and a guard that needs both present
    // waves exactly that payload through. Nothing downstream catches it: the
    // table carries no CHECK on the window, and an inverted pair overlaps no
    // lesson of the day, so the rule validates, saves, lists and blocks
    // nothing — the silent no-op assertResourceShape exists to prevent,
    // reached from the other side.
    //
    // With both ends in the payload the row has nothing to add, so that case
    // is answered before a transaction is opened.
    if (dto.startTime != null && dto.endTime != null) {
      assertWindow(dto.startTime, dto.endTime);
    }
    const movesOneEnd = (dto.startTime == null) !== (dto.endTime == null);

    try {
      return await this.prisma.withRls(user, async (tx) => {
        if (movesOneEnd) {
          const current = await lockWindow(tx, id);
          // A row in another school is invisible under RLS, so the lookup comes
          // back empty for it too — and "does not exist" is both the honest
          // answer and the one the update below has always given for it.
          if (!current) {
            throw new NotFoundException('The requested record does not exist.');
          }
          assertWindow(
            dto.startTime ?? toWallClock(current.startTime),
            dto.endTime ?? toWallClock(current.endTime),
          );
        }
        return tx.availabilityConstraint.update({
          where: { id },
          data: {
            ...(dto.resourceType !== undefined ? { resourceType: dto.resourceType } : {}),
            ...(dto.userId !== undefined ? { userId: dto.userId } : {}),
            ...(dto.roomId !== undefined ? { roomId: dto.roomId } : {}),
            ...(dto.studentGroupId !== undefined
              ? { studentGroupId: dto.studentGroupId }
              : {}),
            ...(dto.minGradeLevel !== undefined
              ? { minGradeLevel: dto.minGradeLevel }
              : {}),
            ...(dto.maxGradeLevel !== undefined
              ? { maxGradeLevel: dto.maxGradeLevel }
              : {}),
            ...(dto.dayOfWeek !== undefined ? { dayOfWeek: dto.dayOfWeek } : {}),
            ...(dto.date !== undefined
              ? { date: dto.date ? parseDateString(dto.date) : null }
              : {}),
            ...(dto.startTime !== undefined
              ? { startTime: parseTimeString(dto.startTime) }
              : {}),
            ...(dto.endTime !== undefined
              ? { endTime: parseTimeString(dto.endTime) }
              : {}),
            ...(dto.type !== undefined ? { type: dto.type } : {}),
            ...(dto.reason !== undefined ? { reason: dto.reason } : {}),
          },
        });
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    try {
      await this.prisma.withRls(user, (tx) =>
        tx.availabilityConstraint.delete({ where: { id } }),
      );
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  /**
   * The declared resource type must match what the row actually carries.
   *
   * A constraint that names no resource is not a harmless no-op: the proxy
   * would mint an anonymous id for it and forward a rule pointing at something
   * the solver has never heard of, so it validates, saves, appears in the list
   * and constrains nothing.
   */
  private assertResourceShape(
    dto: CreateAvailabilityConstraintDto | UpdateAvailabilityConstraintDto,
  ): void {
    if (dto.resourceType === undefined) return;

    // A year range is the one target that is not a row in any table — there is
    // no "årskurs 5" to point at, so it carries its own bounds instead.
    if (dto.resourceType === ConstraintResource.GRADE_LEVEL) {
      if (dto.minGradeLevel == null && dto.maxGradeLevel == null) {
        throw new BadRequestException(
          'A GRADE_LEVEL constraint must state at least one year bound.',
        );
      }
      if (
        dto.minGradeLevel != null &&
        dto.maxGradeLevel != null &&
        dto.minGradeLevel > dto.maxGradeLevel
      ) {
        throw new BadRequestException(
          'minGradeLevel must not be greater than maxGradeLevel.',
        );
      }
      if (dto.userId || dto.roomId || dto.studentGroupId) {
        throw new BadRequestException(
          'A GRADE_LEVEL constraint must not reference a teacher, room or group.',
        );
      }
      return;
    }

    const expectations: Record<ConstraintResource, string | null | undefined> = {
      [ConstraintResource.TEACHER]: dto.userId,
      [ConstraintResource.ROOM]: dto.roomId,
      [ConstraintResource.STUDENT_GROUP]: dto.studentGroupId,
      // Handled above; listed so a resource type added later fails to compile
      // here rather than falling through as an accepted shapeless row.
      [ConstraintResource.GRADE_LEVEL]: undefined,
    };
    if (!expectations[dto.resourceType]) {
      throw new BadRequestException(
        `A ${dto.resourceType} constraint must reference the matching resource id.`,
      );
    }
  }
}

/**
 * A constraint is a window, so it has to hold something.
 *
 * Compared as MINUTES, not as strings. The DTO's regex admits both HH:MM and
 * HH:MM:SS, and a lexical compare across the two lengths reads "09:00" as
 * before "09:00:00" — a zero-length block, accepted as a window, blocking
 * nothing. Minutes are also the precision the rest of the app schedules in, and
 * `toWallClock` hands the stored end back as HH:MM, so a boundary that cannot
 * be expressed on the grid should not be storable either.
 */
function assertWindow(startTime: string, endTime: string): void {
  assertWholeMinutes('startTime', startTime);
  assertWholeMinutes('endTime', endTime);

  if (minutesOf(startTime) >= minutesOf(endTime)) {
    throw new BadRequestException('startTime must be before endTime.');
  }
}

/**
 * The stored window, read under a row lock in the transaction that writes it.
 *
 * A one-sided PATCH is checked against the other end as it stands on the row,
 * so the row must not move between that read and the write. Reading inside the
 * same transaction does not hold it still by itself: `withRls` sets no
 * isolation level, so it runs at PostgreSQL's READ COMMITTED, where a plain
 * read takes no lock. Two PATCHes against 08:00-09:30 — one moving the start
 * to 09:00, one moving the end to 08:30 — would both read the untouched row,
 * both pass, and the second write would land on top of the first once it
 * commits: 09:00-08:30. FOR UPDATE makes the second reader wait for that commit
 * and check against what it wrote.
 *
 * Raw SQL because Prisma has no locking read. A raw `time` column comes back as
 * the same 1970-01-01 Date the model API returns, so `toWallClock` reads it
 * unchanged. Under RLS the lock also requires the UPDATE policy to admit the
 * row — the permission the write needs anyway — so a row the caller may not
 * change reads as missing, which is the 404 the update itself would give.
 */
async function lockWindow(
  tx: PrismaClient,
  id: string,
): Promise<Pick<AvailabilityConstraint, 'startTime' | 'endTime'> | undefined> {
  const [row] = await tx.$queryRaw<
    Pick<AvailabilityConstraint, 'startTime' | 'endTime'>[]
  >`
    SELECT "startTime", "endTime"
    FROM "AvailabilityConstraints"
    WHERE "id" = ${id}::uuid
    FOR UPDATE
  `;
  return row;
}
