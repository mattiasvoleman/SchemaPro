import { Injectable } from '@nestjs/common';
import type { TeachingRequirement } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import type {
  CreateTeachingRequirementDto,
  UpdateTeachingRequirementDto,
} from './dto/teaching-requirement.dto';

@Injectable()
export class TeachingRequirementsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    dto: CreateTeachingRequirementDto,
    user: AuthenticatedUser,
  ): Promise<TeachingRequirement> {
    const schoolId = requireSchoolId(user);
    try {
      return await this.prisma.withRls(user, (tx) =>
        tx.teachingRequirement.create({
          data: {
            schoolId,
            academicYearId: dto.academicYearId,
            subjectId: dto.subjectId,
            studentGroupId: dto.studentGroupId,
            teacherId: dto.teacherId ?? null,
            coTeacherId: dto.coTeacherId ?? null,
            lessonsPerWeek: dto.lessonsPerWeek ?? 1,
            minutesPerLesson: dto.minutesPerLesson ?? 60,
          },
        }),
      );
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  async update(
    id: string,
    dto: UpdateTeachingRequirementDto,
    user: AuthenticatedUser,
  ): Promise<TeachingRequirement> {
    try {
      return await this.prisma.withRls(user, (tx) =>
        tx.teachingRequirement.update({
          where: { id },
          data: {
            ...(dto.teacherId !== undefined ? { teacherId: dto.teacherId } : {}),
            ...(dto.coTeacherId !== undefined
              ? { coTeacherId: dto.coTeacherId }
              : {}),
            ...(dto.lessonsPerWeek !== undefined
              ? { lessonsPerWeek: dto.lessonsPerWeek }
              : {}),
            ...(dto.minutesPerLesson !== undefined
              ? { minutesPerLesson: dto.minutesPerLesson }
              : {}),
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
        tx.teachingRequirement.delete({ where: { id } }),
      );
    } catch (error) {
      rethrowPrismaError(error);
    }
  }
}
