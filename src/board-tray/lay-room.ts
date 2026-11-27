import type { PrismaClient } from '@prisma/client';
import { roomAllowed } from '../calendar/possible-times';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { loadRosters, roomNeedsOf } from '../optimization/room-eligibility';
import { rostersOfYear } from '../year-rollover/projected-rosters';

/** The problem `code` of a lay in a room the generator would not put the lesson in. The page offers "Utan sal" (no `roomId`) instead. */
export const BOARD_ROOM_NOT_ALLOWED = 'BOARD_ROOM_NOT_ALLOWED';

/** Why the generator would not use the room: fewer seats than the pupils, another kind than the subject needs, or years the room is fenced from. */
export type LayRoomReason = 'SEATS' | 'TYPE' | 'YEARS';

/**
 * Whether the generator's own rule for a room (calendar/possible-times.ts roomAllowed, the engine's `_room_allowed` and `_grade_allowed`) lets a lesson of
 * this class and subject stand in this room, with the same needs the generator and the room optimisation read (roomNeedsOf over the year's basis). A lay
 * is the brick's one write, and its roadmap row (E4 Klart e) says the lesson is laid in a room the generator would approve, or as "Utan sal": the judge
 * refuses a room that is taken or shut, and nothing else asks about seats, kind or years. null when the room is allowed (or is not a room of the school,
 * which the write's foreign key answers as it does for every hand edit).
 */
export async function layRoomRefusal(
  tx: PrismaClient,
  user: AuthenticatedUser,
  brick: { academicYearId: string; studentGroupId: string; subjectId: string; roomId: string },
): Promise<LayRoomReason | null> {
  const [year, room, subject, groups] = await Promise.all([
    tx.academicYear.findUnique({ where: { id: brick.academicYearId }, select: { id: true, isActive: true, predecessorId: true, gradeNumbering: true } }),
    tx.room.findUnique({ where: { id: brick.roomId }, select: { id: true, name: true, capacity: true, roomTypeId: true, minGradeLevel: true, maxGradeLevel: true, building: true } }),
    tx.subject.findUnique({ where: { id: brick.subjectId }, select: { requiredRoomTypeId: true } }),
    tx.studentGroup.findMany({ where: { academicYearId: brick.academicYearId }, select: { id: true, gradeLevel: true, halfOfId: true } }),
  ]);
  if (!year || !room) return null;
  const basis = await rostersOfYear(tx, user, year.id, year);
  const rosters = await loadRosters(tx, basis, [brick.studentGroupId], groups);
  const needs = roomNeedsOf(rosters, { groupIds: [brick.studentGroupId] }, { requiredRoomTypeId: subject?.requiredRoomTypeId ?? null }, year.gradeNumbering ?? 'NIOARIG');
  if (roomAllowed(room, needs)) return null;
  if (room.capacity !== null && room.capacity < needs.studentGroupSize) return 'SEATS';
  if (needs.requiredRoomTypeId !== null && room.roomTypeId !== needs.requiredRoomTypeId) return 'TYPE';
  return 'YEARS';
}
