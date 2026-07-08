import type { CalendarLessonRow, Room, StudentGroup, Subject } from "@/lib/types";
import { subjectColor } from "@/lib/utils";
import type { TimetableLesson } from "@/components/schedule/timetable-grid";

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
