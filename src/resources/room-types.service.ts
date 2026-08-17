import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import type { CreateRoomTypeDto, UpdateRoomTypeDto } from './dto/room-type.dto';

/**
 * Room types a school owns and edits itself.
 *
 * These were a fixed Prisma enum until Swedish schools needed types it never
 * had (hemkunskapssal, trä- och metallslöjd, textilslöjd). They are rows
 * rather than free text because the scheduler matches a subject's required
 * type against a room's type by identity: a typo in a free-text label would
 * silently make a subject unschedulable and surface as the opaque "No room
 * satisfies capacity/type".
 */
@Injectable()
export class RoomTypesService {
  constructor(private readonly prisma: PrismaService) {}

  list(user: AuthenticatedUser) {
    return this.prisma.withRls(user, (tx) =>
      tx.roomType.findMany({
        orderBy: { name: 'asc' },
        // Usage counts drive the UI: a type in use cannot be deleted, and the
        // admin should see that before trying.
        include: { _count: { select: { rooms: true, subjects: true } } },
      }),
    );
  }

  async create(dto: CreateRoomTypeDto, user: AuthenticatedUser) {
    const schoolId = requireSchoolId(user);
    try {
      return await this.prisma.withRls(user, (tx) =>
        tx.roomType.create({ data: { schoolId, name: dto.name.trim() } }),
      );
    } catch (error) {
      rethrowPrismaError(error); // duplicate name -> 409
    }
  }

  async update(id: string, dto: UpdateRoomTypeDto, user: AuthenticatedUser) {
    try {
      return await this.prisma.withRls(user, (tx) =>
        tx.roomType.update({
          where: { id },
          data: { ...(dto.name !== undefined ? { name: dto.name.trim() } : {}) },
        }),
      );
    } catch (error) {
      rethrowPrismaError(error); // duplicate name -> 409, unknown id -> 404
    }
  }

  async remove(id: string, user: AuthenticatedUser) {
    return this.prisma.withRls(user, async (tx) => {
      // The FK is ON DELETE RESTRICT, so the database already refuses this.
      // Checking first turns a raw constraint violation into a message naming
      // exactly what still points at the type.
      const type = await tx.roomType.findUnique({
        where: { id },
        include: { _count: { select: { rooms: true, subjects: true } } },
      });
      if (!type) return { id };

      const { rooms, subjects } = type._count;
      if (rooms > 0 || subjects > 0) {
        const parts = [
          rooms > 0 ? `${rooms} sal(ar)` : null,
          subjects > 0 ? `${subjects} ämne(n)` : null,
        ].filter(Boolean);
        throw new BadRequestException(
          `Salstypen används av ${parts.join(' och ')} och kan inte tas bort. ` +
            'Byt typ på dem först.',
        );
      }
      await tx.roomType.delete({ where: { id } });
      return { id };
    });
  }
}
