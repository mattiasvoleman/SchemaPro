import { isoWeekday } from '../calendar/publish-days';

/*
 * PROVPLANERING: WHAT THE ENGINE IS ASKED, AS PURE FUNCTIONS.
 *
 * An exam is placed in the same calendar a schemabrytande aktivitet acts on
 * (src/publication/activity-plan.ts): it cancels the lessons of its classes
 * that overlap it and a replacement lesson per class carries the register. So
 * a time is only a candidate when it lands on lessons the activity can take,
 * and what it costs is the teaching it takes away. These functions say which
 * times those are, what each costs, which classes sit in which room and which
 * reasons the gateway itself gives for an exam that has no time at all. No
 * Prisma, no clock: the service reads, these decide.
 *
 * ## The candidate times
 *
 * A start is a minute some lesson of the exam's classes starts on that day
 * (a FIXED exam has its one start). It is a candidate when the exam, from
 * that minute for its length, fits the day's bounds and every named class or
 * group has a lesson to be cancelled in it: the activity refuses an exam that
 * takes no lesson (it would have no register to carry), and a class with no
 * lesson in the time has nothing to replace.
 *
 * ## What a time costs (`loss`)
 *
 * The lesson minutes it takes away, each cancelled lesson once however many
 * of the exam's classes it belongs to, except the minutes of the exam's own
 * subject: those come back as the credit the exam writes (the credit is the
 * exam's own minutes, so a math exam laid on a math lesson loses nothing).
 *
 * ## Days
 *
 * Mondays to Fridays inside the window, from tomorrow (the activity takes
 * lessons that have not begun, and its credits are written for days after
 * today), and not a day the school has closed for any of the exam's classes.
 */

export interface PlanLesson {
  id: string;
  /** The school's day, YYYY-MM-DD. */
  date: string;
  /** Minute of the school's day. */
  start: number;
  end: number;
  subjectId: string;
  /** The lesson's own group and its extra groups. */
  groupIds: readonly string[];
}

export interface ExamToPlan {
  id: string;
  subjectId: string;
  lengthMinutes: number;
  windowKind: 'WEEK' | 'FIXED';
  from: string;
  to: string;
  fixedStart: number | null;
  earliestStart: number | null;
  latestEnd: number | null;
  /** The groups the administrator named. */
  named: readonly string[];
  /** For each named group, the groups its cancellation reaches: itself, its halves, the groups wholly inside it. */
  coverOf: ReadonlyMap<string, ReadonlySet<string>>;
  /** The days the exam's classes are off school. */
  closed: ReadonlySet<string>;
}

export interface Slot {
  date: string;
  start: number;
  end: number;
  loss: number;
}

/** Why an exam has no candidate time, said by the gateway before the engine is asked. */
export type SlotShortage = 'EXAM_WINDOW_CLOSED' | 'EXAM_NO_LESSON_TO_REPLACE' | 'EXAM_OUTSIDE_HOURS';

export const clockOf = (minute: number): string =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

export const minuteOf = (clock: string): number => {
  const [hours, minutes] = clock.split(':');
  return Number(hours) * 60 + Number(minutes);
};

/** A YYYY-MM-DD that is a day of the calendar: the pattern alone lets 2026-11-31 through, and 2026-11-32 reaches the database. */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** The dates of [from, to], inclusive. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const last = new Date(`${to}T00:00:00.000Z`);
  while (cursor <= last) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/** The school days of an exam's window that can hold it: weekdays after today, not closed for its classes. */
export function windowDays(exam: ExamToPlan, today: string): string[] {
  return datesBetween(exam.from, exam.to).filter(
    (date) => date > today && isoWeekday(date) <= 5 && !exam.closed.has(date),
  );
}

/**
 * The times an exam can be laid, with what each costs. `lessonsByDate` holds
 * the lessons the activity could take on each date (not begun, no register)
 * of any group the exam touches.
 */
export function candidateSlots(
  exam: ExamToPlan,
  lessonsByDate: ReadonlyMap<string, readonly PlanLesson[]>,
  today: string,
): { slots: Slot[]; shortage: SlotShortage | null } {
  const days = windowDays(exam, today);
  if (days.length === 0) return { slots: [], shortage: 'EXAM_WINDOW_CLOSED' };
  const slots: Slot[] = [];
  let tried = false;
  let fitted = false;
  for (const date of days) {
    const lessons = lessonsByDate.get(date) ?? [];
    const starts =
      exam.windowKind === 'FIXED' && exam.fixedStart !== null
        ? [exam.fixedStart]
        : [...new Set(lessons.map((lesson) => lesson.start))].sort((a, b) => a - b);
    for (const start of starts) {
      tried = true;
      const end = start + exam.lengthMinutes;
      if (end > 1440) continue;
      if (exam.windowKind === 'WEEK') {
        if (exam.earliestStart !== null && start < exam.earliestStart) continue;
        if (exam.latestEnd !== null && end > exam.latestEnd) continue;
      }
      fitted = true;
      const cancelled = lessons.filter((lesson) => lesson.start < end && start < lesson.end);
      const everyGroupHasOne = exam.named.every((group) => {
        const cover = exam.coverOf.get(group);
        return cancelled.some((lesson) => lesson.groupIds.some((id) => cover?.has(id) === true));
      });
      if (!everyGroupHasOne) continue;
      const loss = cancelled
        .filter((lesson) => lesson.subjectId !== exam.subjectId)
        .reduce((sum, lesson) => sum + (lesson.end - lesson.start), 0);
      slots.push({ date, start, end, loss });
    }
  }
  if (slots.length > 0) return { slots, shortage: null };
  // No lesson starts on any day of the window: nothing to replace. Starts that none of the day's hours holds: outside the hours.
  return { slots, shortage: tried && !fitted ? 'EXAM_OUTSIDE_HOURS' : 'EXAM_NO_LESSON_TO_REPLACE' };
}

/** A class or group with the number of pupils its replacement lesson will register. */
export interface Seated {
  groupId: string;
  pupils: number;
}

export interface SeatedIn {
  groupId: string;
  /** The writers of this group that sit in the room. */
  writers: number;
}

/**
 * Which writers sit in which room. The engine says how many sit in each room;
 * the groups are dealt into the rooms in order, a group's pupils filling a room
 * before the next room is begun, so a class stays together unless the room is
 * full. The shares are the group's part of the exam's writers by its pupils,
 * rounded so that they sum to the writers (largest remainder).
 *
 * Returned per room, in the rooms' order given; a group appears in every room
 * it overflows into. Used to put the room's invigilators on the replacement
 * lesson of each class that sits there.
 */
export function seatGroups(
  groups: readonly Seated[],
  writers: number,
  rooms: ReadonlyArray<{ roomId: string; writers: number }>,
): Array<{ roomId: string; groups: SeatedIn[] }> {
  const total = groups.reduce((sum, group) => sum + group.pupils, 0);
  const shares = shareOut(groups, writers, total);
  const out = rooms.map((room) => ({ roomId: room.roomId, groups: [] as SeatedIn[], left: room.writers }));
  let at = 0;
  groups.forEach((group, index) => {
    let remaining = shares[index];
    while (remaining > 0 && at < out.length) {
      const room = out[at];
      if (room.left === 0) {
        at += 1;
        continue;
      }
      const take = Math.min(room.left, remaining);
      room.groups.push({ groupId: group.groupId, writers: take });
      room.left -= take;
      remaining -= take;
      if (room.left === 0) at += 1;
    }
  });
  // A group with no pupils on the roll still sits somewhere: with the first room's writers.
  return out.map((room) => ({ roomId: room.roomId, groups: room.groups }));
}

function shareOut(groups: readonly Seated[], writers: number, total: number): number[] {
  if (groups.length === 0) return [];
  if (total === 0) {
    // Nobody on the roll: the writers are split evenly, the remainder to the first.
    const base = Math.floor(writers / groups.length);
    return groups.map((_, index) => base + (index < writers - base * groups.length ? 1 : 0));
  }
  const exact = groups.map((group) => (group.pupils * writers) / total);
  const floors = exact.map(Math.floor);
  let rest = writers - floors.reduce((sum, part) => sum + part, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const { index } of order) {
    if (rest === 0) break;
    floors[index] += 1;
    rest -= 1;
  }
  return floors;
}

/** The invigilators a room with this many writers needs. */
export const invigilatorsNeeded = (writers: number, writersPerInvigilator: number): number =>
  Math.max(1, Math.ceil(writers / writersPerInvigilator));

/** The ISO week a date falls in as a running key (year-week), for the week index. */
export function weekKeyOf(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  const weekday = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + 4 - weekday);
  const year = d.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.ceil(((d.getTime() - jan1) / 86_400_000 + 1) / 7);
  return `${year}-${String(week).padStart(2, '0')}`;
}

/** Running indexes for the dates and ISO weeks a request touches, assigned in date order. */
export function indexDates(dates: Iterable<string>): { day: Map<string, number>; week: Map<string, number> } {
  const sorted = [...new Set(dates)].sort();
  const day = new Map<string, number>();
  const week = new Map<string, number>();
  for (const date of sorted) {
    day.set(date, day.size);
    const key = weekKeyOf(date);
    if (!week.has(key)) week.set(key, week.size);
  }
  return { day, week };
}
