// Open questions asked of a timetable that has already been laid.
//
// The grid can already answer "where does THIS lesson fit" — findOpenSlots in
// lib/conflicts.ts — but only from inside the create-lesson dialog, with a
// class and a subject already chosen. Finslipning needs the questions asked the
// other way round, of the schedule itself with no lesson in hand: when are
// these bodies all free at once, who is free at this moment, and — the number
// nothing in the product computes — where the håltimmar are. A timetable with
// no clashes can still be a bad one to live in, and it is the idle holes that
// decide which.
//
// Every "busy" verdict below is delegated to validatePlacement by probing it
// with a placement that stands for the body being asked about. That is
// deliberate: this module must not grow a second opinion about what occupies a
// class, a pupil, a teacher or a room. Alternating weeks, teaching groups that
// share pupils, individually enrolled students and term-limited lessons all
// come along for free, and they stay in step when the rule changes on either
// side.
//
// What differs between the three questions is not the operator but the body
// the probe stands for. "When are 7A and 8B free at once" is asked of the
// classes, and any lesson touching either of them takes the slot away. "Where
// are 7A's håltimmar" cannot be asked that way: while Ma71 runs, sixteen of the
// class are taught and the other fourteen may have nothing at all, and a probe
// carrying 7A calls that hour busy for the whole class. So the gap report is
// asked of the pupils — one probe per set of pupils that is booked alike — and
// every hole it reports carries how many of them are sitting in it.

import {
  validatePlacement,
  type GroupConflictMap,
  type Placement,
  groupsOf,
} from "@/lib/conflicts";
import type {
  AvailabilityConstraint,
  LessonRecurrence,
  LunchSettings,
} from "@/lib/types";
import { frameWindow, type FrameTime } from "@/lib/frame-times";
import { timeToMinutes } from "@/lib/utils";
import type { GradeSpan } from "@/lib/grade-span";

/** Monday–Friday, and the span findOpenSlots searches, so answers agree. */
const DEFAULT_DAYS = [1, 2, 3, 4, 5];
const DEFAULT_DAY_START = 8 * 60;
const DEFAULT_DAY_END = 17 * 60;

/**
 * Holes shorter than this are the ordinary changeover between two lessons — a
 * rast, not a håltimme. Reporting them would bury the ones that matter under
 * every ten-minute break in the school.
 */
export const DEFAULT_MINIMUM_GAP_MINUTES = 15;

/**
 * A stretch of a weekday in which every body asked about is free.
 *
 * `weeks` is not decoration. weeksCanOverlap says a lesson on odd weeks and one
 * on even weeks may share a slot, so a slot taken only on odd weeks IS free on
 * even ones — and that window is a real answer, worth offering to somebody
 * looking for room to move a lesson. Presenting it as ordinary free time would
 * mislead, so the parity travels with the result: ALL_WEEKS means the window
 * exists in every week, ODD_WEEKS/EVEN_WEEKS that it exists every other week
 * and the caller must say so.
 */
export interface FreeWindow {
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
  weeks: LessonRecurrence;
}

/** One teaching-group membership row, as buildGroupConflictMap takes them. */
export interface GroupMembership {
  studentId: string;
  studentGroupId: string;
}

/**
 * The timetable facts every question here is answered from. All of it is
 * already in the caller's hands — this module fetches nothing.
 */
export interface ScheduleData {
  /**
   * The whole academic year's lessons, as the grid holds them.
   *
   * A placement may carry the pupils' own minutes on either side of it — the
   * ombyte before idrotten and the dusch after — which the caller puts there by
   * building it with `toPlacement(lesson, pupilBuffers)`. Those minutes occupy
   * the PUPILS, so they fill a hole in a class's day and leave a teacher's
   * untouched; see `occupation`. A caller that has not loaded the timplan
   * carries none of them, and every answer below is then the one this module
   * gave before they existed.
   */
  placements: Placement[];
  /** Weekly UNAVAILABLE rules occupy time exactly as a lesson does. */
  constraints: AvailabilityConstraint[];
  /**
   * Groups sharing pupils, from buildGroupConflictMap. A pupil in 7A and in
   * Ma71 is one body: a search over 7A that ignored Ma71's lessons would offer
   * slots those pupils are already sitting in.
   */
  groupConflicts?: GroupConflictMap;
  /** studentId → home class, so an elective booked per pupil occupies it. */
  studentGroupOf?: Map<string, string | null>;
  /**
   * groupId → the years it holds, so a GRADE_LEVEL rule can reach it.
   *
   * Omitted, year rules are skipped — which is what this module did for every
   * caller until now, silently: a rule saying åk 4 stops at 15:00 left the
   * search reporting 15:00-16:00 as free for a year-4 class. See
   * lib/grade-span.ts for why a group's year has to be derived rather than read.
   */
  gradeSpanOf?: Map<string, GradeSpan>;
  /**
   * The school's ramtider — the hours each stage may be taught in.
   *
   * Time outside a probed group's frame is occupied, in the same sense a
   * lesson occupies it: the search must not offer 16:00 to a class whose day
   * the school ended at 15:00. Omitted, frames are not applied, which is the
   * honest reading of a query still in flight; an empty array is a school with
   * no frames and means every hour is inside the day.
   */
  frameTimes?: FrameTime[];
  /**
   * Who sits in which teaching group — the rows buildGroupConflictMap takes.
   *
   * Together with studentGroupOf this is the roster, and supplying it is what
   * switches findIdleGaps from asking whether a class's name is busy to asking
   * how many of its pupils are. Supply it even when the school has no teaching
   * groups: an empty array says every pupil sits only in their class, which is
   * a complete roster, where leaving it out says the caller has none and the
   * report keeps to the whole-group reading.
   *
   * Half a roster is worse than none, which is why the switch is this field
   * and not studentGroupOf: pupils whose teaching groups were never mentioned
   * would read as free through every lesson those groups have.
   */
  memberships?: GroupMembership[];
  /**
   * Any date inside the week being asked about, YYYY-MM-DD.
   *
   * A search over a week has no date of its own, so a lesson that runs only in
   * the spring term is neither always busy nor always free — the question has
   * to say which week it means. Naming a date asks it of that week, and
   * weeksCanOverlap then drops a lesson whose own term does not reach it,
   * exactly as it would for a real lesson placed there. Leaving it out asks
   * about the academic year as a whole, where every dated lesson counts: the
   * conservative reading, which never offers a slot that is taken in some week,
   * but does report a spring course as occupying its slot in the autumn too.
   */
  onDate?: string | null;
}

/** The bodies a question is about. Every field is optional; all are unioned. */
interface Bodies {
  studentGroupIds?: string[];
  teacherIds?: string[];
  roomIds?: string[];
}

/**
 * What validatePlacement may expand a probe with.
 *
 * A probe standing for a whole group wants both maps: 7A is busy when Ma71 is,
 * because Ma71 is partly 7A. A probe standing for one pupil must have neither
 * — the maps answer "somebody in this group is busy", which is the question
 * that hides håltimmar — and needs neither, because such a probe carries that
 * one pupil's own memberships and nobody else's.
 */
interface KnownMemberships {
  studentGroupOf?: Map<string, string | null>;
  groupConflicts?: GroupConflictMap;
  /** See ScheduleData.gradeSpanOf — year rules cannot reach a group without it. */
  gradeSpanOf?: Map<string, GradeSpan>;
}

/**
 * The hours a frame closes for the probed bodies on one weekday.
 *
 * The COMPLEMENT of the window, because everything here is expressed as
 * occupied time: what a frame states positively has to be turned into the
 * intervals it forbids before the same merge that handles lessons can consume
 * it. A day closed outright is the whole day.
 *
 * The union across probes, not the intersection. Asking when 4B and 7A are
 * both free means an hour outside EITHER frame is not on offer — one of the
 * two classes may not be there.
 *
 * A probe naming no group, or one whose years are unknown, contributes
 * nothing: the same silence lib/frame-times.ts keeps for it, and the reason a
 * teacher-only question is unaffected by frames.
 */
function frameClosures(
  probes: Placement[],
  frames: FrameTime[],
  day: number,
  known: KnownMemberships,
): Interval[] {
  const closures: Interval[] = [];
  const seen = new Set<string>();

  // groupsOf, not probe.studentGroupId: buildProbes folds a search over several
  // classes into one probe that carries the rest in extraGroupIds, so reading
  // only the named one applies the first class's frame and none of the others'.
  for (const groupId of probes.flatMap(groupsOf)) {
    if (seen.has(groupId)) continue;
    seen.add(groupId);

    // No NO_GROUP check above it: the sentinel is this module's own and never
    // reaches gradeSpanOf, so a teacher-only probe falls out here for the same
    // reason a real group with unknown years does. One rule, not two.
    const span = known.gradeSpanOf?.get(groupId);
    if (!span) continue;

    const window = frameWindow(frames, span, day);
    if (window === null) {
      closures.push({ start: 0, end: DAY_MINUTES });
      continue;
    }
    if (window.startMinutes > 0) {
      closures.push({ start: 0, end: window.startMinutes });
    }
    if (window.endMinutes < DAY_MINUTES) {
      closures.push({ start: window.endMinutes, end: DAY_MINUTES });
    }
  }

  return closures;
}

/** Midnight to midnight, the outer bound every closure is measured against. */
const DAY_MINUTES = 24 * 60;

/**
 * A probe must name a student group, since Placement.studentGroupId is
 * required, but a question about a teacher or a room alone has none to name.
 * This id belongs to no school, so it matches no lesson, no conflict-map entry
 * and no constraint.
 */
const NO_GROUP = "__no_group__";

/** The two halves of an alternating week. */
const PARITIES = ["ODD_WEEKS", "EVEN_WEEKS"] as const;

/**
 * The three readings of one week. ALL_WEEKS is not "the parities agreed" — it
 * is their intersection, and it comes first so that a window holding in every
 * week is offered as one before either parity can claim it.
 */
const WEEK_LENSES = ["ALL_WEEKS", ...PARITIES] as const;

/** The empty shell every probe is cut from, seen through one week. */
function baseProbe(weeks: LessonRecurrence, onDate?: string | null): Placement {
  return {
    id: null,
    dayOfWeek: 1,
    startMinutes: 0,
    endMinutes: 0,
    teacherId: null,
    roomId: null,
    studentGroupId: NO_GROUP,
    recurrence: weeks,
    // A one-day range, so weeksCanOverlap reads the question as "in the week
    // this date falls in". Null on both ends is the whole year.
    startDate: onDate ?? null,
    endDate: onDate ?? null,
  };
}

/**
 * Stand-in placements for the bodies asked about, seen through one week
 * parity. The groups travel together on a single probe — one lesson touching
 * any of them makes the whole query busy, which is what "when are ALL of these
 * free" means — while teachers and rooms need one probe each, a Placement
 * carrying at most two teachers and one room.
 */
function buildProbes(
  bodies: Bodies,
  weeks: LessonRecurrence,
  onDate?: string | null,
): Placement[] {
  const base = baseProbe(weeks, onDate);

  const probes: Placement[] = [];
  const [firstGroup, ...otherGroups] = unique(bodies.studentGroupIds ?? []);
  if (firstGroup !== undefined) {
    probes.push({ ...base, studentGroupId: firstGroup, extraGroupIds: otherGroups });
  }
  for (const teacherId of unique(bodies.teacherIds ?? [])) {
    probes.push({ ...base, teacherId });
  }
  for (const roomId of unique(bodies.roomIds ?? [])) {
    probes.push({ ...base, roomId });
  }
  return probes;
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

function hasBodies(bodies: Bodies): boolean {
  return (
    (bodies.studentGroupIds?.length ?? 0) > 0 ||
    (bodies.teacherIds?.length ?? 0) > 0 ||
    (bodies.roomIds?.length ?? 0) > 0
  );
}

/**
 * Whether a probe stands for PUPILS — a class, several classes, or one named
 * pupil — rather than for a teacher or a room.
 *
 * Which is the question the pupil buffer turns on: the minutes of ombyte and
 * dusch occupy the children and nobody else. baseProbe fills studentGroupId
 * with the module's own sentinel, so a teacher or room probe names no group at
 * all, and a cohort probe names both a group and the one pupil it stands for.
 */
function standsForPupils(probe: Placement): boolean {
  return probe.studentGroupId !== NO_GROUP || (probe.studentIds?.length ?? 0) > 0;
}

/**
 * The stretch this one lesson occupies the probed bodies for — null when it
 * occupies none of them.
 *
 * The probe is laid over the lesson's own slot and validated against that
 * lesson alone, so the only thing the answer can depend on is whether the two
 * share a teacher, a room, a group, a pupil — or a week. Intervals are
 * half-open there, which also settles the degenerate rows for free: a lesson
 * ending when it starts overlaps nothing, its own probe included, and so
 * occupies nobody.
 *
 * WIDER THAN THE LESSON FOR PUPILS, and exactly the lesson for anybody else.
 * A class with 20 minutes of dusch after its idrott is not idle in them, so
 * they are not a hole — and the timetable editor would refuse a lesson dropped
 * there (lib/conflicts.ts, pupilsOverlap), which is the whole reason this
 * report must count them: a håltimme nothing can be moved into is not a
 * håltimme, it is a report sending a schedule-maker to try a drag the grid
 * then rejects. The teacher's own report keeps the teaching span, for the
 * reason validatePlacement gives at shareTheClock: the idrottslärare neither
 * changes nor showers with the class.
 *
 * The buffer reaches this function on the placement itself — the caller builds
 * its placements with toPlacement(lesson, buffers) — so a caller that has not
 * loaded the timplan passes none and every interval below is the exact one
 * this module has always used.
 *
 * A start pulled back by an ombyte can precede the day's first lesson, and that
 * is the honest reading: the pupils are at school, in the omklädningsrummet.
 * The day the report measures holes inside is bounded by these same intervals,
 * so the ombyte before the first lesson never becomes a hole of its own.
 */
function occupation(
  probes: Placement[],
  placement: Placement,
  known: KnownMemberships,
): Interval | null {
  let occupied = false;
  let pupils = false;

  for (const probe of probes) {
    if (
      validatePlacement(
        {
          ...probe,
          dayOfWeek: placement.dayOfWeek,
          startMinutes: placement.startMinutes,
          endMinutes: placement.endMinutes,
        },
        [placement],
        [],
        known.studentGroupOf,
        known.groupConflicts,
      ).length === 0
    ) {
      continue;
    }
    occupied = true;
    // The pupil reading is the widest one, so the first pupil probe that
    // matches settles the answer and the rest of the set is not asked. A mixed
    // set — "when are 7A and Karin both free" — therefore counts the buffer as
    // soon as the class is what the lesson occupies.
    if (standsForPupils(probe)) {
      pupils = true;
      break;
    }
  }

  if (!occupied) return null;
  return {
    start: placement.startMinutes - (pupils ? (placement.minutesBefore ?? 0) : 0),
    end: placement.endMinutes + (pupils ? (placement.minutesAfter ?? 0) : 0),
  };
}

/** Whether this one weekly rule closes time for any of the probed bodies. */
function closes(
  probes: Placement[],
  constraint: AvailabilityConstraint,
  day: number,
  startMinutes: number,
  endMinutes: number,
  known: KnownMemberships,
): boolean {
  return probes.some(
    (probe) =>
      validatePlacement(
        { ...probe, dayOfWeek: day, startMinutes, endMinutes },
        [],
        [constraint],
        known.studentGroupOf,
        known.groupConflicts,
        known.gradeSpanOf,
      ).length > 0,
  );
}

interface Interval {
  start: number;
  end: number;
}

interface DayBusy {
  /** Merged lesson intervals. These alone bound the school day. */
  lessons: Interval[];
  /** Lessons plus the weekly rules that close time, merged. */
  occupied: Interval[];
}

function pushInterval(byDay: Map<number, Interval[]>, day: number, interval: Interval): void {
  const existing = byDay.get(day);
  if (existing) existing.push(interval);
  else byDay.set(day, [interval]);
}

/**
 * Everything that occupies the probed bodies, per weekday.
 *
 * Rules are offered to validatePlacement once per searched weekday rather than
 * filtered here, so that which weekdays a rule reaches stays its ruling alone:
 * a rule aimed at a date, or at no weekday at all, matches none of them and
 * this module never has to say so twice.
 *
 * One pass over the lessons and one over the constraints per day: O(placements
 * × probes), with no index built over data a single search reads once anyway.
 */
function collectBusy(
  probes: Placement[],
  data: ScheduleData,
  days: number[],
  known: KnownMemberships,
): Map<number, DayBusy> {
  const lessonsByDay = new Map<number, Interval[]>();
  const closedByDay = new Map<number, Interval[]>();

  for (const placement of data.placements) {
    const busyFor = occupation(probes, placement, known);
    if (busyFor === null) continue;
    pushInterval(lessonsByDay, placement.dayOfWeek, busyFor);
  }

  for (const day of days) {
    for (const constraint of data.constraints) {
      const start = timeToMinutes(constraint.startTime);
      const end = timeToMinutes(constraint.endTime);
      if (!closes(probes, constraint, day, start, end, known)) continue;
      pushInterval(closedByDay, day, { start, end });
    }

    // Frames close time on their own, with no constraint to hang off. Putting
    // this inside the constraint loop would have made a school with frames and
    // no availability rules see none of them.
    if (data.frameTimes !== undefined) {
      for (const closure of frameClosures(probes, data.frameTimes, day, known)) {
        pushInterval(closedByDay, day, closure);
      }
    }
  }

  const busy = new Map<number, DayBusy>();
  for (const day of new Set([...lessonsByDay.keys(), ...closedByDay.keys()])) {
    const lessons = mergeIntervals(lessonsByDay.get(day) ?? []);
    busy.set(day, {
      lessons,
      occupied: mergeIntervals([...lessons, ...(closedByDay.get(day) ?? [])]),
    });
  }
  return busy;
}

/**
 * Sorted, non-overlapping cover of the input.
 *
 * Two things here are load-bearing. Lessons arrive in whatever order the API
 * sent them, and the sort is what lets the first entry stand for the day's
 * first minute; the Math.max is what lets the last entry stand for its last,
 * since a short lesson nested inside a long one starts later and ends sooner.
 * Whether two merely touching intervals become one is not: freeBetween finds
 * no hole between them either way.
 */
function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

/**
 * The holes in `busy` (merged and sorted) between `from` and `to`.
 *
 * The cursor only ever moves forward, which is what keeps a lesson that was
 * over before `from` from dragging it back and opening a window before the
 * day begins.
 */
function freeBetween(busy: Interval[], from: number, to: number): Interval[] {
  const free: Interval[] = [];
  let cursor = from;
  for (const interval of busy) {
    if (interval.start >= to) break;
    if (interval.start > cursor) free.push({ start: cursor, end: interval.start });
    cursor = Math.max(cursor, interval.end);
    if (cursor >= to) break;
  }
  if (cursor < to) free.push({ start: cursor, end: to });
  return free;
}

// ---------------------------------------------------------------------------
// 1. Forward search — when are all of these free at once?
// ---------------------------------------------------------------------------

/**
 * Every maximal window in which all the named groups, teachers and rooms are
 * free together, at least `minimumMinutes` long.
 *
 * Maximal, not stepped: the window runs from the minute the last of them comes
 * free to the minute the first is taken again, so a caller placing a 40-minute
 * lesson sees the true room it has rather than a list of 15-minute offsets.
 *
 * The week is read three times, not twice. Each parity on its own finds the
 * windows that exist every other week, and the every-week reading finds their
 * intersection — which is a different answer, not the cases where the two
 * parities happen to agree. A Monday with an odd-week lesson at ten and an
 * even-week one at twelve has no maximal parity window over 11:00–12:00, yet
 * 11:00–12:00 is free in every week of the year, and it is exactly the answer
 * somebody placing an ordinary weekly lesson came for.
 *
 * A window is therefore offered once, under the widest reading that holds: as
 * ALL_WEEKS when it exists in every week, and otherwise under the parity it was
 * found in, so an every-other-week opening is never mistaken for weekly room.
 *
 * A query naming no bodies returns nothing rather than the whole week: an empty
 * selection is a question about nobody, and answering it with every hour of
 * every day would read as a result.
 *
 * Cost is O(placements × probes) per reading plus a sort per day: measured at
 * 6ms for a class, a teacher and a room over a 1200-lesson week, so a page may
 * run it on every keystroke.
 */
export function findFreeWindows(
  options: ScheduleData &
    Bodies & {
      minimumMinutes: number;
      days?: number[];
      dayStartMinutes?: number;
      dayEndMinutes?: number;
    },
): FreeWindow[] {
  if (!hasBodies(options)) return [];

  const days = options.days ?? DEFAULT_DAYS;
  const dayStart = options.dayStartMinutes ?? DEFAULT_DAY_START;
  const dayEnd = options.dayEndMinutes ?? DEFAULT_DAY_END;

  const lenses = WEEK_LENSES.map((weeks) => ({
    weeks,
    busy: collectBusy(
      buildProbes(options, weeks, options.onDate),
      options,
      days,
      options,
    ),
  }));

  const windows: FreeWindow[] = [];
  const seen = new Set<string>();

  for (const day of days) {
    for (const lens of lenses) {
      for (const window of freeBetween(lens.busy.get(day)?.occupied ?? [], dayStart, dayEnd)) {
        if (window.end - window.start < options.minimumMinutes) continue;
        const key = `${day}|${window.start}|${window.end}`;
        // Already offered under a wider reading of the week.
        if (seen.has(key)) continue;
        seen.add(key);
        windows.push({
          dayOfWeek: day,
          startMinutes: window.start,
          endMinutes: window.end,
          weeks: lens.weeks,
        });
      }
    }
  }

  // Chronological: the caller is reading a week, not a ranking.
  return windows.sort(
    (a, b) =>
      a.dayOfWeek - b.dayOfWeek ||
      a.startMinutes - b.startMinutes ||
      a.endMinutes - b.endMinutes,
  );
}

// ---------------------------------------------------------------------------
// 2. Idle gaps — the holes inside somebody's day
// ---------------------------------------------------------------------------

/** The window the school set aside for lunch, and how long lunch itself is. */
export interface LunchWindow {
  startMinutes: number;
  endMinutes: number;
  /** Never longer than the window it sits in. */
  minutes: number;
}

/**
 * The school's persisted lunch rules as minutes, or null when there are none
 * to apply.
 *
 * Taking LunchSettings rather than a pair of numbers keeps `lunchEnabled` in
 * one place: a school that has switched lunch off gets no lunch credit, and no
 * call site has to remember that. A row whose duration is missing or nonsense
 * credits nothing — the window alone does not excuse a hole.
 */
export function lunchWindowOf(settings: LunchSettings | null | undefined): LunchWindow | null {
  if (!settings || !settings.lunchEnabled) return null;
  const startMinutes = timeToMinutes(settings.lunchStartTime);
  const endMinutes = timeToMinutes(settings.lunchEndTime);
  if (endMinutes <= startMinutes) return null;
  const span = endMinutes - startMinutes;
  return {
    startMinutes,
    endMinutes,
    minutes: Math.min(Math.max(Number(settings.lunchMinutes) || 0, 0), span),
  };
}

export type GapSubjectKind = "STUDENT_GROUP" | "TEACHER";

/** A hole between two of somebody's lessons. */
export interface IdleGap extends FreeWindow {
  /** Wall-clock length of the hole: endMinutes − startMinutes. */
  minutes: number;
  /** The part of it the school's own lunch rules pay for. */
  lunchMinutes: number;
  /** minutes − lunchMinutes: the part nobody has a reason for. */
  idleMinutes: number;
  /**
   * How many pupils sit through the whole of this hole with nothing at all.
   *
   * This is what makes the row actionable: "onsdag 10:00–11:00, 14 av 30
   * elever lediga" tells a schedule-maker what to move, where a bare
   * "håltimme" does not.
   *
   * A row is one continuous stretch for the pupils it counts, which is the
   * unit a håltimme is felt in — so two rows may overlap, the fourteen of 7A
   * outside Ma71 having their own hole and the sixteen inside it theirs. No
   * pupil is ever counted twice at the same minute: add up the rows covering
   * one moment and you have everyone idle in it.
   *
   * 0 when the report is not about a roster — a teacher, or a group the caller
   * gave no membership data for.
   */
  idleStudents: number;
}

export interface GapReport {
  /**
   * The group or teacher the report is about — the subject of the report, not
   * a school subject. `kind` says which table the id belongs to.
   */
  subjectId: string;
  kind: GapSubjectKind;
  gaps: IdleGap[];
  /**
   * Idle minutes in the worst single week, for the worst-off single person the
   * report covers. Odd- and even-week gaps are not added together, because no
   * week contains both, and neither are two halves of a class, because no pupil
   * sits in both — the number is what the heaviest week costs whoever has it
   * worst.
   */
  totalMinutes: number;
  /** The longest single idle gap. */
  worstMinutes: number;
  /**
   * How many pupils the report speaks for: the roster of the class. 0 for a
   * teacher, who is one person and not a roster, and 0 for a group the caller
   * supplied no membership data for — in which case the report falls back to
   * the whole-group reading and every idleStudents is 0 too.
   */
  studentCount: number;
}

/**
 * Håltimmar per group and per teacher, worst first.
 *
 * Rooms are not asked about, though the other two questions here take them: an
 * empty hour in a room is an occupancy figure, not a håltimme. Nobody is
 * sitting in it waiting for the next lesson.
 *
 * A class is not one body, and that is the whole difficulty. "Is 7A busy" is
 * the question the conflict engine answers — some pupil of 7A is taught, so no
 * whole-class lesson fits — and it is the wrong one here: while Ma71 runs, its
 * sixteen are taught and the other fourteen of 7A may have nothing at all. So
 * the report is computed per pupil, over the roster the caller supplies in
 * studentGroupOf and memberships, and pupils booked alike are probed once and
 * counted together. Every hole carries how many pupils are in it. A caller who
 * supplies no memberships has no roster to count and gets the whole-group
 * reading instead, which is the best answer available without one.
 *
 * An idle gap is not free time. A pupil free before their first lesson and
 * after their last is not idle — they are not at school, and counting those
 * would turn every short day into an alarm and bury the days that deserve one.
 * So each pupil's own first and last lesson bound their day, and only the holes
 * between them count. A day with one lesson has no inside; a day with none is
 * not a day.
 *
 * Two things fill a hole without being a lesson. A weekly UNAVAILABLE rule is
 * an occupation like any other — a teacher with a standing meeting is not idle
 * — so it is subtracted like a lesson, though it never bounds the day. And a
 * lunch break is not a håltimme: the school's lunch is credited against the
 * day's holes, so the ordinary lunch hole disappears from the report while the
 * ninety-minute hole that merely contains lunch is still reported, minus the
 * meal. One meal per day, however many holes the lunch window happens to hold.
 *
 * Parities are reported separately, for the same reason the free search does
 * it: a lesson that runs only on odd weeks leaves a real hole on even ones, and
 * merging the two would either invent a gap or hide one. Where the two weeks
 * agree — the ordinary case, since most timetables have no alternating lessons
 * at all — the gap is reported once as ALL_WEEKS.
 *
 * Subjects with nothing to report are left out; the caller may read a missing
 * id as a clean timetable.
 *
 * Cost is O(cohorts × placements) per parity, where a cohort is a set of
 * pupils booked alike — a handful per class, not thirty of them. The whole
 * school at once, 30 classes of 30 and 60 teachers over a 1200-lesson week,
 * measures 85ms. That is the one question here worth memoising per data change
 * rather than per render.
 */
export function findIdleGaps(
  options: ScheduleData & {
    studentGroupIds?: string[];
    teacherIds?: string[];
    /** The school's lunch settings, straight from useLunchSettings(). */
    lunch?: LunchSettings | null;
    /** Holes shorter than this are breaks, not håltimmar. */
    minimumMinutes?: number;
    /** Defaults to every weekday that carries a lesson. */
    days?: number[];
  },
): GapReport[] {
  const lunch = lunchWindowOf(options.lunch);
  const minimum = options.minimumMinutes ?? DEFAULT_MINIMUM_GAP_MINUTES;
  const days = options.days ?? daysWithLessons(options.placements);
  const groupsOfStudent = groupsByStudent(options);
  const bookings = personalBookings(options.placements);

  const subjects: Array<{ id: string; kind: GapSubjectKind }> = [
    ...unique(options.studentGroupIds ?? []).map((id) => ({
      id,
      kind: "STUDENT_GROUP" as const,
    })),
    ...unique(options.teacherIds ?? []).map((id) => ({ id, kind: "TEACHER" as const })),
  ];

  const reports: GapReport[] = [];
  for (const subject of subjects) {
    const cohorts =
      subject.kind === "STUDENT_GROUP"
        ? cohortsOf(subject.id, options, groupsOfStudent, bookings)
        : [wholeBody({ teacherIds: [subject.id] }, options)];

    // One row per (hole, week, lunch credit) the day holds, however many
    // cohorts arrive at it; each adds its own pupils to the count.
    const rows = new Map<string, IdleGap>();
    let worstWeek = 0;

    for (const cohort of cohorts) {
      const busy = PARITIES.map((weeks) =>
        collectBusy(cohort.probes(weeks), options, days, cohort.known),
      );
      const perParity = [0, 0];
      const own = new Map<string, IdleGap>();

      for (const day of days) {
        const credited = busy.map((byDay) =>
          creditLunch(holesInsideDay(byDay.get(day)), lunch),
        );
        for (const [index, holes] of credited.entries()) {
          // The week this one is not: there are two, so each is the other's.
          const other = credited[1 - index];
          for (const hole of holes) {
            if (hole.idleMinutes < minimum) continue;
            perParity[index] += hole.idleMinutes;

            // The same hole, credited the same way, in both weeks is one
            // ordinary hole. Anything less than an exact match is a different
            // hole, since a gap is defined by the two lessons that bound it.
            const shared = other.some(
              (candidate) =>
                candidate.start === hole.start &&
                candidate.end === hole.end &&
                candidate.lunchMinutes === hole.lunchMinutes,
            );
            const weeks = shared ? "ALL_WEEKS" : PARITIES[index];
            // Keyed, not pushed: a hole the two weeks agree on is found twice
            // and is one hole, so the second finding writes what the first
            // already wrote rather than counting the same pupils again.
            const key = `${day}|${hole.start}|${hole.end}|${weeks}|${hole.lunchMinutes}`;
            own.set(key, {
              dayOfWeek: day,
              startMinutes: hole.start,
              endMinutes: hole.end,
              weeks,
              minutes: hole.minutes,
              lunchMinutes: hole.lunchMinutes,
              idleMinutes: hole.idleMinutes,
              idleStudents: cohort.size,
            });
          }
        }
      }

      // No pupil sits in both weeks and no pupil sits in two cohorts, so the
      // worst week is a maximum over both, never a sum.
      worstWeek = Math.max(worstWeek, ...perParity);
      for (const [key, row] of own) {
        const existing = rows.get(key);
        if (existing) existing.idleStudents += cohort.size;
        else rows.set(key, row);
      }
    }

    const gaps = [...rows.values()];
    if (gaps.length === 0) continue;
    gaps.sort(
      (a, b) =>
        a.dayOfWeek - b.dayOfWeek ||
        a.startMinutes - b.startMinutes ||
        a.endMinutes - b.endMinutes,
    );
    reports.push({
      subjectId: subject.id,
      kind: subject.kind,
      gaps,
      totalMinutes: worstWeek,
      worstMinutes: Math.max(...gaps.map((gap) => gap.idleMinutes)),
      studentCount: cohorts.reduce((sum, cohort) => sum + cohort.size, 0),
    });
  }

  // Worst first: the report exists to be acted on from the top.
  return reports.sort(
    (a, b) =>
      b.totalMinutes - a.totalMinutes ||
      b.worstMinutes - a.worstMinutes ||
      a.subjectId.localeCompare(b.subjectId),
  );
}

/**
 * A set of people the schedule cannot tell apart, and the probe that stands
 * for any one of them.
 */
interface Cohort {
  /** How many pupils it speaks for; 0 for a body that is not a roster. */
  size: number;
  /** The stand-in, seen through one week. */
  probes: (weeks: LessonRecurrence) => Placement[];
  known: KnownMemberships;
}

/** A group or a teacher probed as one body — the reading with no roster. */
function wholeBody(bodies: Bodies, data: ScheduleData): Cohort {
  return {
    size: 0,
    probes: (weeks) => buildProbes(bodies, weeks, data.onDate),
    known: data,
  };
}

/**
 * The pupils of one group, split into the sets that are booked alike.
 *
 * Two pupils sitting in the same groups, and named individually by the same
 * lessons, are literally the same argument to validatePlacement — so they are
 * probed once and counted together, which is what keeps a whole school
 * affordable. The lessons are read here only to tell pupils apart; whether
 * either of them is busy is still decided by the engine.
 *
 * The probe carries the pupil's own groups and gets no conflict maps, which is
 * the whole point: with the maps, a lesson for any group sharing a pupil with
 * 7A would busy every pupil of 7A, and the fourteen sitting idle while Ma71
 * runs would vanish again.
 */
function cohortsOf(
  groupId: string,
  data: ScheduleData,
  groupsOfStudent: Map<string, Set<string>>,
  bookings: Map<string, string[]>,
): Cohort[] {
  // No roster at all: the best answer available is the old one, asked of the
  // group's name. Only the memberships say so — a caller who knows the home
  // classes but not the teaching groups knows half a roster, and half a roster
  // would report a class as idle through every lesson it splits up for.
  if (!data.memberships) return [wholeBody({ studentGroupIds: [groupId] }, data)];

  const bySignature = new Map<string, { size: number; groupIds: string[]; studentId: string }>();

  for (const [studentId, groups] of groupsOfStudent) {
    if (!groups.has(groupId)) continue;
    const groupIds = [...groups].sort();
    const booked = [...(bookings.get(studentId) ?? [])].sort();
    const signature = `${groupIds.join(",")}|${booked.join(",")}`;
    const existing = bySignature.get(signature);
    if (existing) existing.size += 1;
    else bySignature.set(signature, { size: 1, groupIds, studentId });
  }

  // A roster the school keeps, but nobody in this group: an empty class has no
  // pupils to count, so it is read as a body again rather than as nothing.
  if (bySignature.size === 0) return [wholeBody({ studentGroupIds: [groupId] }, data)];

  return [...bySignature.values()].map((cohort) => ({
    size: cohort.size,
    probes: (weeks) => [
      {
        ...baseProbe(weeks, data.onDate),
        studentGroupId: cohort.groupIds[0],
        extraGroupIds: cohort.groupIds.slice(1),
        studentIds: [cohort.studentId],
      },
    ],
    known: {},
  }));
}

/**
 * studentId → every group they sit in: their home class and every teaching
 * group they belong to. The relation buildGroupConflictMap derives its own
 * from, kept here as the roster it also is.
 */
function groupsByStudent(data: ScheduleData): Map<string, Set<string>> {
  const byStudent = new Map<string, Set<string>>();
  const add = (studentId: string, groupId: string) => {
    const existing = byStudent.get(studentId);
    if (existing) existing.add(groupId);
    else byStudent.set(studentId, new Set([groupId]));
  };
  // A pupil with no class yet still sits in the teaching groups they were put
  // in, and their day is still their own. The sentinel stands in for the class
  // they do not have, so it matches no lesson and keeps them apart from a pupil
  // whose class is known.
  for (const [studentId, homeId] of data.studentGroupOf ?? []) {
    add(studentId, homeId || NO_GROUP);
  }
  for (const row of data.memberships ?? []) add(row.studentId, row.studentGroupId);
  return byStudent;
}

/**
 * studentId → the lessons that name them personally. Two pupils of the same
 * groups still differ if one is enrolled in an elective, so this is the other
 * half of what makes two pupils interchangeable.
 */
function personalBookings(placements: Placement[]): Map<string, string[]> {
  const byStudent = new Map<string, string[]>();
  placements.forEach((placement, index) => {
    for (const studentId of placement.studentIds ?? []) {
      const existing = byStudent.get(studentId);
      // The index, not the id: it is unique per lesson without depending on
      // one having been saved.
      if (existing) existing.push(String(index));
      else byStudent.set(studentId, [String(index)]);
    }
  });
  return byStudent;
}

/** Only a day with lessons on it can hold a hole between two of them. */
function daysWithLessons(placements: Placement[]): number[] {
  return [...new Set(placements.map((placement) => placement.dayOfWeek))];
}

/** The holes between the first and last lesson of one day. */
function holesInsideDay(day: DayBusy | undefined): Interval[] {
  if (!day || day.lessons.length === 0) return [];
  const first = day.lessons[0].start;
  const last = day.lessons[day.lessons.length - 1].end;
  return freeBetween(day.occupied, first, last);
}

interface CreditedHole extends Interval {
  minutes: number;
  lunchMinutes: number;
  idleMinutes: number;
}

/**
 * The day's holes with the school's lunch subtracted — once.
 *
 * One meal is eaten per day, so the credit is handed out in clock order, each
 * hole taking as much of what is left of it as the hole overlaps the lunch
 * window. Crediting every hole its own full lunch, which is the obvious way to
 * write this, pays for a meal nobody eats: a day whose lunch window holds two
 * holes then reads as clean while the second one is real idle time.
 */
function creditLunch(holes: Interval[], lunch: LunchWindow | null): CreditedHole[] {
  let remaining = lunch ? lunch.minutes : 0;
  return holes.map((hole) => {
    const minutes = hole.end - hole.start;
    const overlap = lunch
      ? Math.min(hole.end, lunch.endMinutes) - Math.max(hole.start, lunch.startMinutes)
      : 0;
    const lunchMinutes = Math.min(Math.max(overlap, 0), remaining);
    remaining -= lunchMinutes;
    return { ...hole, minutes, lunchMinutes, idleMinutes: minutes - lunchMinutes };
  });
}

// ---------------------------------------------------------------------------
// 3. Reverse lookup — who is free at this moment?
// ---------------------------------------------------------------------------

/**
 * Which of the given groups, teachers and rooms are free across one interval.
 *
 * The mirror of the forward search, and the question an administrator asks
 * while staring at a hole in the grid: this slot is empty, who could fill it?
 * Candidates come from the caller — the page holds the roster — and each is
 * answered independently, so the result is three lists in the order they were
 * asked, not a combination.
 *
 * `weeks` chooses which weeks the question is about. The default, ALL_WEEKS, is
 * the strict reading: free in every week, which is what somebody placing an
 * ordinary weekly lesson needs. Asking about ODD_WEEKS also returns those free
 * only because the slot's occupant runs on even weeks.
 *
 * Cost is O(candidates × placements): 7ms for 130 candidates over a
 * 1200-lesson week.
 */
export function whoIsFree(
  options: ScheduleData &
    Bodies & {
      dayOfWeek: number;
      startMinutes: number;
      endMinutes: number;
      weeks?: LessonRecurrence;
    },
): { studentGroupIds: string[]; teacherIds: string[]; roomIds: string[] } {
  const weeks = options.weeks ?? "ALL_WEEKS";
  const free = (bodies: Bodies): boolean =>
    !buildProbes(bodies, weeks, options.onDate).some(
      (probe) =>
        validatePlacement(
          {
            ...probe,
            dayOfWeek: options.dayOfWeek,
            startMinutes: options.startMinutes,
            endMinutes: options.endMinutes,
          },
          options.placements,
          options.constraints,
          options.studentGroupOf,
          options.groupConflicts,
          // The reverse lookup has to read year rules too. Without this it
          // answers "åk 4 is free" for a slot a ramtid has closed — the same
          // silence the forward search had.
          options.gradeSpanOf,
        ).length > 0,
    );

  return {
    studentGroupIds: unique(options.studentGroupIds ?? []).filter((id) =>
      free({ studentGroupIds: [id] }),
    ),
    teacherIds: unique(options.teacherIds ?? []).filter((id) => free({ teacherIds: [id] })),
    roomIds: unique(options.roomIds ?? []).filter((id) => free({ roomIds: [id] })),
  };
}
