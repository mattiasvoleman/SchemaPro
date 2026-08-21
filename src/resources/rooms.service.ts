import { BadRequestException, Injectable } from '@nestjs/common';
import type { Room } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import type { CreateRoomDto, UpdateRoomDto } from './dto/room.dto';

@Injectable()
export class RoomsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateRoomDto, user: AuthenticatedUser): Promise<Room> {
    const schoolId = requireSchoolId(user);
    assertOrderedGradeRange(dto.minGradeLevel, dto.maxGradeLevel);
    try {
      return await this.prisma.withRls(user, (tx) =>
        tx.room.create({
          data: {
            schoolId,
            name: dto.name,
            code: dto.code ?? null,
            capacity: dto.capacity ?? null,
            minGradeLevel: dto.minGradeLevel ?? null,
            maxGradeLevel: dto.maxGradeLevel ?? null,
            ...(dto.roomTypeId !== undefined ? { roomTypeId: dto.roomTypeId } : {}),
            ...(dto.requiresApproval !== undefined
              ? { requiresApproval: dto.requiresApproval }
              : {}),
          },
        }),
      );
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  async update(id: string, dto: UpdateRoomDto, user: AuthenticatedUser): Promise<Room> {
    assertOrderedGradeRange(dto.minGradeLevel, dto.maxGradeLevel);
    try {
      return await this.prisma.withRls(user, (tx) =>
        tx.room.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.code !== undefined ? { code: dto.code } : {}),
            ...(dto.capacity !== undefined ? { capacity: dto.capacity } : {}),
            ...(dto.minGradeLevel !== undefined
              ? { minGradeLevel: dto.minGradeLevel }
              : {}),
            ...(dto.maxGradeLevel !== undefined
              ? { maxGradeLevel: dto.maxGradeLevel }
              : {}),
            ...(dto.roomTypeId !== undefined ? { roomTypeId: dto.roomTypeId } : {}),
            ...(dto.requiresApproval !== undefined
              ? { requiresApproval: dto.requiresApproval }
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
      await this.prisma.withRls(user, (tx) => tx.room.delete({ where: { id } }));
    } catch (error) {
      rethrowPrismaError(error);
    }
  }
}

/**
 * An inverted range excludes every year, leaving the room unusable while
 * looking configured — a slip worth refusing at the door rather than
 * discovering as "no room satisfies capacity/type/years" after a generation
 * run. The database enforces it too; this is what turns it into a sentence.
 */
function assertOrderedGradeRange(
  min: number | null | undefined,
  max: number | null | undefined,
): void {
  if (typeof min === 'number' && typeof max === 'number' && min > max) {
    throw new BadRequestException(
      'Lägsta årskurs kan inte vara högre än högsta årskurs.',
    );
  }
}
