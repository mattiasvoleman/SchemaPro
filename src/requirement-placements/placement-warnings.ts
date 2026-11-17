import type { LessonRecurrence } from '@prisma/client';
import { SLOT_MINUTES } from '../common/solver-grid';
import {
  teacherDayBreaches,
  unionMinutes,
  weeksOf,
  type TeacherDayBreach,
  type TeacherDayRule,
  type TeachingLesson,
  type YearSpan,
} from '../common/teacher-day';

/*
 * VARNINGAR MEDAN MAN LÄGGER (D1): WHAT THE FIXED WEEK ALREADY SAYS ABOUT A
 * FÖRLÄGGNING, AND WHAT GENERERA WILL DO ABOUT IT.
 *
 * The judge (placement-judge.ts) answers "may this row stand": a refusal stops
 * a save. A warning never does (the user's decision 5, 2026-11-13: a school
 * that gives a teacher a long day by hand has decided to). It says what the
 * week the school has fixed so far already breaks, and, where the answer is
 * certain, that Generera will refuse the week for that very reason.
 *
 * THE FIXED WEEK is what Generera does not move: the lessons it keeps
 * (preserved-lessons.ts) and the förläggningar. A förläggning with a room is
 * a lock to the engine, a fact that only takes room away from what it places.
 * A förläggning with no room is a pinned lesson (B1, #317): a lesson the
 * engine places itself, at a time it is given, and held to the school's rules
 * like any other (the user's decision 12). That difference is the whole of
 * `refuses`, and the arithmetic below says it per rule:
 *
 *   TEACHER_DAY_TOO_LONG   the teacher's fixed lessons run longer than their
 *                          cap on a weekday. The engine takes locks as they
 *                          are, so a week of locks alone is only said. A pin
 *                          is placed, and refuses when its minutes do not fit
 *                          what the locks leave of the cap
 *                          (`_verify_teacher_day_rules` and the day's
 *                          constraint, both on residual = cap - locked).
 *   TEACHER_WEEK_TOO_MANY_DAYS
 *                          the same for the days. The locks' own weekdays are
 *                          L; a week of pins P refuses when the pins take
 *                          more days than the limit leaves beside L:
 *                          |P \ L| > max(0, N - |L|).
 *   TEACHER_STRETCH_TOO_LONG
 *                          never refuses: the generator keeps the limit for
 *                          teaching in a row as a wish.
 *   CLASS_HAS_NO_LUNCH     the class's own fixed lessons leave no start for
 *                          the lunch break inside the school's window
 *                          (LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK). Always
 *                          refuses: a lock is arithmetic, and a pin is a
 *                          lesson the lunch has to keep clear of.
 *   NO_ROOM_FREE           a pin whose subject needs a room type has no room
 *                          of that type free: the fixed lessons in rooms of
 *                          the type and the other pins hold every room there
 *                          is. Always refuses, since a pin is placed.
 *
 * ONLY WHERE THE ANSWER IS CERTAIN does a warning say `refuses`. What is left
 * out of each count makes it quieter than the engine and never louder
 * (servings, frames and the class's own unavailable hours narrow a lunch
 * further; a room's capacity, years and unavailability narrow its rooms
 * further; the pupils a teaching group shares with a class reach the class's
 * lunch in the engine and not here): Generera may still refuse a week that has
 * no warning, and never the other way round, which is what the adapter probe
 * pins against the real engine.
 *
 * WEEKS, NOT PERIODS. Every count reads the weeks lessons run in together
 * (common/teacher-day.ts weeksOf), as the hand edit does, and never a period
 * index: a läsår has many more periods than terms, and a cause that spans
 * several of them is one cause (periods-are-not-terms). The class's lunch
 * reads a lesson of odd weeks and one of even weeks together, as the engine
 * does, since the meal is the same every week.
 *
 * PURE. Times are minutes since midnight, dates 'YYYY-MM-DD'.
 */

export type PlacementWarningCode =
  | 'TEACHER_DAY_TOO_LONG'
  | 'TEACHER_WEEK_TOO_MANY_DAYS'
  /** The post's days are HR data: the reader without HR-läs is told there is a limit and not what it is. */
  | 'TEACHER_WEEK_TOO_MANY_DAYS_HIDDEN'
  | 'TEACHER_STRETCH_TOO_LONG'
  | 'TEACHER_STRETCH_TOO_LONG_HIDDEN'
  | 'CLASS_HAS_NO_LUNCH'
  | 'NO_ROOM_FREE';

export type PlacementWarningParams = Record<string, string | number>;

export interface PlacementWarning {
  code: PlacementWarningCode;
  /**
   * Whether Generera will refuse the week because of what this says. True only where the arithmetic proves it; false
   * is not a promise that it will not (the engine may find another reason), only that this one does not stop it.
   */
  refuses: boolean;
  params?: PlacementWarningParams;
}

/** A warning as an answer states it: whose row it is about, in the answer's own rows. */
export interface PlacementWarningView extends PlacementWarning {
  /** The row's id in the same answer (a post's row, or a block's lesson). */
  rowId: string;
  requirementId: string;
  /** A block's lesson: the block it is in. */
  blockId?: string;
}

/** One lesson of the fixed week. */
export interface FixedItem {
  /** The place in the caller's list of rows to warn about; null for a lesson Generera keeps and for a row beside. */
  row: number | null;
  /** A förläggning with no room: the engine places it itself, at this time (B1). */
  pin: boolean;
  teacherIds: readonly string[];
  groupIds: readonly string[];
  subjectId: string;
  roomId: string | null;
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
  recurrence: LessonRecurrence;
  startDate: string | null;
  endDate: string | null;
}

export type WarningsByRow = Map<number, PlacementWarning[]>;

const add = (into: WarningsByRow, row: number, warning: PlacementWarning): void => {
  const list = into.get(row);
  if (!list) into.set(row, [warning]);
  else if (!list.some((held) => held.code === warning.code && JSON.stringify(held.params) === JSON.stringify(warning.params))) list.push(warning);
};

const clock = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

// ---------------------------------------------------------------------------
// The teacher's day
// ---------------------------------------------------------------------------

/**
 * Whether Generera must refuse this breach: the pins in a week the breach holds are what the engine cannot place.
 * `taking` are the teacher's fixed lessons, ids the position in it.
 */
function dayBreachRefuses(breach: Extract<TeacherDayBreach, { kind: 'DAILY_CAP' }>, items: readonly FixedItem[], lessons: readonly TeachingLesson[]): boolean {
  const weeks = weeksOf(lessons);
  return weeks.some((week) => {
    const onDay = week.filter((lesson) => lesson.dayOfWeek === breach.dayOfWeek);
    const pins = onDay.filter((lesson) => items[Number(lesson.id)]!.pin);
    if (pins.length === 0) return false;
    const locked = onDay.filter((lesson) => !items[Number(lesson.id)]!.pin);
    const placed = pins.reduce((sum, lesson) => sum + (lesson.endMinutes - lesson.startMinutes), 0);
    return placed > Math.max(0, breach.cap - unionMinutes(locked));
  });
}

function daysBreachRefuses(max: number, items: readonly FixedItem[], lessons: readonly TeachingLesson[]): boolean {
  return weeksOf(lessons).some((week) => {
    const locked = new Set(week.filter((lesson) => !items[Number(lesson.id)]!.pin).map((lesson) => lesson.dayOfWeek));
    const pinned = new Set(week.filter((lesson) => items[Number(lesson.id)]!.pin).map((lesson) => lesson.dayOfWeek));
    const beyond = [...pinned].filter((day) => !locked.has(day)).length;
    return beyond > Math.max(0, max - locked.size);
  });
}

/**
 * Lärarens dag over the fixed week: for each teacher with a rule, the breaches the rows make, as one warning on every
 * row of a breach. The arithmetic is the hand edit's (teacherDayBreaches, `about` the rows), so the two say the same
 * thing about the same week.
 */
export function teacherDayWarningsOf(
  items: readonly FixedItem[],
  rules: ReadonlyMap<string, TeacherDayRule>,
  showsHr: boolean,
): { warnings: WarningsByRow; hrTold: string[] } {
  const warnings: WarningsByRow = new Map();
  const hrTold: string[] = [];
  for (const [teacherId, rule] of rules) {
    const mine = items.flatMap((item, position) =>
      item.teacherIds.includes(teacherId)
        ? [
            {
              id: String(position),
              dayOfWeek: item.dayOfWeek,
              startMinutes: item.startMinutes,
              endMinutes: item.endMinutes,
              recurrence: item.recurrence,
              startDate: item.startDate,
              endDate: item.endDate,
            } satisfies TeachingLesson,
          ]
        : [],
    );
    const about = new Set(mine.filter((lesson) => items[Number(lesson.id)]!.row !== null).map((lesson) => lesson.id));
    if (about.size === 0) continue;
    for (const breach of teacherDayBreaches(rule, mine, about)) {
      let warning: PlacementWarning;
      if (breach.kind === 'DAILY_CAP') {
        warning = {
          code: 'TEACHER_DAY_TOO_LONG',
          refuses: dayBreachRefuses(breach, items, mine),
          params: { day: breach.dayOfWeek, minutes: breach.minutes, cap: breach.cap },
        };
      } else if (breach.kind === 'WORK_DAYS') {
        hrTold.push(teacherId);
        warning = showsHr
          ? { code: 'TEACHER_WEEK_TOO_MANY_DAYS', refuses: daysBreachRefuses(breach.max, items, mine), params: { days: breach.days, max: breach.max } }
          : { code: 'TEACHER_WEEK_TOO_MANY_DAYS_HIDDEN', refuses: daysBreachRefuses(breach.max, items, mine) };
      } else {
        hrTold.push(teacherId);
        warning = showsHr
          ? {
              code: 'TEACHER_STRETCH_TOO_LONG',
              refuses: false,
              params: { day: breach.dayOfWeek, minutes: breach.minutes, max: breach.max, breakMinutes: breach.breakMinutes },
            }
          : { code: 'TEACHER_STRETCH_TOO_LONG_HIDDEN', refuses: false };
      }
      for (const id of breach.lessonIds) {
        const row = items[Number(id)]!.row;
        if (row !== null) add(warnings, row, warning);
      }
    }
  }
  return { warnings, hrTold };
}

// ---------------------------------------------------------------------------
// The class's lunch
// ---------------------------------------------------------------------------

/** The school's lunch: a break of `minutes` that starts on the slot grid inside [startMinutes, endMinutes). */
export interface LunchRule {
  startMinutes: number;
  endMinutes: number;
  minutes: number;
}

/** A meal the school placed by hand: the class eats then, in the weeks it holds, and the day needs no start found. */
export interface HandMeal {
  groupId: string;
  dayOfWeek: number;
  startDate: string | null;
  endDate: string | null;
}

/** Whether a break starting at `start` stands clear of every lesson: the engine's `_forbidden_lunch_starts`, in minutes. */
const startIsFree = (start: number, minutes: number, lessons: readonly { startMinutes: number; endMinutes: number }[]): boolean =>
  lessons.every((lesson) => !(start + minutes > lesson.startMinutes && start < lesson.endMinutes));

const FIRST_DAY = '0000-01-01';
const LAST_DAY = '9999-12-31';
const dayAfter = (day: string): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * Whether the meals together hold every day of [from, to], a null bound being the läsår's own (a meal's null bound is
 * open the same way, so only a meal with no bound holds an unbounded stretch).
 */
export function mealsCover(meals: readonly HandMeal[], from: string, to: string): boolean {
  const sorted = meals
    .map((meal) => ({ start: meal.startDate ?? FIRST_DAY, end: meal.endDate ?? LAST_DAY }))
    .sort((a, b) => a.start.localeCompare(b.start));
  // The first day not yet held: every meal must begin on or before it to leave no gap.
  let reach = from;
  for (const meal of sorted) {
    if (meal.start > reach) return false;
    if (meal.end >= to) return true;
    if (meal.end >= reach) reach = dayAfter(meal.end);
  }
  return false;
}

/**
 * The class's lunch over the fixed week: a weekday on which the class's own lessons, in some weeks, leave the break no
 * start inside the school's window. The engine's arithmetic exactly (LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK): a break of
 * L minutes starting at s clashes with a lesson [a, b) when s + L > a and s < b, and the starts are the slot grid from
 * the window's start to its end less L. A meal the school placed by hand for the class on that day, in all the weeks
 * the lessons run together, rescues the day (the engine skips a pinned day in every one of its lunch refusals).
 *
 * `classes` are the groups that eat (the home classes); a lesson reaches a class when it names it, as lead group or as
 * an extra group. Always refuses: see the file's first paragraphs.
 */
export function classLunchWarningsOf(
  items: readonly FixedItem[],
  lunch: LunchRule,
  classes: ReadonlySet<string>,
  meals: readonly HandMeal[],
  year: YearSpan,
): WarningsByRow {
  const warnings: WarningsByRow = new Map();
  const last = lunch.endMinutes - lunch.minutes;
  if (last < lunch.startMinutes) return warnings;
  for (const classId of classes) {
    const ofClass = items.filter((item) => item.groupIds.includes(classId));
    if (!ofClass.some((item) => item.row !== null)) continue;
    const days = [...new Set(ofClass.map((item) => item.dayOfWeek))].sort((a, b) => a - b);
    for (const day of days) {
      const onDay = ofClass.filter((item) => item.dayOfWeek === day);
      if (!onDay.some((item) => item.row !== null)) continue;
      // The meal is every week's: odd and even weeks' lessons are read as one, and only the dates cut the year.
      const sets = weeksOf(onDay.map((item) => ({ ...item, recurrence: 'ALL_WEEKS' as const })), year);
      for (const set of sets) {
        if (!set.some((item) => item.row !== null)) continue;
        let free = false;
        for (let start = lunch.startMinutes; start <= last; start += SLOT_MINUTES) {
          if (startIsFree(start, lunch.minutes, set)) {
            free = true;
            break;
          }
        }
        if (free) continue;
        // The days these lessons run together: after the latest start and before the earliest end, inside the läsår.
        const from = set.reduce((max, item) => (item.startDate !== null && item.startDate > max ? item.startDate : max), year.startDate);
        const to = set.reduce((min, item) => (item.endDate !== null && item.endDate < min ? item.endDate : min), year.endDate);
        const handPlaced = meals.filter((meal) => meal.groupId === classId && meal.dayOfWeek === day);
        if (mealsCover(handPlaced, from, to)) continue;
        for (const item of set) {
          if (item.row !== null) {
            add(warnings, item.row, {
              code: 'CLASS_HAS_NO_LUNCH',
              refuses: true,
              params: { day, windowStart: clock(lunch.startMinutes), windowEnd: clock(lunch.endMinutes), minutes: lunch.minutes },
            });
          }
        }
      }
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// A room of the right kind
// ---------------------------------------------------------------------------

/** What a room-less lesson needs: the type of the subject's rooms, by the subject. */
export interface RoomFacts {
  /** The type each room has; a room of no type is of none. */
  typeOfRoom: ReadonlyMap<string, string | null>;
  /** How many rooms each type has. */
  roomsOfType: ReadonlyMap<string, number>;
  /** The type each subject needs, when it needs one. */
  typeOfSubject: ReadonlyMap<string, string | null>;
  /** The name of each type, for the sentence. */
  nameOfType: ReadonlyMap<string, string>;
  /** The types with a room that takes several lessons at once (Placeringsregler, rule 3): not counted, since one lesson to a room is no longer the engine's count. */
  shareable?: ReadonlySet<string>;
}

/**
 * A pin with no room of its subject's type free at its time, among what is fixed. The rooms the fixed lessons hold
 * and the other pins' (each takes one of its own type) are counted over the weeks they run together; the pin is
 * warned when, at any minute of its lesson, they come to more than the rooms the type has. Always refuses.
 *
 * Only a subject that needs a type is asked: one that does not takes any room, and the engine has no kind to run out
 * of. A room's capacity, years and unavailable hours are not asked, which leaves the count too generous and so quiet.
 */
export function noRoomWarningsOf(items: readonly FixedItem[], facts: RoomFacts): WarningsByRow {
  const warnings: WarningsByRow = new Map();
  const typeOfItem = (item: FixedItem): string | null =>
    item.roomId === null ? (item.pin ? (facts.typeOfSubject.get(item.subjectId) ?? null) : null) : (facts.typeOfRoom.get(item.roomId) ?? null);
  const types = new Set(
    items
      .filter((item) => item.pin && item.roomId === null && item.row !== null)
      .map(typeOfItem)
      .filter((type): type is string => type !== null && !(facts.shareable?.has(type) ?? false)),
  );
  for (const type of types) {
    const holding = items.filter((item) => typeOfItem(item) === type);
    const rooms = facts.roomsOfType.get(type) ?? 0;
    for (const week of weeksOf(holding)) {
      for (const pin of week.filter((item) => item.pin && item.roomId === null && item.row !== null)) {
        const against = week.filter((item) => item.dayOfWeek === pin.dayOfWeek && item.startMinutes < pin.endMinutes && pin.startMinutes < item.endMinutes);
        // The most lessons at one moment inside the pin's own lesson: the busiest start among the pin and those that overlap it.
        const moments = [pin.startMinutes, ...against.map((item) => item.startMinutes).filter((start) => start > pin.startMinutes && start < pin.endMinutes)];
        const busiest = Math.max(...moments.map((at) => against.filter((item) => item.startMinutes <= at && at < item.endMinutes).length));
        if (busiest > rooms) {
          add(warnings, pin.row!, {
            code: 'NO_ROOM_FREE',
            refuses: true,
            params: { day: pin.dayOfWeek, start: clock(pin.startMinutes), end: clock(pin.endMinutes), roomType: facts.nameOfType.get(type) ?? '' },
          });
        }
      }
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------

export interface WarningInput {
  items: readonly FixedItem[];
  /** How many rows are to be warned about. */
  rows: number;
  teacherRules: ReadonlyMap<string, TeacherDayRule>;
  showsHr: boolean;
  lunch: { rule: LunchRule; classes: ReadonlySet<string>; meals: readonly HandMeal[]; year: YearSpan } | null;
  rooms: RoomFacts | null;
}

/** Every warning, per row, in a fixed order: the teacher's day, the class's lunch, the room. */
export function placementWarningsOf(input: WarningInput): { byRow: PlacementWarning[][]; hrTold: string[] } {
  const parts: WarningsByRow[] = [];
  const day = teacherDayWarningsOf(input.items, input.teacherRules, input.showsHr);
  parts.push(day.warnings);
  if (input.lunch) parts.push(classLunchWarningsOf(input.items, input.lunch.rule, input.lunch.classes, input.lunch.meals, input.lunch.year));
  if (input.rooms) parts.push(noRoomWarningsOf(input.items, input.rooms));
  const byRow = Array.from({ length: input.rows }, (_, row) => parts.flatMap((part) => part.get(row) ?? []));
  return { byRow, hrTold: [...new Set(day.hrTold)] };
}
