import { apiRequest } from './api';
import { shiftDate } from '../i18n/format';

/**
 * A child's PUBLISHED week, as the school shows it to the family —
 * GET /api/v1/family/schedule, the same read the web's /guardian card makes.
 *
 * The gateway answers under the guardian's own RLS (20261013090000): another
 * family's child is the same 404 as an unknown id, the calendar is the
 * published layer (never a draft), and the answer carries no note, no cause,
 * no absence reason and no other pupil. Teachers are what the school chose to
 * show families, nobody on a cancelled or substituted lesson; the substitute
 * is a flag.
 *
 * Times are HH:MM strings on the SCHOOL's clock and dates YYYY-MM-DD; the
 * screen draws them as they come, so a phone on another zone shows the
 * school's day. The mapping below mirrors web/lib/family-schedule.ts — the
 * app is its own package, and a short rule is cheaper to keep in step than a
 * build-time link between the two.
 */

export type FamilyLessonStatus = 'SCHEDULED' | 'COMPLETED' | 'CANCELLED';

export interface FamilyLesson {
  readonly id: string;
  readonly date: string;
  readonly start: string;
  readonly end: string;
  readonly subject: string;
  readonly subjectColor: string | null;
  readonly room: string | null;
  readonly teachers: readonly string[];
  readonly status: FamilyLessonStatus;
  readonly substitute: boolean;
}

export interface FamilyMeal {
  readonly id: string;
  readonly date: string;
  readonly start: string;
  readonly end: string;
}

export interface FamilyRast extends FamilyMeal {
  readonly name: string;
}

export interface FamilySchedule {
  readonly student: { readonly id: string; readonly firstName: string };
  readonly week: { readonly from: string; readonly to: string; readonly isoWeek: string };
  readonly today: string;
  readonly bounds: { readonly earliest: string; readonly latest: string | null };
  readonly timezone: string;
  readonly lessons: readonly FamilyLesson[];
  readonly lunches: readonly FamilyMeal[];
  readonly rasts: readonly FamilyRast[];
}

export type FamilyEntry =
  | { readonly kind: 'LESSON'; readonly key: string; readonly start: string; readonly end: string; readonly lesson: FamilyLesson }
  | { readonly kind: 'RAST'; readonly key: string; readonly start: string; readonly end: string; readonly name: string }
  | { readonly kind: 'LUNCH'; readonly key: string; readonly start: string; readonly end: string };

export interface FamilyDay {
  readonly date: string;
  readonly entries: readonly FamilyEntry[];
}

/** The child's week; `week` is any day of it, or null for the school's own current week. */
export function fetchFamilySchedule(studentId: string, week: string | null): Promise<FamilySchedule> {
  const query = `studentId=${encodeURIComponent(studentId)}${week ? `&week=${encodeURIComponent(week)}` : ''}`;
  return apiRequest<FamilySchedule>(`/api/v1/family/schedule?${query}`);
}

const ORDER: Record<FamilyEntry['kind'], number> = { LESSON: 0, RAST: 1, LUNCH: 2 };

/**
 * The week's days in the order they are lived: Monday to Friday always (an
 * empty day reads as empty, not as missing), Saturday and Sunday only when
 * something is on them; within a day by start, a lesson before a rast before
 * the lunch at the same minute.
 */
export function familyDays(schedule: FamilySchedule): FamilyDay[] {
  const byDate = new Map<string, FamilyEntry[]>();
  const push = (date: string, entry: FamilyEntry): void => {
    const list = byDate.get(date);
    if (list) list.push(entry);
    else byDate.set(date, [entry]);
  };
  for (const lesson of schedule.lessons) {
    push(lesson.date, { kind: 'LESSON', key: `L:${lesson.id}`, start: lesson.start, end: lesson.end, lesson });
  }
  for (const rast of schedule.rasts) {
    push(rast.date, { kind: 'RAST', key: `R:${rast.id}`, start: rast.start, end: rast.end, name: rast.name });
  }
  for (const lunch of schedule.lunches) {
    push(lunch.date, { kind: 'LUNCH', key: `M:${lunch.id}`, start: lunch.start, end: lunch.end });
  }
  const days: FamilyDay[] = [];
  for (let i = 0; i < 7; i++) {
    const date = shiftDate(schedule.week.from, i);
    const entries = byDate.get(date) ?? [];
    if (i >= 5 && entries.length === 0) continue;
    entries.sort((a, b) => (a.start !== b.start ? (a.start < b.start ? -1 : 1) : ORDER[a.kind] - ORDER[b.kind]));
    days.push({ date, entries });
  }
  return days;
}

/** Cancelled wins over a substitute. */
export function lessonState(lesson: FamilyLesson): 'cancelled' | 'substitute' | 'scheduled' {
  if (lesson.status === 'CANCELLED') return 'cancelled';
  if (lesson.substitute) return 'substitute';
  return 'scheduled';
}

/** Whether the week before / after the shown one is one the gateway answers. */
export function canStep(schedule: Pick<FamilySchedule, 'week' | 'bounds'>, direction: -1 | 1): boolean {
  const next = shiftDate(schedule.week.from, 7 * direction);
  if (direction < 0) return next >= schedule.bounds.earliest;
  return schedule.bounds.latest === null || next <= schedule.bounds.latest;
}

/** 43 from "2026-W43". */
export function weekNumber(isoWeek: string): number {
  return Number(isoWeek.slice(isoWeek.indexOf('W') + 1));
}
