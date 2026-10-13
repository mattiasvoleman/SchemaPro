import { ApiError, apiRequest } from './api';
import { upsertCalendarLesson, upsertStudents } from './database/localDatabase';
import { sortByDisplayName } from '../utils/sorting';
import type { CalendarLesson } from '../types';

/**
 * Everyone who is actually in the room, as the gateway answers it.
 *
 * GET /api/v1/attendance/lessons/:lessonId/roster asks the one roster reader
 * (src/calendar/lesson-roster.ts) for the lesson's active pupils: the home
 * classes of its own class and of every group joined to it, the teaching-group
 * members of those groups, and the pupils named on the lesson. The broadcast
 * of a changed lesson (realtime.service.ts) asks the same reader with the same
 * filter, and its studentIds replace what is cached here, so the register no
 * longer depends on which of the two came last. The app used to build the
 * union itself from four Supabase reads; a change to who attends a lesson
 * would then have reached the web register, the check and the broadcast, but
 * not the list a teacher ticks down on the phone.
 *
 * Names only. The gateway orders them by Postgres collation for a stable
 * answer; the list is put in Swedish order on the device.
 */

export interface RosterPupil {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
}

export function fetchRoster(calendarLessonId: string): Promise<RosterPupil[]> {
  return apiRequest<{ students: RosterPupil[] }>(
    `/api/v1/attendance/lessons/${encodeURIComponent(calendarLessonId)}/roster`,
  ).then((answer) => answer.students);
}

/**
 * Why the gateway will not give this teacher the roster, when that is the
 * answer rather than a failure to reach it.
 *
 * NOT_ASSIGNED (403): the teacher is not on the lesson. The register they
 * would take could never be sent either — recording asks the same question —
 * so the list is not opened at all, rather than filled and left in the queue.
 * NOT_FOUND (404): the lesson is gone, or RLS hides it. Either way the
 * schedule the teacher tapped is older than the school's.
 */
export type RosterRefusal = 'NOT_ASSIGNED' | 'NOT_FOUND';

export function rosterRefusal(error: unknown): RosterRefusal | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 403) return 'NOT_ASSIGNED';
  if (error.status === 404) return 'NOT_FOUND';
  return null;
}

/**
 * The lesson and its roster, written to the encrypted offline cache for the
 * register to open with.
 *
 * Nothing is written before the gateway has answered: a refusal (above), or
 * no answer at all, leaves the cache as it was. The lesson's pupils are
 * exactly the ones the gateway named, the set a later broadcast replaces them
 * with. displayName is built here and stays on-device only (encrypted SQLite)
 * — never sent to APIs.
 */
export async function cacheLessonForAttendance(
  lesson: Omit<CalendarLesson, 'studentIds'>,
): Promise<CalendarLesson> {
  const roster = await fetchRoster(lesson.id);

  const students = sortByDisplayName(
    roster.map((pupil) => ({
      id: pupil.id,
      displayName: `${pupil.firstName} ${pupil.lastName}`,
      photoUri: null,
    })),
  );

  const cached: CalendarLesson = {
    id: lesson.id,
    startTime: lesson.startTime,
    endTime: lesson.endTime,
    subjectName: lesson.subjectName,
    roomName: lesson.roomName,
    studentIds: students.map((student) => student.id),
  };

  await upsertStudents(students);
  await upsertCalendarLesson(cached);
  return cached;
}
