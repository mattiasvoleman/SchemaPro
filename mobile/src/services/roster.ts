import { ApiError, apiRequest } from './api';
import { getCalendarLesson, upsertCalendarLesson, upsertStudents } from './database/localDatabase';
import { sortByDisplayName } from '../utils/sorting';
import type { MessageKey } from '../i18n';
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
 * What tapping a lesson came to.
 *
 * OPEN: the register opens with `lesson`. `fromCache` when the gateway did not
 * answer and the copy this phone last saved stands in; the register says so.
 * NOT_OPENED: the schedule shows `message`, or, when that is null, keeps what
 * its own reload said.
 */
export type LessonOpening =
  | { readonly kind: 'OPEN'; readonly lesson: CalendarLesson; readonly fromCache: boolean }
  | { readonly kind: 'NOT_OPENED'; readonly message: MessageKey | null };

/**
 * Opens a lesson for attendance: asks the gateway for its roster and writes
 * both to the encrypted offline cache, which the register reads its names
 * from.
 *
 * A refusal (403/404) is final, and no cached copy stands in for it: the list
 * would be taken and then refused when sent. The schedule the teacher tapped
 * is older than the school's, so it is read again (`reload`), and the refusal
 * is said only once that read has succeeded. Over a schedule that failed to
 * load it would explain a row that is still there and hide why.
 *
 * Anything else is not an answer about the lesson: the gateway down or
 * unreachable while Supabase answers, a 5xx, or a 429 under the per-address
 * limit that a school or a kommun behind one address shares. The register
 * opened through Supabase alone before it asked the gateway, so an outage of
 * the gateway does not stop it now. The copy this phone last cached, by an
 * earlier open or a broadcast, opens instead: the lesson as the schedule shows
 * it, the pupils as last saved. Its marks go to the queue under the lesson's
 * id like any others and are sent when the gateway answers. Only with nothing
 * cached does the tap fail, and a 429 then says to wait a minute.
 */
export async function openLessonForAttendance(
  lesson: Omit<CalendarLesson, 'studentIds'>,
  reload: () => Promise<boolean>,
): Promise<LessonOpening> {
  let roster: RosterPupil[];
  try {
    roster = await fetchRoster(lesson.id);
  } catch (error) {
    const refusal = rosterRefusal(error);
    if (refusal !== null) {
      return { kind: 'NOT_OPENED', message: (await reload()) ? `schedule.refused.${refusal}` : null };
    }
    const cached = await getCalendarLesson(lesson.id).catch(() => null);
    if (cached !== null) {
      return { kind: 'OPEN', lesson: withPupils(lesson, cached.studentIds), fromCache: true };
    }
    const busy = error instanceof ApiError && error.status === 429;
    return { kind: 'NOT_OPENED', message: busy ? 'schedule.busy' : 'schedule.openError' };
  }
  return { kind: 'OPEN', lesson: await cacheRoster(lesson, roster), fromCache: false };
}

/**
 * The lesson and the roster the gateway answered, written to the cache.
 *
 * The lesson's pupils are exactly the ones the gateway named, the set a later
 * broadcast replaces them with. displayName is built here and stays on-device
 * only (encrypted SQLite) — never sent to APIs.
 */
async function cacheRoster(
  lesson: Omit<CalendarLesson, 'studentIds'>,
  roster: readonly RosterPupil[],
): Promise<CalendarLesson> {
  const students = sortByDisplayName(
    roster.map((pupil) => ({
      id: pupil.id,
      displayName: `${pupil.firstName} ${pupil.lastName}`,
      photoUri: null,
    })),
  );

  const cached = withPupils(lesson, students.map((student) => student.id));

  await upsertStudents(students);
  await upsertCalendarLesson(cached);
  return cached;
}

function withPupils(lesson: Omit<CalendarLesson, 'studentIds'>, studentIds: readonly string[]): CalendarLesson {
  return {
    id: lesson.id,
    startTime: lesson.startTime,
    endTime: lesson.endTime,
    subjectName: lesson.subjectName,
    roomName: lesson.roomName,
    studentIds,
  };
}
