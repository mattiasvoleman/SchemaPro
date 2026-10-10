/**
 * A child's published week as the school shows it to the family — the types
 * of GET /api/v1/family/schedule and the pure steps between that answer and
 * the screen. No React, no fetching: the hook is
 * lib/guardian-schedule-queries.ts and the card components/guardian/
 * child-schedule.tsx, and both are loaded with lazy() so /guardian (core
 * tier) carries only the import.
 *
 * What the answer is, and why it can be drawn as it stands:
 *
 *   * times are HH:MM strings on the SCHOOL's clock, made by the gateway. They
 *     are shown as they come and never pass through `new Date()`, so a parent
 *     abroad, or a laptop on the wrong zone, sees the times the school keeps;
 *   * dates are YYYY-MM-DD strings, compared as strings and turned into a
 *     weekday by their components, never by the reader's zone;
 *   * a lesson's teachers are what the school chose to show families
 *     (Publicering's "Läraren visas som"), empty for a cancelled or
 *     substituted lesson; the substitute is a flag, never a person;
 *   * no note, no cause, no absence reason and no other pupil is in it.
 */

export type FamilyLessonStatus = "SCHEDULED" | "COMPLETED" | "CANCELLED";

export interface FamilyLesson {
  id: string;
  date: string;
  start: string;
  end: string;
  startsAt: string;
  endsAt: string;
  subjectId: string;
  subject: string;
  subjectColor: string | null;
  room: string | null;
  teachers: string[];
  status: FamilyLessonStatus;
  substitute: boolean;
}

export interface FamilyMeal {
  id: string;
  date: string;
  start: string;
  end: string;
}

export interface FamilyRast extends FamilyMeal {
  name: string;
}

export interface FamilySchedule {
  student: { id: string; firstName: string };
  week: { from: string; to: string; isoWeek: string };
  /** The school's today. */
  today: string;
  /** Mondays of the first and last week the gateway will answer; latest null without an active year. */
  bounds: { earliest: string; latest: string | null };
  timezone: string;
  lessons: FamilyLesson[];
  lunches: FamilyMeal[];
  rasts: FamilyRast[];
}

export type FamilyEntry =
  | { kind: "LESSON"; key: string; start: string; end: string; lesson: FamilyLesson }
  | { kind: "RAST"; key: string; start: string; end: string; name: string }
  | { kind: "LUNCH"; key: string; start: string; end: string };

export interface FamilyDay {
  /** YYYY-MM-DD. */
  date: string;
  /** ISO weekday, 1 = Monday … 7 = Sunday. */
  weekday: number;
  entries: FamilyEntry[];
}

const ORDER: Record<FamilyEntry["kind"], number> = { LESSON: 0, RAST: 1, LUNCH: 2 };

/** A YYYY-MM-DD shifted by whole days, by its components (no reader zone involved). */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const moved = new Date(Date.UTC(y, m - 1, d + days));
  return moved.toISOString().slice(0, 10);
}

/** ISO weekday of a YYYY-MM-DD, 1 = Monday … 7 = Sunday. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
}

/** The Monday of the ISO week holding a YYYY-MM-DD. */
export function mondayOf(date: string): string {
  return shiftDate(date, 1 - weekdayOf(date));
}

/**
 * The week's days with what happens in them, in the order they are lived.
 *
 * Monday to Friday always, so an empty Wednesday reads as empty and not as
 * missing; Saturday and Sunday only when something is on them. Within a day,
 * by start, then lesson before rast before lunch, so a lesson ending as the
 * break starts reads in order. HH:MM strings sort as times.
 */
export function familyDays(schedule: FamilySchedule): FamilyDay[] {
  const byDate = new Map<string, FamilyEntry[]>();
  const push = (date: string, entry: FamilyEntry) => {
    const list = byDate.get(date);
    if (list) list.push(entry);
    else byDate.set(date, [entry]);
  };
  for (const lesson of schedule.lessons) {
    push(lesson.date, { kind: "LESSON", key: `L:${lesson.id}`, start: lesson.start, end: lesson.end, lesson });
  }
  for (const rast of schedule.rasts) {
    push(rast.date, { kind: "RAST", key: `R:${rast.id}`, start: rast.start, end: rast.end, name: rast.name });
  }
  for (const lunch of schedule.lunches) {
    push(lunch.date, { kind: "LUNCH", key: `M:${lunch.id}`, start: lunch.start, end: lunch.end });
  }
  const days: FamilyDay[] = [];
  for (let i = 0; i < 7; i++) {
    const date = shiftDate(schedule.week.from, i);
    const entries = byDate.get(date) ?? [];
    if (i >= 5 && entries.length === 0) continue;
    entries.sort((a, b) =>
      a.start !== b.start ? (a.start < b.start ? -1 : 1) : ORDER[a.kind] - ORDER[b.kind],
    );
    days.push({ date, weekday: i + 1, entries });
  }
  return days;
}

/** How a lesson stands for the family: cancelled wins over a substitute. */
export function lessonState(lesson: FamilyLesson): "cancelled" | "substitute" | "scheduled" {
  if (lesson.status === "CANCELLED") return "cancelled";
  if (lesson.substitute) return "substitute";
  return "scheduled";
}

/** Whether the week before / after the shown one may be asked for. */
export function canStep(schedule: Pick<FamilySchedule, "week" | "bounds">, direction: -1 | 1): boolean {
  const next = shiftDate(schedule.week.from, 7 * direction);
  if (direction < 0) return next >= schedule.bounds.earliest;
  return schedule.bounds.latest === null || next <= schedule.bounds.latest;
}

/** "v. 42" from the gateway's "2026-W42". */
export function weekNumber(isoWeek: string): number {
  return Number(isoWeek.slice(isoWeek.indexOf("W") + 1));
}
