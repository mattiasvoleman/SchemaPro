import type { PrismaClient } from '@prisma/client';
import { sharedSeatsByRoom, type SharedRoomMode } from './shared-rooms';

/**
 * The two reads behind the rule of shared-rooms.ts, kept in one place so the
 * hand edit (MasterLessonsService.findConflicts) and the publish gate
 * (publication-gates.reader.ts) ask the database the same questions and read
 * the same answers: the school's setting, and the rooms it marked.
 */

/**
 * The school's Skolregler setting for shared rooms: OFF when the school has no
 * Skolregler row yet, which is the same as the rule being off. Asked by the
 * school itself where the caller holds it (a dated lesson), or by the läsår,
 * whose school is the one a row-level-security session that sees the year sees.
 */
export async function readSharedMode(
  tx: PrismaClient,
  of: { schoolId: string } | { academicYearId: string },
): Promise<SharedRoomMode> {
  const row =
    'schoolId' in of
      ? await tx.lunchSetting.findUnique({ where: { schoolId: of.schoolId }, select: { placementSharedMode: true } })
      : await tx.lunchSetting.findFirst({
          where: { school: { academicYears: { some: { id: of.academicYearId } } } },
          select: { placementSharedMode: true },
        });
  return row?.placementSharedMode ?? 'OFF';
}

/**
 * roomId → seats, for those of `roomIds` the school lets hold several lessons
 * at once under `mode`. Empty when the rule is off, and then nothing is read.
 */
export async function readSharedSeats(
  tx: PrismaClient,
  mode: SharedRoomMode,
  roomIds: readonly string[],
): Promise<Map<string, number>> {
  if (mode === 'OFF' || roomIds.length === 0) return new Map();
  const rooms = await tx.room.findMany({
    where: { id: { in: [...new Set(roomIds)] }, canBeShared: true, capacity: { not: null } },
    select: { id: true, canBeShared: true, capacity: true },
  });
  return sharedSeatsByRoom(mode, rooms);
}
