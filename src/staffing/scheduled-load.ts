import { lessonMinutes } from '../common/timplan-scheduled';
import type { GradeSpan, LoadRequirement } from './teacher-load';

/*
 * Schemalagt per lärare: the grundschema as a teacher's load.
 *
 * The planned horizon charges a teacher the timplansposter they are named on.
 * The SCHEDULED horizon charges them the master lessons they teach, each at
 * its own length, its recurrence and window honoured, parked lessons out —
 * P3's layer-2 formula (src/common/timplan-scheduled.ts: Σ lessonMinutes ×
 * standardWeekWeight) applied to teachers instead of groups. It is done by
 * turning every master lesson into ONE requirement-shaped row and handing the
 * rows to buildTeacherLoadReport unchanged, so the two horizons are one
 * arithmetic: an untouched generated schedule reads exactly as planned
 * (Skola24's "Lektionstid %" at 100).
 *
 * WHICH SHARE OF A LESSON A TEACHER CARRIES (slotPercentOf) is the planned
 * row's percentage, found by the lesson's groups and subject — the same answer
 * the scheduled horizon and the delivered one give, so the three columns of
 * the reconciliation are charged alike:
 *
 *   1. Σ over the year's requirements in the lesson's subject for ANY of its
 *      groups (owner and extra groups) that name this person, each at the
 *      percentage of the role they hold there. A samläst lesson for 7A+7B
 *      whose two rows each charge their teacher 50 % charges 100 % of one
 *      lesson — the 50 + 50 the two rows planned — and two rows at 100 %
 *      charge 200 %, as planned charged both. Skola24's "Justera längd för
 *      lärare (%)" is per row; the lesson is where the rows meet.
 *   2. No row names them (a teacher swapped on the board, a lesson made by
 *      hand): the owner group's row's percentage for the slot they are in.
 *   3. No row at all: 100.
 *   SUBSTITUTE is always 100: the vikarie stood in front of the class, and
 *   the row's percentage was the planned teacher's arrangement.
 *
 * PURE. The caller reads the rows.
 */

/** The fields of a requirement slotPercentOf reads. */
export type SlotRequirement = Pick<
  LoadRequirement,
  'studentGroupId' | 'subjectId' | 'teacherId' | 'coTeacherId' | 'teacherLoadPercent' | 'coTeacherLoadPercent'
>;

/** A teacher's place on a lesson: the master's lead, its co-teacher, or a vikarie. */
export type LessonSlot = 'LEAD' | 'ASSISTANT' | 'SUBSTITUTE';

/**
 * The percentage of one lesson a person is charged in a slot. `groupIds` is
 * the owner group first, then the extra groups. See the header.
 */
export function slotPercentOf(
  groupIds: readonly string[],
  subjectId: string,
  slot: LessonSlot,
  personId: string | null,
  requirements: readonly SlotRequirement[],
): number {
  if (slot === 'SUBSTITUTE') return 100;
  const groups = new Set(groupIds);
  const rows = requirements.filter((row) => row.subjectId === subjectId && groups.has(row.studentGroupId));
  if (personId !== null) {
    let named = false;
    let sum = 0;
    for (const row of rows) {
      if (row.teacherId === personId) {
        named = true;
        sum += row.teacherLoadPercent;
      } else if (row.coTeacherId === personId) {
        named = true;
        sum += row.coTeacherLoadPercent;
      }
    }
    if (named) return sum;
  }
  const owner = rows.find((row) => row.studentGroupId === groupIds[0]);
  if (owner) return slot === 'LEAD' ? owner.teacherLoadPercent : owner.coTeacherLoadPercent;
  return 100;
}

/** A master lesson as the scheduled horizon reads it. */
export interface ScheduledMaster {
  id: string;
  recurrence: 'ALL_WEEKS' | 'ODD_WEEKS' | 'EVEN_WEEKS' | null;
  /** Inclusive yyyy-mm-dd, or null for the year's own bound. */
  startDate: string | null;
  endDate: string | null;
  subjectId: string;
  subjectName: string;
  studentGroupId: string;
  groupName: string;
  extraGroupIds: readonly string[];
  teacherId: string | null;
  coTeacherId: string | null;
  /** ISO weekday, 1 = Monday — for the walk publish makes (masterWalk). */
  dayOfWeek: number;
  /** 'HH:MM' — the wall clock, as P3 reads it. */
  startTime: string;
  endTime: string;
  isParked: boolean;
}

/**
 * Every non-parked master lesson as one requirement-shaped row: one lesson a
 * week of its own length, its recurrence and window, the span of every group
 * it is for, each slot at slotPercentOf, and the subject's load weight
 * (present only when `weightOf` is given — under FACTOR — as readLoadInput
 * sets it). Ids are 'm:' + the lesson's id, so no row is mistaken for a
 * timplanspost.
 */
export function toScheduledRequirements(
  masters: readonly ScheduledMaster[],
  requirements: readonly SlotRequirement[],
  spanOf: (groupIds: string[]) => GradeSpan | null,
  weightOf: ((subjectId: string) => number) | null,
): LoadRequirement[] {
  return masters
    .filter((m) => !m.isParked)
    .map((m) => {
      const groups = [m.studentGroupId, ...m.extraGroupIds.filter((id) => id !== m.studentGroupId)];
      return {
        id: `m:${m.id}`,
        subjectId: m.subjectId,
        subjectName: m.subjectName,
        studentGroupId: m.studentGroupId,
        groupName: m.groupName,
        teacherId: m.teacherId,
        coTeacherId: m.coTeacherId,
        lessonsPerWeek: 1,
        minutesPerLesson: lessonMinutes(m),
        lessonLengths: [],
        recurrence: m.recurrence ?? 'ALL_WEEKS',
        startDate: m.startDate ?? null,
        endDate: m.endDate ?? null,
        gradeSpan: spanOf(groups),
        teacherLoadPercent: slotPercentOf(groups, m.subjectId, 'LEAD', m.teacherId, requirements),
        coTeacherLoadPercent: slotPercentOf(groups, m.subjectId, 'ASSISTANT', m.coTeacherId, requirements),
        ...(weightOf ? { loadWeight: weightOf(m.subjectId) } : {}),
      };
    });
}
