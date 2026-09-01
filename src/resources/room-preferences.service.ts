import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { PrismaClient, RoomRuleKind } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import type {
  CreateRoomPreferenceDto,
  UpdateRoomPreferenceDto,
} from './dto/room-preference.dto';

/**
 * Room rules: "NO helst i labbet eller A14", and "åk 4:s matte BARA i
 * Optimisten 4".
 *
 * Two kinds in one table because they differ in one field. A WISH that cannot
 * be met is a timetable with one lesson in the wrong room; a LOCK that cannot
 * be met is a week the school must change before a timetable exists at all.
 * Conflating them would turn every wish into a way to make the week
 * unschedulable, which is why `kind` is explicit and defaults to the safe half.
 *
 * `Subject.requiredRoomTypeId` is the other hard rule and answers a different
 * question: it is school-wide and names a type, so it cannot say "år 4's maths
 * in Optimisten 4" at all.
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
    assertGradeSpan(dto.minGradeLevel ?? null, dto.maxGradeLevel ?? null);

    try {
      return await this.prisma.withRls(user, async (tx) => {
        await this.assertLockCanBeHonoured(
          tx,
          dto.kind ?? 'WISH',
          roomIds,
          dto.minGradeLevel ?? null,
          dto.maxGradeLevel ?? null,
        );
        return tx.roomPreference.create({
          data: {
            schoolId,
            subjectId: dto.subjectId,
            ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
            minGradeLevel: dto.minGradeLevel ?? null,
            maxGradeLevel: dto.maxGradeLevel ?? null,
            roomTypeId: dto.roomTypeId ?? null,
            ...(dto.weight !== undefined ? { weight: dto.weight } : {}),
            rooms: { create: roomIds.map((roomId) => ({ schoolId, roomId })) },
          },
          include: { rooms: { select: { roomId: true } } },
        });
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  /**
   * The stored row is read first, and the checks run on the MERGE.
   *
   * A PATCH here is deliberately partial — changing only the weight must not
   * force the caller to restate the rooms — so a payload that flips WISH to
   * LOCK says nothing about the target it is about to start enforcing, and one
   * that moves a single year bound says nothing about the other. Validating the
   * DTO alone lets the database answer with a constraint violation the admin
   * cannot act on, and lets a lock be armed against rooms nobody re-checked.
   */
  async update(id: string, dto: UpdateRoomPreferenceDto, user: AuthenticatedUser) {
    const schoolId = requireSchoolId(user);
    // Only check the pair when the caller touches either side of it: a request
    // that just changes the weight must not be forced to restate the target.
    const touchesTarget = dto.roomTypeId !== undefined || dto.roomIds !== undefined;
    const roomIds = touchesTarget
      ? assertExactlyOneTarget(dto.roomTypeId, dto.roomIds)
      : [];

    try {
      return await this.prisma.withRls(user, async (tx) => {
        const current = await tx.roomPreference.findUnique({
          where: { id },
          include: { rooms: { select: { roomId: true } } },
        });
        if (!current) {
          throw new NotFoundException(`Room rule ${id} not found.`);
        }

        const minGradeLevel =
          dto.minGradeLevel !== undefined ? dto.minGradeLevel : current.minGradeLevel;
        const maxGradeLevel =
          dto.maxGradeLevel !== undefined ? dto.maxGradeLevel : current.maxGradeLevel;
        assertGradeSpan(minGradeLevel, maxGradeLevel);

        await this.assertLockCanBeHonoured(
          tx,
          dto.kind ?? current.kind,
          touchesTarget ? roomIds : current.rooms.map((entry) => entry.roomId),
          minGradeLevel,
          maxGradeLevel,
        );

        return tx.roomPreference.update({
          where: { id },
          data: {
            ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
            ...(dto.minGradeLevel !== undefined
              ? { minGradeLevel: dto.minGradeLevel }
              : {}),
            ...(dto.maxGradeLevel !== undefined
              ? { maxGradeLevel: dto.maxGradeLevel }
              : {}),
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
        });
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  /**
   * A lock whose every named room is fenced away from its own years.
   *
   * Rooms carry their own stage limits, so "åk 4:s matte endast i Optimisten 4"
   * is a contradiction when Optimisten 4 is reserved for years 7-9 — and one
   * only this layer can phrase, because it is the only one that still knows the
   * room's NAME. The engine meets the same fact as an empty eligible set and
   * can say no more than "no room satisfies capacity/type/years".
   *
   * Wishes are exempt: an unreachable wish costs a constant the solver ignores,
   * and refusing one would stop a school writing an aspiration before the room
   * it needs exists. Only a lock can make a week impossible.
   *
   * A lock with no span reaches every year and cannot be contradicted this way,
   * so it is not checked. Neither is a type-targeted lock: a type is a set that
   * can grow, and the rooms in it are not knowable as a fixed list here.
   */
  private async assertLockCanBeHonoured(
    tx: PrismaClient,
    kind: RoomRuleKind,
    roomIds: string[],
    minGradeLevel: number | null,
    maxGradeLevel: number | null,
  ): Promise<void> {
    if (kind !== 'LOCK' || roomIds.length === 0) return;
    if (minGradeLevel === null || maxGradeLevel === null) return;

    const rooms = await tx.room.findMany({
      where: { id: { in: roomIds } },
      select: { name: true, minGradeLevel: true, maxGradeLevel: true },
    });
    // None of them resolved: the ids are wrong, or belong to another school and
    // RLS is hiding them. That is a different failure with a better messenger —
    // the foreign key, one line down — and answering it here with "reserved for
    // other years" would name a cause that is not the cause.
    if (rooms.length === 0) return;

    // Containment, the same test the engine applies: the rule's whole span must
    // fit inside the room's fence.
    const usable = rooms.filter(
      (room) =>
        (room.minGradeLevel === null || minGradeLevel >= room.minGradeLevel) &&
        (room.maxGradeLevel === null || maxGradeLevel <= room.maxGradeLevel),
    );
    if (usable.length > 0) return;

    const names = rooms.map((room) => room.name).join(', ');
    throw new BadRequestException(
      `Låset går inte att hålla: ${names || 'salarna'} är reserverade för andra ` +
        `årskurser än ${minGradeLevel}–${maxGradeLevel}. Ändra salens årskurser ` +
        `eller välj en annan sal.`,
    );
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
/**
 * Both bounds or neither, and ordered.
 *
 * Mirrors the two CHECKs the migration adds, in Swedish and before the write —
 * a constraint violation surfacing from Postgres names a constraint, not a
 * thing an administrator can change.
 */
function assertGradeSpan(
  minGradeLevel: number | null,
  maxGradeLevel: number | null,
): void {
  if ((minGradeLevel === null) !== (maxGradeLevel === null)) {
    throw new BadRequestException(
      'Ange båda årskurserna eller ingen av dem — ett halvt spann går inte att tolka.',
    );
  }
  if (
    minGradeLevel !== null &&
    maxGradeLevel !== null &&
    minGradeLevel > maxGradeLevel
  ) {
    throw new BadRequestException(
      'Den lägsta årskursen får inte vara högre än den högsta.',
    );
  }
}

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
