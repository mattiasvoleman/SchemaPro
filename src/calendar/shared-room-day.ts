import type { PrismaClient } from '@prisma/client';
import { crowdedWith } from '../common/shared-rooms';
import { readSharedMode, readSharedSeats } from '../common/shared-rooms.reader';
import { calendarLessonRosters } from './lesson-roster';

/**
 * DELADE SALAR ON A DATED LESSON: may a room that already holds a lesson over
 * these hours hold this one too?
 *
 * The day-to-day twin of what the grundschema's checks ask (common/
 * shared-rooms.ts, MasterLessonsService.findConflicts): a room change on one
 * date (CalendarLessonsService.changeRoom) and the reinstatement of a cancelled
 * lesson into its room (cancellation-core reversePlan) both refuse a room that
 * another SCHEDULED lesson stands in at the same time. A timetable the
 * generator laid with two classes in a shared hall has that on every ordinary
 * day, so both would refuse to put a lesson back where the timetable put it.
 * Asked only AFTER the plain test found a lesson in the room, so a day with no
 * clash asks the database nothing more.
 *
 * True only when the school holds the rule on (SOFT or HARD), the room is
 * marked shareable and has a capacity, and the pupils of the lesson and of
 * every SCHEDULED lesson in the room over its hours, counted together and once
 * each at every moment, fit the seats. Everything else is the refusal it was:
 * an unknown count, a room not marked, the rule off.
 *
 * WHO SITS IN A LESSON is the register's own answer (lesson-roster.ts): the
 * home classes and teaching groups of its groups and the pupils named on it,
 * active pupils only, less those a replacing group takes off it. A booking
 * (RoomBooking) has no pupils to count and keeps a room whole, as it did.
 *
 * Weeks do not enter: a dated lesson is one date, and two of them that fall on
 * it meet.
 */
export async function sharedRoomTakes(
  tx: PrismaClient,
  schoolId: string,
  lessonId: string,
  roomId: string,
  startsAt: Date,
  endsAt: Date,
): Promise<boolean> {
  const mode = await readSharedMode(tx, { schoolId });
  if (mode === 'OFF') return false;
  const seats = (await readSharedSeats(tx, mode, [roomId])).get(roomId);
  if (seats === undefined) return false;

  // The lesson itself (whose room it is, or is to be) and every other SCHEDULED
  // lesson in the room over its hours, in one statement.
  const lessons = await tx.calendarLesson.findMany({
    where: {
      OR: [
        { id: lessonId },
        { id: { not: lessonId }, status: 'SCHEDULED', roomId, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } },
      ],
    },
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      subjectId: true,
      studentGroupId: true,
      extraGroups: { select: { studentGroupId: true } },
    },
  });
  const own = lessons.find((lesson) => lesson.id === lessonId);
  if (!own) return false;
  const others = lessons.filter((lesson) => lesson.id !== lessonId);
  if (others.length === 0) return true;

  const rosters = await calendarLessonRosters(tx, lessons, { pupils: 'ACTIVE' });
  const minute = (at: Date) => at.getTime() / 60_000;
  const occupant = (lesson: (typeof lessons)[number]) => ({
    start: minute(lesson.startsAt),
    end: minute(lesson.endsAt),
    pupils: rosters.get(lesson.id) ?? new Set<string>(),
  });
  return crowdedWith(seats, occupant(own), others.map(occupant)).size === 0;
}
