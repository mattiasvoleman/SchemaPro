import { Injectable } from '@nestjs/common';
import type { Subject } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import type { CreateSubjectDto, UpdateSubjectDto } from './dto/subject.dto';

@Injectable()
export class SubjectsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateSubjectDto, user: AuthenticatedUser): Promise<Subject> {
    const schoolId = requireSchoolId(user);
    try {
      return await this.prisma.withRls(user, (tx) =>
        tx.subject.create({
          data: {
            schoolId,
            name: dto.name,
            code: dto.code ?? null,
            color: dto.color ?? null,
            requiredRoomType: dto.requiredRoomType ?? null,
          },
        }),
      );
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  async update(
    id: string,
    dto: UpdateSubjectDto,
    user: AuthenticatedUser,
  ): Promise<Subject> {
    try {
      return await this.prisma.withRls(user, (tx) =>
        tx.subject.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.code !== undefined ? { code: dto.code } : {}),
            ...(dto.color !== undefined ? { color: dto.color } : {}),
            ...(dto.requiredRoomType !== undefined
              ? { requiredRoomType: dto.requiredRoomType }
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
      await this.prisma.withRls(user, (tx) => tx.subject.delete({ where: { id } }));
    } catch (error) {
      rethrowPrismaError(error);
    }
  }
}
