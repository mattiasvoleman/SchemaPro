import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { toWallClock } from '../common/utils/time';
import { applyStaffingWrites, type StaffingCounts } from './rollover-apply';
import { readSourceStaffing } from './rollover-source';
import {
  hashStaffingCarry,
  planStaffingCarry,
  slotsOverLessons,
  type ExistingStaffing,
  type StaffingCarryPlan,
  type StaffingCarryPreview,
  type StaffingProblem,
} from './rollover-staffing';
import { lockSourceStaffing } from './year-rollover.service';

export const STAFFING_ROLLOVER_NO_PREDECESSOR = 'STAFFING_ROLLOVER_NO_PREDECESSOR';
export const STAFFING_ROLLOVER_PREVIEW_STALE = 'STAFFING_ROLLOVER_PREVIEW_STALE';

/** As the rollover's: a school of 60 teachers and 400 uppdrag fits with room to spare. */
const CARRY_TIMEOUT_MS = 60_000;

export type StaffingRolloverPreview = StaffingCarryPreview & {
  source: { id: string; name: string };
  target: { id: string; name: string };
  problems: StaffingProblem[];
  blocking: false;
  planHash: string;
};

export interface StaffingRolloverResult {
  targetYearId: string;
  counts: StaffingCounts;
  planHash: string;
}

interface CarryRead {
  source: { id: string; name: string };
  target: { id: string; name: string };
  plan: StaffingCarryPlan;
  planHash: string;
  groupIdByKey: Map<string, string>;
}

/**
 * Tjänster and uppdrag carried into a läsår that was rolled WITHOUT them —
 * before staffing Fas 5 existed, or with "Ta med tjänster och uppdrag" off
 * (staffing Fas 5, (2)). `:id` is the target; the source is always its
 * predecessor, never a year the caller names.
 *
 * THE SAME CARRY AS THE ROLLOVER'S. planStaffingCarry decides, with what the
 * target already holds: a teacher who has a post there is skipped whole and
 * named, and the others' uppdrag are matched one to one, so a second run
 * writes nothing and a deleted carried uppdrag is not brought back. The
 * inserts are the rollover's own (applyStaffingWrites): new slots through the
 * builder the Fas 2 guards accept, and nothing in the source year updated or
 * deleted.
 *
 * LOCKS (C1). The target year FOR KEY SHARE — it must not vanish, and its
 * dates and flag are none of this carry's business — and NOT the source
 * year: the year writers take two years in both orders (the activation the
 * target then the year it deactivates; the year PATCH the other way), so any
 * fixed two-year order here would close a cycle with one of them. FOR KEY
 * SHARE waits on no year writer but a delete. The source year cannot be
 * deleted under the carry anyway: its posts and uppdrag are held FOR SHARE
 * below, and its cascade would wait on them. Then the target's groups, the
 * staff, and the source's posts and uppdrag, as the rollover takes them.
 *
 * HR STAYS HR. SCHOOL_ADMIN only (the controller); the preview carries ids,
 * kinds, labels and counts the admin already reads. It never reaches
 * rostersOfYear (roster-readers.inventory.spec.ts holds the route list).
 */
@Injectable()
export class StaffingRolloverService {
  private readonly logger = new Logger(StaffingRolloverService.name);

  constructor(private readonly prisma: PrismaService) {}

  async preview(targetYearId: string, user: AuthenticatedUser): Promise<StaffingRolloverPreview> {
    requireSchoolId(user);
    try {
      return await this.prisma.withRls(
        user,
        async (tx) => {
          const year = await tx.academicYear.findUnique({
            where: { id: targetYearId },
            select: { id: true, name: true, predecessorId: true },
          });
          if (!year) throw yearNotFound();
          if (!year.predecessorId) throw noPredecessor(year.name);
          const read = await readCarry(tx, { id: year.id, name: year.name }, year.predecessorId);
          const problems = [...read.plan.problems];
          // A carry into a year that is already scheduled: advice, outside the hash.
          const overLessons = slotsOverLessons(read.plan.writes, await lessonsOf(tx, targetYearId, read.plan));
          if (overLessons) problems.push(overLessons);
          return {
            ...read.plan.preview,
            source: read.source,
            target: read.target,
            problems,
            blocking: false as const,
            planHash: read.planHash,
          };
        },
        { timeoutMs: CARRY_TIMEOUT_MS },
      );
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  async execute(targetYearId: string, planHash: string, user: AuthenticatedUser): Promise<StaffingRolloverResult> {
    const schoolId = requireSchoolId(user);
    try {
      const result = await this.prisma.withRls(
        user,
        async (tx) => {
          const [year] = await tx.$queryRaw<{ id: string; name: string; predecessorId: string | null }[]>`
            SELECT "id", "name", "predecessorId"
            FROM "AcademicYears"
            WHERE "id" = ${targetYearId}::uuid
            FOR KEY SHARE
          `;
          if (!year) throw yearNotFound();
          if (!year.predecessorId) throw noPredecessor(year.name);
          // The target's groups, so the successor map cannot change under the insert.
          await tx.$queryRaw`
            SELECT "id"
            FROM "StudentGroups"
            WHERE "academicYearId" = ${targetYearId}::uuid
            ORDER BY "id"
            FOR SHARE
          `;
          await lockSourceStaffing(tx, year.predecessorId);
          const read = await readCarry(tx, { id: year.id, name: year.name }, year.predecessorId);
          if (read.planHash !== planHash) throw carryStale();
          const counts = await applyStaffingWrites(tx, schoolId, targetYearId, read.plan.writes, (key) => {
            const id = read.groupIdByKey.get(key);
            if (!id) throw new Error(`Staffing carry: no group of the target continues ${key}.`);
            return id;
          });
          return { targetYearId, counts, planHash: read.planHash, sourceYearId: read.source.id };
        },
        { timeoutMs: CARRY_TIMEOUT_MS },
      );
      const { counts } = result;
      this.logger.log(
        `Tjänster överförda [school=${schoolId}, source=${result.sourceYearId}, target=${targetYearId}, ` +
          `employments=${counts.employments}, duties=${counts.duties}, dutySlots=${counts.dutySlots}]`,
      );
      return { targetYearId, counts, planHash: result.planHash };
    } catch (error) {
      // A post written for a teacher outside the locked set between the read
      // and the insert, or a signature taken meanwhile (C4): the preview no
      // longer describes the year, and nothing was written.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw carryStale();
      rethrowPrismaError(error);
    }
  }
}

/**
 * The carry's plan from the rows as they are: the source year's staffing and
 * every person it names, and what the target already holds. In sequence; one
 * transaction is one connection.
 */
async function readCarry(
  tx: PrismaClient,
  target: { id: string; name: string },
  sourceYearId: string,
): Promise<CarryRead> {
  const sourceYear = await tx.academicYear.findUnique({ where: { id: sourceYearId }, select: { id: true, name: true } });
  if (!sourceYear) throw noPredecessor(target.name);
  const staffing = await readSourceStaffing(tx, sourceYearId);
  const sourceGroups = await tx.studentGroup.findMany({
    where: { academicYearId: sourceYearId },
    select: { id: true, name: true },
  });
  const targetGroups = await tx.studentGroup.findMany({
    where: { academicYearId: target.id },
    select: { id: true, name: true, predecessorId: true },
  });
  const posts = await tx.teacherEmployment.findMany({
    where: { academicYearId: target.id },
    select: { userId: true, signature: true },
  });
  const duties = await tx.teacherDuty.findMany({
    where: { academicYearId: target.id },
    select: {
      id: true,
      userId: true,
      kind: true,
      label: true,
      studentGroupId: true,
      blockedConstraint: { select: { dayOfWeek: true, startTime: true, endTime: true } },
    },
  });

  const nameOf = new Map((sourceGroups ?? []).map((group) => [group.id, group.name]));
  // A target group continues the source group named by its predecessorId
  // (LR409 keeps that inside the source year); the key is the source id.
  const successorBy = new Map<string, { id: string; name: string }>();
  const keyOf = new Map<string, string>();
  for (const group of targetGroups ?? []) {
    keyOf.set(group.id, group.predecessorId ?? `target:${group.id}`);
    if (group.predecessorId && nameOf.has(group.predecessorId)) successorBy.set(group.predecessorId, group);
  }
  const existing: ExistingStaffing = {
    employmentUserIds: new Set((posts ?? []).map((post) => post.userId)),
    signatures: new Map((posts ?? []).filter((post) => post.signature !== null).map((post) => [post.signature as string, post.userId])),
    duties: (duties ?? []).map((duty) => ({
      id: duty.id,
      userId: duty.userId,
      kind: duty.kind,
      label: duty.label,
      groupKey: duty.studentGroupId ? (keyOf.get(duty.studentGroupId) ?? `target:${duty.studentGroupId}`) : null,
      slot:
        duty.blockedConstraint && duty.blockedConstraint.dayOfWeek !== null
          ? {
              dayOfWeek: duty.blockedConstraint.dayOfWeek,
              startTime: toWallClock(duty.blockedConstraint.startTime),
              endTime: toWallClock(duty.blockedConstraint.endTime),
            }
          : null,
    })),
  };
  const plan = planStaffingCarry({
    staffing,
    successorOf: (sourceGroupId) => {
      const successor = successorBy.get(sourceGroupId);
      return successor ? { key: sourceGroupId, name: successor.name } : null;
    },
    groupName: (sourceGroupId) => nameOf.get(sourceGroupId) ?? null,
    existing,
  });
  return {
    source: { id: sourceYear.id, name: sourceYear.name },
    target,
    plan,
    planHash: hashStaffingCarry(sourceYear.id, target.id, plan.writes),
    groupIdByKey: new Map([...successorBy].map(([key, group]) => [key, group.id])),
  };
}

/** The target's placed lessons of the teachers whose slots the carry writes; none read when it writes none. */
async function lessonsOf(tx: PrismaClient, targetYearId: string, plan: StaffingCarryPlan) {
  const teachers = [...new Set(plan.writes.duties.filter((duty) => duty.slot !== null).map((duty) => duty.userId))].sort();
  if (teachers.length === 0) return [];
  const lessons = await tx.masterLesson.findMany({
    where: {
      academicYearId: targetYearId,
      isParked: false,
      OR: [{ teacherId: { in: teachers } }, { coTeacherId: { in: teachers } }],
    },
    select: { teacherId: true, coTeacherId: true, dayOfWeek: true, startTime: true, endTime: true },
  });
  return (lessons ?? []).map((lesson) => ({
    teacherId: lesson.teacherId,
    coTeacherId: lesson.coTeacherId,
    dayOfWeek: lesson.dayOfWeek,
    startTime: toWallClock(lesson.startTime),
    endTime: toWallClock(lesson.endTime),
  }));
}

function yearNotFound(): NotFoundException {
  return new NotFoundException('Läsåret finns inte.');
}

function noPredecessor(yearName: string): ConflictException {
  return new ConflictException({
    message: `Läsåret ${yearName} rullades inte vidare från något läsår, så det finns inga tjänster att ta med.`,
    code: STAFFING_ROLLOVER_NO_PREDECESSOR,
    params: { year: yearName },
  });
}

function carryStale(): ConflictException {
  return new ConflictException({
    message: 'Tjänster eller uppdrag har ändrats sedan förhandsvisningen. Inget skapades. Förhandsvisa igen.',
    code: STAFFING_ROLLOVER_PREVIEW_STALE,
  });
}
