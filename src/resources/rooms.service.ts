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
            building: normaliseBuilding(dto.building),
            floor: dto.floor ?? null,
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
            ...(dto.building !== undefined
              ? { building: normaliseBuilding(dto.building) }
              : {}),
            ...(dto.floor !== undefined ? { floor: dto.floor } : {}),
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

  /**
   * Deleting a room that is the last one a LOCK names is refused.
   *
   * RoomPreferenceRooms cascades, so the row would survive with an empty room
   * list — a lock that forbids every room and permits none, which the engine
   * meets as an unsatisfiable rule and the school meets as a week that stopped
   * generating for no visible reason. A WISH in the same state is harmless (it
   * simply stops being paid), so only locks are guarded.
   *
   * Refused rather than cascaded-and-warned because there is nowhere to put the
   * warning: this returns 204 and the room list re-renders.
   */
  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    try {
      await this.prisma.withRls(user, async (tx) => {
        const orphaned = await tx.roomPreference.findMany({
          where: { kind: 'LOCK', rooms: { some: { roomId: id } } },
          select: { subject: { select: { name: true } }, rooms: { select: { roomId: true } } },
        });
        const emptied = orphaned.filter((rule) => rule.rooms.length === 1);
        if (emptied.length > 0) {
          const subjects = [
            ...new Set(emptied.map((rule) => rule.subject?.name).filter(Boolean)),
          ].join(', ');
          throw new BadRequestException(
            `Salen är den enda som är låst för ${subjects || 'ett ämne'}. ` +
              `Ta bort eller ändra låsningen först.`,
          );
        }
        return tx.room.delete({ where: { id } });
      });
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

/**
 * A building name as the school meant it: trimmed, and a blank as none.
 *
 * The room optimisation compares buildings by equality, so "Hus B" and
 * "Hus B " would be two buildings a teacher walks between — a cost no screen
 * could explain. And a name of only spaces is not a name; storing it would
 * also break the database's own 1..60-after-trim check with a 500.
 */
function normaliseBuilding(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
