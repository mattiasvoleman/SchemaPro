/**
 * Delade lokaler och lärare, the generator's half: the times a shared teacher
 * is held at another school of the huvudman, as the blocks the engine keeps
 * the teacher out of (Restid i generatorn's padding, across schools).
 *
 * The other school's lessons come from app.shared_teacher_busy: weekday,
 * times, weeks, dates and the minutes between the two schools, nothing of
 * the lesson itself. Each is widened by the travel minutes on both sides (a
 * lesson here has to end that long before, and may start that long after),
 * rounded OUTWARD to the engine's slot grid (the engine refuses a
 * reservation off its grid, INPUT_CONSTRAINT_TIME_OFF_GRID, and rounding
 * inward would let a lesson start inside the walk), and merged per teacher
 * and weekday where they touch or overlap, so the payload carries one row
 * where the school would say "Anna is at Norra on Tuesday mornings".
 *
 * Only Monday to Friday, the days the engine plans: it refuses a
 * reservation on any other day as input.
 *
 * The engine has no weeks: a lesson elsewhere in odd weeks only, or for one
 * term, holds the teacher every week of the plan, as a locked lesson does
 * today (FixedLesson). Conservative on purpose: the publish check
 * (PUB_OTHER_SCHOOL) reads the weeks, and a block the engine keeps free is
 * never a clash.
 *
 * PURE.
 */
import type { LessonRecurrence } from '@prisma/client';

export interface LessonElsewhere {
  /** This school's own row of the teacher. */
  teacherId: string;
  /** The other school. */
  schoolId: string;
  dayOfWeek: number;
  /** 'HH:MM' or 'HH:MM:SS'. */
  startTime: string;
  endTime: string;
  recurrence: LessonRecurrence;
  /** 'YYYY-MM-DD', inclusive. */
  startDate: string;
  endDate: string;
  /** Minutes between the two schools; null when neither has said (no padding). */
  travelMinutes: number | null;
}

export interface BusyBlock {
  teacherId: string;
  dayOfWeek: number;
  /** Minutes after midnight, on the slot grid. */
  start: number;
  end: number;
  /** The other schools whose lessons the block holds, in id order. */
  schoolIds: string[];
  /** Whether a travel time between the schools widened it. */
  walked: boolean;
}

const DAY_END = 24 * 60;

export function minutesOf(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

export function clockOf(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
}

/**
 * The blocks of the lessons that meet [from, to] (inclusive dates), widened,
 * aligned to `slotMinutes` and merged, ordered by teacher, day and start.
 */
export function busyBlocks(
  lessons: readonly LessonElsewhere[],
  slotMinutes: number,
  from: string,
  to: string,
): BusyBlock[] {
  const byKey = new Map<
    string,
    { teacherId: string; dayOfWeek: number; spans: { start: number; end: number; schoolId: string; walked: boolean }[] }
  >();
  for (const lesson of lessons) {
    if (lesson.endDate < from || lesson.startDate > to) continue;
    // The engine plans Monday to Friday and refuses a reservation on any
    // other day as input; a lesson elsewhere on a Saturday holds nothing here.
    if (lesson.dayOfWeek < 1 || lesson.dayOfWeek > 5) continue;
    const travel = Math.max(0, lesson.travelMinutes ?? 0);
    const start = Math.max(0, Math.floor((minutesOf(lesson.startTime) - travel) / slotMinutes) * slotMinutes);
    const end = Math.min(DAY_END, Math.ceil((minutesOf(lesson.endTime) + travel) / slotMinutes) * slotMinutes);
    if (end <= start) continue;
    const key = `${lesson.teacherId}|${lesson.dayOfWeek}`;
    const entry = byKey.get(key) ?? { teacherId: lesson.teacherId, dayOfWeek: lesson.dayOfWeek, spans: [] };
    entry.spans.push({ start, end, schoolId: lesson.schoolId, walked: travel > 0 });
    byKey.set(key, entry);
  }
  const blocks: BusyBlock[] = [];
  for (const entry of byKey.values()) {
    const spans = [...entry.spans].sort((a, b) => a.start - b.start || a.end - b.end);
    let current: BusyBlock | null = null;
    for (const span of spans) {
      if (current && span.start <= current.end) {
        current.end = Math.max(current.end, span.end);
        current.walked = current.walked || span.walked;
        if (!current.schoolIds.includes(span.schoolId)) current.schoolIds.push(span.schoolId);
      } else {
        if (current) blocks.push(current);
        current = {
          teacherId: entry.teacherId,
          dayOfWeek: entry.dayOfWeek,
          start: span.start,
          end: span.end,
          schoolIds: [span.schoolId],
          walked: span.walked,
        };
      }
    }
    if (current) blocks.push(current);
  }
  for (const block of blocks) block.schoolIds.sort();
  return blocks.sort(
    (a, b) => a.teacherId.localeCompare(b.teacherId) || a.dayOfWeek - b.dayOfWeek || a.start - b.start,
  );
}
