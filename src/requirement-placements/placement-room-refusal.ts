import type { PrismaClient } from '@prisma/client';
import { roomAllowed, type RoomFact } from '../calendar/possible-times';
import type { GradeNumbering } from '../common/grade-numbering';
import { loadRosters, roomNeedsOf, type RoomNeeds } from '../optimization/room-eligibility';
import type { RosterBasis } from '../year-rollover/projected-rosters';
import type { RoomRefusalReason } from './placement-write-in';

/*
 * A FÖRLÄGGNINGS SAL (E4b): whether the generator would put the row's lesson in the room it names.
 *
 * The generator's own rule for a room is `roomAllowed` (calendar/possible-times.ts, the engine's `_room_allowed` and `_grade_allowed`), which is what a lay
 * in a room is held to (board-tray/lay-room.ts, BOARD_ROOM_NOT_ALLOWED): fewer seats than the pupils, another kind of room than the subject needs, or years
 * the room is fenced from. The week judges a förläggning by the clash rule and the board's rules and nothing of this, because to the engine a row with a room
 * is a lock that names it, and a lock is a fact. A lesson the bridge makes by hand is held to the lay's rule, and a row that fails it is left and named.
 * This is that rule asked of all the rows of the year at once, with the same needs the generator and the room optimisation read (roomNeedsOf).
 */

/** Which part of the rule fails, in the order a lay says it (the seats, then the kind, then the years), or null when the room is allowed. */
export function roomRefusalReason(room: RoomFact, needs: RoomNeeds): RoomRefusalReason | null {
  if (roomAllowed(room, needs)) return null;
  if (room.capacity !== null && room.capacity < needs.studentGroupSize) return 'SEATS';
  if (needs.requiredRoomTypeId !== null && room.roomTypeId !== needs.requiredRoomTypeId) return 'TYPE';
  return 'YEARS';
}

/**
 * The rows (by id) whose room the generator would not take, with the room and why. One read of the rooms, the subjects, the year's classes and its
 * pupils for all the rows. A row with no room, and a room that is not one of the school's (which the write's foreign key answers as it does for every
 * hand edit), have no answer.
 */
export async function roomRefusalsOf(
  tx: PrismaClient,
  year: { id: string; gradeNumbering: GradeNumbering | string | null },
  basis: RosterBasis,
  rows: ReadonlyArray<{ id: string; roomId: string | null; studentGroupId: string; subjectId: string }>,
): Promise<Map<string, { roomId: string; reason: RoomRefusalReason }>> {
  const withRoom = rows.filter((row): row is typeof row & { roomId: string } => row.roomId !== null);
  const refusals = new Map<string, { roomId: string; reason: RoomRefusalReason }>();
  if (withRoom.length === 0) return refusals;
  const roomIds = [...new Set(withRoom.map((row) => row.roomId))];
  const subjectIds = [...new Set(withRoom.map((row) => row.subjectId))];
  const groupIds = [...new Set(withRoom.map((row) => row.studentGroupId))];
  const [rooms, subjects, groups] = await Promise.all([
    tx.room.findMany({ where: { id: { in: roomIds } }, select: { id: true, name: true, capacity: true, roomTypeId: true, minGradeLevel: true, maxGradeLevel: true, building: true } }),
    tx.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, requiredRoomTypeId: true } }),
    tx.studentGroup.findMany({ where: { academicYearId: year.id }, select: { id: true, gradeLevel: true, halfOfId: true } }),
  ]);
  const roomById = new Map(rooms.map((room) => [room.id, room]));
  const requiredTypeOf = new Map(subjects.map((subject) => [subject.id, subject.requiredRoomTypeId ?? null]));
  const rosters = await loadRosters(tx, basis, groupIds, groups);
  const numbering = (year.gradeNumbering ?? 'NIOARIG') as GradeNumbering;
  for (const row of withRoom) {
    const room = roomById.get(row.roomId);
    if (!room) continue;
    const needs = roomNeedsOf(rosters, { groupIds: [row.studentGroupId] }, { requiredRoomTypeId: requiredTypeOf.get(row.subjectId) ?? null }, numbering);
    const reason = roomRefusalReason(room, needs);
    if (reason !== null) refusals.set(row.id, { roomId: row.roomId, reason });
  }
  return refusals;
}
