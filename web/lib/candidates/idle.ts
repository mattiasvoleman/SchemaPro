import type { GapReport, IdleGap } from "@/lib/gaps";
import type { LessonRecurrence } from "@/lib/types";

/*
 * Lärarnas and elevernas håltimmar, as one figure per grundschema, so two
 * candidates can be set side by side (design §5).
 *
 * findIdleGaps (lib/gaps.ts) is the product's one definition of a håltimme
 * and stays it: these functions only add up its reports. They import its
 * TYPES and nothing else, so a page can rank and compare without loading the
 * conflict engine; computing the reports is idle-run.ts's, which is loaded
 * lazily.
 *
 * WHY A "STANDARD WEEK". A report keeps odd and even weeks apart, because no
 * week holds both — which is right for "what is the worst week", and wrong
 * for adding a school up: an ODD_WEEKS hole is felt every other week. So each
 * hole counts at the share of weeks it exists in — every week 1, odd or even
 * ½ — and the total is the average week's.
 */

/** Fixed across every candidate, so the numbers compare: a hole under 15 minutes is a rast. */
export const IDLE_MINIMUM_MINUTES = 15;

/** The share of the year's weeks a hole of this parity exists in. */
export function weekShare(weeks: LessonRecurrence): number {
  return weeks === "ALL_WEEKS" ? 1 : 0.5;
}

/** A teacher's idle minutes in the average week. */
export function standardWeekMinutes(gaps: readonly IdleGap[]): number {
  return gaps.reduce((sum, gap) => sum + gap.idleMinutes * weekShare(gap.weeks), 0);
}

/**
 * A class's idle PUPIL-minutes in the average week: each hole times the
 * pupils sitting in it. A hole only fourteen of thirty have counts fourteen
 * times, which is what lets a candidate that empties Ma71's hour for the rest
 * of 7A be told from one that does not.
 */
export function standardWeekPupilMinutes(gaps: readonly IdleGap[]): number {
  return gaps.reduce((sum, gap) => sum + gap.idleMinutes * gap.idleStudents * weekShare(gap.weeks), 0);
}

export interface IdleSummary {
  teachers: {
    /** Σ over teachers of their average-week idle minutes. */
    minutes: number;
    /** Teachers with at least one håltimme. */
    count: number;
    /** The worst-off teacher's worst week (GapReport.totalMinutes). */
    worst: number;
  };
  pupils: {
    /** Idle minutes per pupil in the average week: pupil-minutes over every pupil of the classes. */
    minutesPerPupil: number;
    /** Classes with at least one håltimme. */
    classes: number;
    /** The worst class's worst week for its worst-off pupil (GapReport.totalMinutes). */
    worst: number;
  };
  /** teacherId → average-week idle minutes; a teacher with none is absent. */
  perTeacher: Map<string, number>;
}

/**
 * One grundschema's håltimmar, from findIdleGaps' reports over the year's
 * classes and teachers.
 *
 * `pupils` is the number of pupils in the classes asked about, reported or
 * not: a class with no håltimme still has its pupils, and dividing by the
 * reported classes only would make a candidate that clears one class look
 * worse per pupil than one that does not.
 */
export function summarizeIdle(reports: readonly GapReport[], pupils: number): IdleSummary {
  const perTeacher = new Map<string, number>();
  let teacherWorst = 0;
  let pupilMinutes = 0;
  let classes = 0;
  let classWorst = 0;
  for (const report of reports) {
    if (report.kind === "TEACHER") {
      perTeacher.set(report.subjectId, standardWeekMinutes(report.gaps));
      teacherWorst = Math.max(teacherWorst, report.totalMinutes);
    } else {
      pupilMinutes += standardWeekPupilMinutes(report.gaps);
      classes += 1;
      classWorst = Math.max(classWorst, report.totalMinutes);
    }
  }
  return {
    teachers: {
      minutes: [...perTeacher.values()].reduce((sum, minutes) => sum + minutes, 0),
      count: perTeacher.size,
      worst: teacherWorst,
    },
    pupils: {
      minutesPerPupil: pupils > 0 ? pupilMinutes / pupils : 0,
      classes,
      worst: classWorst,
    },
    perTeacher,
  };
}

/** The current grundschema's håltimmar and each candidate's that has been measured, by candidate id. */
export interface IdleComparison {
  current: IdleSummary;
  byCandidate: ReadonlyMap<string, IdleSummary>;
}

export interface IdleDelta {
  teacherMinutes: number;
  teacherCount: number;
  teacherWorst: number;
  minutesPerPupil: number;
  classes: number;
  pupilWorst: number;
}

/** A candidate against the current grundschema: positive is more håltimmar. */
export function idleDelta(candidate: IdleSummary, current: IdleSummary): IdleDelta {
  return {
    teacherMinutes: candidate.teachers.minutes - current.teachers.minutes,
    teacherCount: candidate.teachers.count - current.teachers.count,
    teacherWorst: candidate.teachers.worst - current.teachers.worst,
    minutesPerPupil: candidate.pupils.minutesPerPupil - current.pupils.minutesPerPupil,
    classes: candidate.pupils.classes - current.pupils.classes,
    pupilWorst: candidate.pupils.worst - current.pupils.worst,
  };
}

export interface WorseTeacher {
  teacherId: string;
  before: number;
  after: number;
}

/**
 * "Blir sämre för": the teachers whose idle minutes grow most, worst first.
 *
 * A school total can fall while one teacher's week gets much worse, and that
 * teacher is the one who will come asking — so the comparison names them.
 * Ties go by id, so the list does not reshuffle between renders.
 */
export function worseFor(
  current: ReadonlyMap<string, number>,
  candidate: ReadonlyMap<string, number>,
  limit = 5,
): WorseTeacher[] {
  return [...candidate]
    .map(([teacherId, after]) => ({ teacherId, before: current.get(teacherId) ?? 0, after }))
    .filter((teacher) => teacher.after > teacher.before)
    .sort((a, b) => b.after - b.before - (a.after - a.before) || a.teacherId.localeCompare(b.teacherId))
    .slice(0, limit);
}
