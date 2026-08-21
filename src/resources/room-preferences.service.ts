import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import type {
  CreateRoomPreferenceDto,
  UpdateRoomPreferenceDto,
} from './dto/room-preference.dto';

/**
 * Soft room wishes: "NO helst i labbet eller A14".
 *
 * The hard counterpart already exists as `Subject.requiredRoomTypeId`, and the
 * two answer different questions. A hard requirement that cannot be met is an
 * error a school must fix before a timetable exists at all; a soft one that
 * cannot be met is a timetable with one lesson in the wrong room. Schools need
 * both, and conflating them turns every wish into a way to make the week
 * unschedulable.
 */
@Injectable()
export class RoomPreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  list(user: AuthenticatedUser) {
    return this.prisma.withRls(user, (tx) =>
      tx.roomPreference.findMany({
        orderBy: { createdAt: 'asc' },
        include: { rooms: { select: { roomId: true } } },
      }),
    );
  }

  async create(dto: CreateRoomPreferenceDto, user: AuthenticatedUser) {
    const schoolId = requireSchoolId(user);
    const roomIds = assertExactlyOneTarget(dto.roomTypeId, dto.roomIds);

    try {
      return await this.prisma.withRls(user, (tx) =>
        tx.roomPreference.create({
          data: {
            schoolId,
            subjectId: dto.subjectId,
            roomTypeId: dto.roomTypeId ?? null,
            ...(dto.weight !== undefined ? { weight: dto.weight } : {}),
            rooms: { create: roomIds.map((roomId) => ({ schoolId, roomId })) },
          },
          include: { rooms: { select: { roomId: true } } },
        }),
      );
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  async update(id: string, dto: UpdateRoomPreferenceDto, user: AuthenticatedUser) {
    const schoolId = requireSchoolId(user);
    // Only check the pair when the caller touches either side of it: a request
    // that just changes the weight must not be forced to restate the target.
    const touchesTarget = dto.roomTypeId !== undefined || dto.roomIds !== undefined;
    const roomIds = touchesTarget
      ? assertExactlyOneTarget(dto.roomTypeId, dto.roomIds)
      : [];

    try {
      return await this.prisma.withRls(user, (tx) =>
        tx.roomPreference.update({
          where: { id },
          data: {
            ...(dto.weight !== undefined ? { weight: dto.weight } : {}),
            ...(touchesTarget
              ? {
                  roomTypeId: dto.roomTypeId ?? null,
                  rooms: {
                    deleteMany: {},
                    create: roomIds.map((roomId) => ({ schoolId, roomId })),
                  },
                }
              : {}),
          },
          include: { rooms: { select: { roomId: true } } },
        }),
      );
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  async remove(id: string, user: AuthenticatedUser): Promise<{ id: string }> {
    try {
      await this.prisma.withRls(user, (tx) =>
        tx.roomPreference.delete({ where: { id } }),
      );
      return { id };
    } catch (error) {
      rethrowPrismaError(error);
      return { id };
    }
  }
}

/**
 * A preference points at a type or at rooms — exactly one.
 *
 * Neither leaves a rule that can never be satisfied or violated, so it would
 * sit in the list doing nothing. Both leaves the school unable to say which
 * one it meant, and the engine unable to guess.
 */
function assertExactlyOneTarget(
  roomTypeId: string | null | undefined,
  roomIds: string[] | undefined,
): string[] {
  const hasType = typeof roomTypeId === 'string' && roomTypeId.length > 0;
  const rooms = roomIds ?? [];
  const hasRooms = rooms.length > 0;

  if (hasType === hasRooms) {
    throw new BadRequestException(
      'Ange antingen en salstyp eller en eller flera salar — inte båda och inte ingetdera.',
    );
  }
  return hasRooms ? [...new Set(rooms)] : [];
}
