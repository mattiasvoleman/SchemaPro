import { BadRequestException, Injectable } from '@nestjs/common';
import { ConstraintResource, type AvailabilityConstraint } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { parseDateString, parseTimeString } from '../common/utils/time';
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
    if (dto.startTime >= dto.endTime) {
      throw new BadRequestException('startTime must be before endTime.');
    }

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
    if (dto.startTime && dto.endTime && dto.startTime >= dto.endTime) {
      throw new BadRequestException('startTime must be before endTime.');
    }
    // create() has always checked this; update() never did, so a PATCH could
    // change a rule's resource type without supplying the matching id and
    // leave behind exactly the shapeless row create() refuses to make.
    this.assertResourceShape(dto);
    try {
      return await this.prisma.withRls(user, (tx) =>
        tx.availabilityConstraint.update({
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
        }),
      );
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
