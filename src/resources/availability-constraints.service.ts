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

  /** The referenced resource id must match the declared resource type. */
  private assertResourceShape(dto: CreateAvailabilityConstraintDto): void {
    const expectations: Record<ConstraintResource, string | null | undefined> = {
      [ConstraintResource.TEACHER]: dto.userId,
      [ConstraintResource.ROOM]: dto.roomId,
      [ConstraintResource.STUDENT_GROUP]: dto.studentGroupId,
    };
    if (!expectations[dto.resourceType]) {
      throw new BadRequestException(
        `A ${dto.resourceType} constraint must reference the matching resource id.`,
      );
    }
  }
}
