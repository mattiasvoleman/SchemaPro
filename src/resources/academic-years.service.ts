import { BadRequestException, Injectable } from '@nestjs/common';
import type { AcademicYear } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { parseDateString } from '../common/utils/time';
import type {
  CreateAcademicYearDto,
  UpdateAcademicYearDto,
} from './dto/academic-year.dto';

@Injectable()
export class AcademicYearsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    dto: CreateAcademicYearDto,
    user: AuthenticatedUser,
  ): Promise<AcademicYear> {
    const schoolId = requireSchoolId(user);
    if (dto.startDate >= dto.endDate) {
      throw new BadRequestException('startDate must be before endDate.');
    }
    try {
      return await this.prisma.withRls(user, async (tx) => {
        // Only one academic year may be active per school.
        if (dto.isActive) {
          await tx.academicYear.updateMany({
            where: { schoolId, isActive: true },
            data: { isActive: false },
          });
        }
        return tx.academicYear.create({
          data: {
            schoolId,
            name: dto.name,
            startDate: parseDateString(dto.startDate),
            endDate: parseDateString(dto.endDate),
            isActive: dto.isActive ?? false,
          },
        });
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  async update(
    id: string,
    dto: UpdateAcademicYearDto,
    user: AuthenticatedUser,
  ): Promise<AcademicYear> {
    const schoolId = requireSchoolId(user);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        if (dto.isActive) {
          await tx.academicYear.updateMany({
            where: { schoolId, isActive: true, id: { not: id } },
            data: { isActive: false },
          });
        }
        return tx.academicYear.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.startDate !== undefined
              ? { startDate: parseDateString(dto.startDate) }
              : {}),
            ...(dto.endDate !== undefined
              ? { endDate: parseDateString(dto.endDate) }
              : {}),
            ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
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
        tx.academicYear.delete({ where: { id } }),
      );
    } catch (error) {
      rethrowPrismaError(error);
    }
  }
}
