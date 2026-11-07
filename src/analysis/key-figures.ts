import type { TeacherAssignment, TeacherLoad, TeacherLoadReport } from '../staffing/teacher-load';
import type { Audiences } from './audience';
import type { SchoolKeyFigures, TeacherKeyFigures } from './analysis.types';

/*
 * Nyckeltal per lärare och skola.
 *
 * NO DEFINITION OF TIME OR LOAD OF ITS OWN. Every minute here is a figure of
 * the belastningsrapport (src/staffing/teacher-load.ts), read from the
 * report the caller built from the rows: the teacher's undervisning is the
 * report's assignedMinutesPerWeek, the uppdrag its dutyMinutesPerWeek, the
 * target, saldo and status its own, and the grundschema's teaching is the
 * SAME report built over the master lessons (scheduled-load.ts). What this
 * module adds is only what the report cannot know without the pupils: how many
 * pupils a teacher teaches, and per school the pupils beside the teachers.
 *
 *   undervisning     what the rows charge the teacher, a standardvecka, as the
 *                    report states it (assigned, charged: the row's percentage
 *                    per role and, under the Faktor model, the subject's factor);
 *   elever           the distinct pupils on the rows the teacher carries
 *                    (audience.ts: the roster a row has, less the pupils a
 *                    replacing group takes off it);
 *   behörighet       an assignment is covered unless the report lists it as
 *                    unqualified (unqualifiedAssignments, which is only
 *                    judged when the school has recorded behörigheter); the
 *                    share is of CLOCK minutes, timeMinutesPerWeek, which is
 *                    the time SCB's ämnesomfattning asks about;
 *   lärartäthet      the school's charged teaching over its riktmärke is the
 *                    teaching in heltidstjänster; per 100 pupils that is the
 *                    school's lärartäthet. It is stated from teaching alone, so
 *                    it needs no tjänstgöringsgrad and every reader may have
 *                    it. The same by tjänstgöringsgrad (employmentFte) is HR
 *                    data and only a reader with HR-läs is given it.
 *
 * PURE. The caller reads the rows and applies who may see what.
 */

export interface KeyFigureInput {
  planned: TeacherLoadReport;
  /** The same report over the grundschema's lessons; null when none is laid. */
  scheduled: TeacherLoadReport | null;
  audiences: Audiences;
  /** The policy's riktmärke, minutes a week for a full-time teacher; null without one. */
  fullTimeMinutesPerWeek: number | null;
  /** May tjänstgöringsgrad be stated? (readsHr) */
  readsHr: boolean;
}

export interface KeyFigureResult {
  school: SchoolKeyFigures;
  teachers: TeacherKeyFigures[];
}

const round = (value: number, places: number): number => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};

/** The assignment's key in the report's unqualified list. */
export const assignmentKey = (requirementId: string, userId: string, role: string): string =>
  `${requirementId}|${userId}|${role}`;

/** The assignments the report judges not covered by a behörighet. */
export function unqualifiedKeys(report: TeacherLoadReport): Set<string> {
  return new Set(report.unqualifiedAssignments.map((row) => assignmentKey(row.requirementId, row.userId, row.role)));
}

/** Pupils on the rows of a set of assignments, distinct. */
export function pupilsOfAssignments(assignments: readonly TeacherAssignment[], audiences: Audiences): Set<string> {
  const pupils = new Set<string>();
  for (const assignment of assignments) {
    for (const id of audiences.audienceOf(assignment.studentGroupId, assignment.subjectId)) pupils.add(id);
  }
  return pupils;
}

function teacherFigures(
  teacher: TeacherLoad,
  scheduled: TeacherLoad | undefined,
  hasScheduled: boolean,
  unqualified: ReadonlySet<string>,
  recorded: boolean,
  audiences: Audiences,
  readsHr: boolean,
): TeacherKeyFigures {
  let clock = 0;
  let covered = 0;
  for (const assignment of teacher.assignments) {
    clock += assignment.timeMinutesPerWeek;
    if (!unqualified.has(assignmentKey(assignment.requirementId, teacher.userId, assignment.role))) {
      covered += assignment.timeMinutesPerWeek;
    }
  }
  return {
    userId: teacher.userId,
    teachingMinutesPerWeek: teacher.assignedMinutesPerWeek,
    dutyMinutesPerWeek: teacher.dutyMinutesPerWeek,
    countedMinutesPerWeek: teacher.countedMinutesPerWeek,
    targetMinutesPerWeek: teacher.targetMinutesPerWeek,
    percentOfTarget: teacher.percentOfTarget,
    status: teacher.status,
    scheduledMinutesPerWeek: hasScheduled ? (scheduled?.assignedMinutesPerWeek ?? 0) : null,
    teachingHoursPerYear: teacher.annual.assignedHoursPerYear,
    employmentPercent: readsHr && teacher.employment ? teacher.employment.employmentPercent : null,
    groups: new Set(teacher.assignments.map((assignment) => assignment.studentGroupId)).size,
    pupils: pupilsOfAssignments(teacher.assignments, audiences).size,
    qualifiedShare: recorded && clock > 0 ? round(covered / clock, 4) : null,
  };
}

export function buildKeyFigures(input: KeyFigureInput): KeyFigureResult {
  const { planned, scheduled, audiences, fullTimeMinutesPerWeek, readsHr } = input;
  const unqualified = unqualifiedKeys(planned);
  const recorded = planned.qualificationsRecorded;
  const scheduledById = new Map((scheduled?.teachers ?? []).map((teacher) => [teacher.userId, teacher]));
  // A grundschema with no lesson in it says nothing; every teacher at 0 would read as "nothing laid".
  const hasScheduled = scheduled !== null && scheduled.totals.lessonMinutesPerWeek > 0;

  const teachers = planned.teachers.map((teacher) =>
    teacherFigures(teacher, scheduledById.get(teacher.userId), hasScheduled, unqualified, recorded, audiences, readsHr),
  );

  const teaching = planned.teachers.filter((teacher) => teacher.assignments.length > 0);
  let qualifiedMinutes = 0;
  let unqualifiedMinutes = 0;
  for (const teacher of teaching) {
    for (const assignment of teacher.assignments) {
      if (unqualified.has(assignmentKey(assignment.requirementId, teacher.userId, assignment.role))) {
        unqualifiedMinutes += assignment.timeMinutesPerWeek;
      } else {
        qualifiedMinutes += assignment.timeMinutesPerWeek;
      }
    }
  }
  const judged = qualifiedMinutes + unqualifiedMinutes;
  const pupils = audiences.schoolPupils.length;
  const teachingMinutes = teaching.reduce((sum, teacher) => sum + teacher.assignedMinutesPerWeek, 0);
  const teachingHours = teaching.reduce((sum, teacher) => sum + teacher.annual.assignedHoursPerYear, 0);
  const fte = fullTimeMinutesPerWeek && fullTimeMinutesPerWeek > 0 ? teachingMinutes / fullTimeMinutesPerWeek : null;
  const per100 = (value: number | null): number | null => (value === null || pupils === 0 ? null : round((value / pupils) * 100, 2));

  const school: SchoolKeyFigures = {
    pupils,
    teachers: teaching.length,
    teachingMinutesPerWeek: teachingMinutes,
    teachingHoursPerYear: round(teachingHours, 1),
    fullTimeTeachingMinutesPerWeek: fullTimeMinutesPerWeek,
    teachingFte: fte === null ? null : round(fte, 2),
    teachingFtePer100Pupils: per100(fte),
    teachersPer100Pupils: per100(teaching.length),
    pupilsPerTeacher: teaching.length === 0 ? null : round(pupils / teaching.length, 1),
    qualificationsRecorded: recorded,
    qualifiedMinutesPerWeek: recorded ? qualifiedMinutes : 0,
    unqualifiedMinutesPerWeek: recorded ? unqualifiedMinutes : 0,
    qualifiedShare: recorded && judged > 0 ? round(qualifiedMinutes / judged, 4) : null,
    unstaffedMinutesPerWeek: planned.unstaffedRequirements.reduce((sum, row) => sum + row.minutesPerWeek, 0),
  };
  if (readsHr) {
    const employed = teaching.reduce((sum, teacher) => sum + (teacher.employment ? teacher.employment.employmentPercent / 100 : 0), 0);
    school.employmentFte = round(employed, 2);
    school.employmentFtePer100Pupils = per100(employed);
  }
  return { school, teachers };
}
