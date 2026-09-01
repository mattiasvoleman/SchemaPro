import type {
  CalendarLessonRow,
  CalendarLunch,
  Room,
  StudentGroup,
  Subject,
} from "@/lib/types";
import { subjectColor } from "@/lib/utils";
import type {
  TimetableBand,
  TimetableLesson,
} from "@/components/schedule/timetable-grid";

/** ISO weekday (1=Mon..7=Sun) from a YYYY-MM-DD date string. */
export function isoWeekdayOf(dateString: string): number {
  const date = new Date(`${dateString}T00:00:00`);
  return ((date.getDay() + 6) % 7) + 1;
}

function minutesOf(timestamp: string): number {
  const date = new Date(timestamp);
  return date.getHours() * 60 + date.getMinutes();
}

export function calendarLessonToGrid(
  lesson: CalendarLessonRow,
  subjectById: Map<string, Subject>,
  groupById: Map<string, StudentGroup>,
  roomById: Map<string, Room>,
): TimetableLesson {
  const subject = subjectById.get(lesson.subjectId);
  const group = groupById.get(lesson.studentGroupId);
  const room = lesson.roomId ? roomById.get(lesson.roomId) : undefined;
  return {
    id: lesson.id,
    dayOfWeek: isoWeekdayOf(lesson.date),
    startMinutes: minutesOf(lesson.startsAt),
    endMinutes: minutesOf(lesson.endsAt),
    title: subject?.name ?? "",
    subtitle: group?.name,
    room: room?.name,
    color: subjectColor(lesson.subjectId, subject?.color),
    cancelled: lesson.status === "CANCELLED",
  };
}

/**
 * A dated meal as a stripe for the grid.
 *
 * Shares `minutesOf` with the lessons deliberately. That helper reads the
 * instant in the READER's local time, not the school's — which is a limitation
 * the whole calendar has, not one this function introduces. Positioning the
 * meal by a different rule would make it drift away from the lessons around it
 * for anyone abroad, and a lunch sitting between the wrong two lessons reads as
 * a bug in a way an hour's offset shared by everything does not.
 */
export function calendarLunchToBand(lunch: CalendarLunch, label: string): TimetableBand {
  return {
    id: lunch.id,
    dayOfWeek: isoWeekdayOf(lunch.date),
    startMinutes: minutesOf(lunch.startsAt),
    endMinutes: minutesOf(lunch.endsAt),
    label,
  };
}
