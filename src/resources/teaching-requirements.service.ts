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

  /**
   * The five referenced ids go in as they arrived, and no ownership check
   * happens here on purpose: the database refuses a reference to another
   * school. `TeachingRequirements` names its year, subject, group and both
   * teachers through composite (id, schoolId) foreign keys, so a row whose
   * `schoolId` is the caller's cannot name anything that is not
   * (20260822130000). RLS could not have done this — PostgreSQL runs
   * referential-integrity checks as the referenced table's owner with row
   * security off, so a foreign key to a row the caller cannot even SELECT
   * still validates.
   *
   * A refused reference surfaces as P2003, which `rethrowPrismaError` maps to
   * "references a record that does not exist" — the same answer the caller
   * would get for an id that never existed, which is what a foreign id is as
   * far as their tenant is concerned.
   */
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
