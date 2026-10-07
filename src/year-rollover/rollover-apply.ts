import type { PrismaClient } from '@prisma/client';
import { parseDateString } from '../common/utils/time';
import type { RolloverWrites } from './rollover-plan';
import { ROLLOVER_STEP_ORDER, type RolloverStepName } from './rollover-registry';

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
  counts: { groups: number; members: number; requirements: number; breaks: number; classRules: number };
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
        minutesBefore: row.minutesBefore,
        minutesAfter: row.minutesAfter,
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
};

/** Runs every step in order; returns the new year's id and what was written. */
export async function applyRollover(
  tx: PrismaClient,
  schoolId: string,
  writes: RolloverWrites,
): Promise<{ targetYearId: string; counts: StepContext['counts'] }> {
  const context: StepContext = {
    tx,
    schoolId,
    writes,
    targetYearId: null,
    groupIdByKey: new Map(),
    counts: { groups: 0, members: 0, requirements: 0, breaks: 0, classRules: 0 },
  };
  for (const step of ROLLOVER_STEP_ORDER) {
    await ROLLOVER_STEPS[step](context);
  }
  return { targetYearId: context.targetYearId as string, counts: context.counts };
}
