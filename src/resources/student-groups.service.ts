import { Injectable } from '@nestjs/common';
import type { StudentGroup } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import type {
  CreateStudentGroupDto,
  UpdateStudentGroupDto,
} from './dto/student-group.dto';

@Injectable()
export class StudentGroupsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    dto: CreateStudentGroupDto,
    user: AuthenticatedUser,
  ): Promise<StudentGroup> {
    const schoolId = requireSchoolId(user);
    try {
      return await this.prisma.withRls(user, (tx) =>
        tx.studentGroup.create({
          data: {
            schoolId,
            academicYearId: dto.academicYearId,
            name: dto.name,
            gradeLevel: dto.gradeLevel ?? null,
          },
        }),
      );
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  async update(
    id: string,
    dto: UpdateStudentGroupDto,
    user: AuthenticatedUser,
  ): Promise<StudentGroup> {
    try {
      return await this.prisma.withRls(user, (tx) =>
        tx.studentGroup.update({
          where: { id },
          data: {
            ...(dto.academicYearId !== undefined
              ? { academicYearId: dto.academicYearId }
              : {}),
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.gradeLevel !== undefined ? { gradeLevel: dto.gradeLevel } : {}),
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
        tx.studentGroup.delete({ where: { id } }),
      );
    } catch (error) {
      rethrowPrismaError(error);
    }
  }
}
