import { Injectable } from '@nestjs/common';
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
    try {
      return await this.prisma.withRls(user, (tx) =>
        tx.room.create({
          data: {
            schoolId,
            name: dto.name,
            code: dto.code ?? null,
            capacity: dto.capacity ?? null,
            ...(dto.type !== undefined ? { type: dto.type } : {}),
          },
        }),
      );
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  async update(id: string, dto: UpdateRoomDto, user: AuthenticatedUser): Promise<Room> {
    try {
      return await this.prisma.withRls(user, (tx) =>
        tx.room.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.code !== undefined ? { code: dto.code } : {}),
            ...(dto.capacity !== undefined ? { capacity: dto.capacity } : {}),
            ...(dto.type !== undefined ? { type: dto.type } : {}),
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
