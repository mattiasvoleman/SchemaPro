import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { parseDateString } from '../common/utils/time';
import { dutySlotConstraintData } from '../staffing/duty-slot';
import type { RolloverWrites } from './rollover-plan';
import { ROLLOVER_STEP_ORDER, type RolloverStepName } from './rollover-registry';
import type { StaffingWrites } from './rollover-staffing';

/**
 * The rollover's writes, one step per carried table, in ROLLOVER_STEP_ORDER.
 *
 * INSERTS ONLY, AND ONLY INTO THE NEW YEAR. Every statement here is a create:
 * nothing in the source year is updated or deleted, which is what makes
 * "delete the new year" a complete undo before activation. The new year's id
 * is the only year id written, and every group id written is one the groups
 * step just created; year-rollover.service.spec.ts runs the execute against a
 * recording transaction and holds it to both.
 *
 * Bulk statements (createMany), not a loop: a rollover of 40 classes carries
 * some 600 requirements, and the transaction holds the source year's rows
 * FOR SHARE while it runs. The groups come back from createManyAndReturn and
 * are matched by name — unique within the new year, which the plan checked.
 */

export interface StepContext {
  tx: PrismaClient;
  schoolId: string;
  writes: RolloverWrites;
  targetYearId: string | null;
  groupIdByKey: Map<string, string>;
  counts: { groups: number; members: number; requirements: number; breaks: number; classRules: number; timplans: number };
  /**
   * What the two staffing steps wrote, beside `counts` rather than in it: the
   * result's `counts` stays the shape it has always had (the adapter probe
   * compares it whole), and a rollover without tjänster reports null here.
   */
  staffingCounts: StaffingCounts;
}

export interface StaffingCounts {
  employments: number;
  duties: number;
  dutySlots: number;
}

const day = (value: string | null): Date | null => (value === null ? null : parseDateString(value));

const groupOf = (context: StepContext, key: string): string => {
  const id = context.groupIdByKey.get(key);
  if (!id) throw new Error(`Rollover: no group was created for ${key}.`);
  return id;
};

export const ROLLOVER_STEPS: Record<RolloverStepName, (context: StepContext) => Promise<void>> = {
  async year(context) {
    const { year } = context.writes;
    const created = await context.tx.academicYear.create({
      data: {
        schoolId: context.schoolId,
        name: year.name,
        startDate: parseDateString(year.startDate),
        endDate: parseDateString(year.endDate),
        isActive: false,
        predecessorId: year.predecessorId,
        graduatingGradeLevel: year.graduatingGradeLevel,
      },
      select: { id: true },
    });
    context.targetYearId = created.id;
  },

  async groups(context) {
    if (context.writes.groups.length === 0) return;
    const created = await context.tx.studentGroup.createManyAndReturn({
      data: context.writes.groups.map((group) => ({
        schoolId: context.schoolId,
        academicYearId: context.targetYearId as string,
        name: group.name,
        kind: group.kind,
        gradeLevel: group.gradeLevel,
        predecessorId: group.predecessorId,
      })),
      select: { id: true, name: true },
    });
    const idByName = new Map(created.map((group) => [group.name, group.id]));
    for (const group of context.writes.groups) {
      const id = idByName.get(group.name);
      if (!id) throw new Error('Rollover: a created group did not come back.');
      context.groupIdByKey.set(group.key, id);
    }
    context.counts.groups = created.length;
  },

  async members(context) {
    if (context.writes.members.length === 0) return;
    const { count } = await context.tx.studentGroupMember.createMany({
      data: context.writes.members.map((member) => ({
        schoolId: context.schoolId,
        studentGroupId: groupOf(context, member.groupKey),
        studentId: member.studentId,
      })),
    });
    context.counts.members = count;
  },

  async requirements(context) {
    if (context.writes.requirements.length === 0) return;
    const { count } = await context.tx.teachingRequirement.createMany({
      data: context.writes.requirements.map((row) => ({
        schoolId: context.schoolId,
        academicYearId: context.targetYearId as string,
        subjectId: row.subjectId,
        studentGroupId: groupOf(context, row.groupKey),
        teacherId: row.teacherId,
        coTeacherId: row.coTeacherId,
        lessonsPerWeek: row.lessonsPerWeek,
        minutesPerLesson: row.minutesPerLesson,
        // Only a split row names its list; a uniform one leaves it to the
        // column's '{}', so a school that never splits writes what it did.
        ...(row.lessonLengths ? { lessonLengths: row.lessonLengths } : {}),
        minutesBefore: row.minutesBefore,
        minutesAfter: row.minutesAfter,
        // Only a row with its own ämnesfördelning names them, each where it
        // is not the column's default; one that follows its subject writes
        // what it always wrote.
        ...(row.ownDistribution ? { ownDistribution: true } : {}),
        ...(row.maxLessonsPerDay !== undefined ? { maxLessonsPerDay: row.maxLessonsPerDay } : {}),
        ...(row.minDaysBetween !== undefined ? { minDaysBetween: row.minDaysBetween } : {}),
        teacherLoadPercent: row.teacherLoadPercent,
        coTeacherLoadPercent: row.coTeacherLoadPercent,
        recurrence: row.recurrence,
        startDate: day(row.startDate),
        endDate: day(row.endDate),
      })),
    });
    context.counts.requirements = count;
  },

  async breaks(context) {
    if (context.writes.breaks.length === 0) return;
    const { count } = await context.tx.schoolBreak.createMany({
      data: context.writes.breaks.map((lov) => ({
        schoolId: context.schoolId,
        academicYearId: context.targetYearId as string,
        name: lov.name,
        kind: lov.kind,
        startDate: parseDateString(lov.startDate),
        endDate: parseDateString(lov.endDate),
        minGradeLevel: lov.minGradeLevel,
        maxGradeLevel: lov.maxGradeLevel,
      })),
    });
    context.counts.breaks = count;
  },

  async classRules(context) {
    if (context.writes.classRules.length === 0) return;
    const { count } = await context.tx.availabilityConstraint.createMany({
      data: context.writes.classRules.map((rule) => ({
        schoolId: context.schoolId,
        resourceType: 'STUDENT_GROUP' as const,
        userId: null,
        roomId: null,
        studentGroupId: groupOf(context, rule.groupKey),
        dayOfWeek: rule.dayOfWeek,
        date: null,
        startTime: rule.startTime,
        endTime: rule.endTime,
        type: rule.type,
        reason: rule.reason,
        minGradeLevel: rule.minGradeLevel,
        maxGradeLevel: rule.maxGradeLevel,
      })),
    });
    context.counts.classRules = count;
  },

  async timplans(context) {
    if (context.writes.timplans.length === 0) return;
    // The cohort rows are the year's whole mapping, never added to P2's
    // defaults: the year step writes none, and a year that somehow has
    // rows already (a future year step routed through
    // AcademicYearsService.create) is refused here rather than mixed.
    const existing = await context.tx.academicYearTimplan.count({
      where: { academicYearId: context.targetYearId as string },
    });
    if (existing > 0) throw new Error('Rollover: the new year already has a timplan per årskurs.');
    const { count } = await context.tx.academicYearTimplan.createMany({
      data: context.writes.timplans.map((row) => ({
        schoolId: context.schoolId,
        academicYearId: context.targetYearId as string,
        gradeLevel: row.gradeLevel,
        localTimplanId: row.localTimplanId,
      })),
    });
    context.counts.timplans = count;
  },

  async employments(context) {
    const staffing = context.writes.staffing;
    if (!staffing || staffing.employments.length === 0) return;
    const counts = await applyStaffingWrites(
      context.tx,
      context.schoolId,
      context.targetYearId as string,
      { employments: staffing.employments, duties: [] },
      (key) => groupOf(context, key),
    );
    context.staffingCounts.employments = counts.employments;
  },

  async duties(context) {
    const staffing = context.writes.staffing;
    if (!staffing || staffing.duties.length === 0) return;
    const counts = await applyStaffingWrites(
      context.tx,
      context.schoolId,
      context.targetYearId as string,
      { employments: [], duties: staffing.duties },
      (key) => groupOf(context, key),
    );
    context.staffingCounts.duties = counts.duties;
    context.staffingCounts.dutySlots = counts.dutySlots;
  },
};

/**
 * Tjänster and uppdrag into `targetYearId`, inserts only: the rollover's two
 * last steps, and the whole of the carry into an already rolled year.
 *
 *  - employments: one createMany.
 *  - duties: the times first, one createMany of NEW constraints
 *    (dutySlotConstraintData — the shape TeacherDutiesService writes), then
 *    one createMany of the duties, then one createMany of the TeacherDutySlots
 *    rows linking each duty to its times (migration 20261017090000). The
 *    duties' and the constraints' ids are drawn here, so a link names its
 *    two rows without a RETURNING to match back — an uppdrag may hold three
 *    times on one weekday, and two uppdrag of one teacher may be identical.
 *    TeacherDutySlots_are_the_teachers checks every link as it lands; a
 *    refusal (TD409) aborts the whole transaction. A carried uppdrag is
 *    undated and never writes the old one-time column.
 *
 * Four statements whatever the school's size. The source's own times are
 * never touched: they stay with their year (constraintsOfYear).
 */
export async function applyStaffingWrites(
  tx: PrismaClient,
  schoolId: string,
  targetYearId: string,
  staffing: StaffingWrites,
  groupOf: (key: string) => string,
): Promise<StaffingCounts> {
  const counts: StaffingCounts = { employments: 0, duties: 0, dutySlots: 0 };
  if (staffing.employments.length > 0) {
    const { count } = await tx.teacherEmployment.createMany({
      data: staffing.employments.map((row) => ({
        schoolId,
        userId: row.userId,
        academicYearId: targetYearId,
        employmentPercent: row.employmentPercent,
        reductionPercent: row.reductionPercent,
        contractKind: row.contractKind,
        teachingTargetMinutesPerWeek: row.teachingTargetMinutesPerWeek,
        signature: row.signature,
        note: row.note,
      })),
    });
    counts.employments = count;
  }
  if (staffing.duties.length === 0) return counts;

  const constraints: (ReturnType<typeof dutySlotConstraintData> & { id: string })[] = [];
  const links: { schoolId: string; teacherDutyId: string; availabilityConstraintId: string }[] = [];
  const duties = staffing.duties.map((duty) => {
    const id = randomUUID();
    for (const slot of duty.slots) {
      const constraintId = randomUUID();
      constraints.push({ id: constraintId, ...dutySlotConstraintData(schoolId, duty.userId, slot) });
      links.push({ schoolId, teacherDutyId: id, availabilityConstraintId: constraintId });
    }
    return {
      id,
      schoolId,
      userId: duty.userId,
      academicYearId: targetYearId,
      kind: duty.kind,
      label: duty.label,
      minutesPerWeek: duty.minutesPerWeek,
      countsAsTeaching: duty.countsAsTeaching,
      subjectId: duty.subjectId,
      studentGroupId: duty.groupKey === null ? null : groupOf(duty.groupKey),
      validFrom: null,
      validTo: null,
      blockedConstraintId: null,
      note: duty.note,
    };
  });
  if (constraints.length > 0) {
    const { count } = await tx.availabilityConstraint.createMany({ data: constraints });
    counts.dutySlots = count;
  }
  const { count } = await tx.teacherDuty.createMany({ data: duties });
  counts.duties = count;
  if (links.length > 0) await tx.teacherDutySlot.createMany({ data: links });
  return counts;
}

/** Runs every step in order; returns the new year's id and what was written. */
export async function applyRollover(
  tx: PrismaClient,
  schoolId: string,
  writes: RolloverWrites,
): Promise<{ targetYearId: string; counts: StepContext['counts']; staffingCounts: StaffingCounts }> {
  const context: StepContext = {
    tx,
    schoolId,
    writes,
    targetYearId: null,
    groupIdByKey: new Map(),
    counts: { groups: 0, members: 0, requirements: 0, breaks: 0, classRules: 0, timplans: 0 },
    staffingCounts: { employments: 0, duties: 0, dutySlots: 0 },
  };
  for (const step of ROLLOVER_STEP_ORDER) {
    await ROLLOVER_STEPS[step](context);
  }
  return { targetYearId: context.targetYearId as string, counts: context.counts, staffingCounts: context.staffingCounts };
}
