import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { toResult, type LessonRecord } from '../calendar/master-lessons.service';
import { ScheduleVersionsService } from '../calendar/schedule-versions.service';
import { isWriteConflict, writeConflict } from '../common/utils/prisma-errors';
import { requireSchoolId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';
import { calendarSweepWhere, regenerationSweepDay } from '../optimization/optimization-proxy.service';
import { lockYearForRegeneration } from '../optimization/regeneration-lock';
import type { PlacedPost } from '../optimization/placed-lessons';
import { enterGrundschemaWrite, type PublishMode } from '../publication/publish-mode';
import { RealtimeService } from '../realtime/realtime.service';
import { planWriteIn, type NotWrittenRow, type WriteInPlan } from './placement-write-in';
import { RequirementPlacementsService } from './requirement-placements.service';

/** What Skriv in förläggningarna says: what it wrote (or would), what it replaced, and what it left and why. */
export interface PlacementWriteInResult {
  academicYearId: string;
  /** true: nothing was written, this is what a write would do. */
  preview: boolean;
  /** Lessons made from förläggningar that hold and name a room. */
  lessonsWritten: number;
  /** Lessons an earlier run wrote from förläggningar that this write replaces. */
  lessonsReplaced: number;
  /** Dated lessons of the replaced ones taken off the published calendar (DIRECT mode, from today on). */
  calendarLessonsRemoved: number;
  /** The posts that got a lesson. */
  postsWritten: number;
  /** Every förläggning left, with its reason: the week does not hold it, it leaves the room to the engine, or it is a block's. */
  notWritten: NotWrittenRow[];
  /** The version taken before anything was replaced, to put back; null for a preview and for a write that changed nothing. */
  safetyVersionId: string | null;
}

/** The lessons an earlier run wrote from förläggningar, read as a regeneration reads the ones it replaces. */
const EXISTING_SELECT = {
  id: true,
  academicYearId: true,
  subjectId: true,
  studentGroupId: true,
  teacherId: true,
  coTeacherId: true,
  roomId: true,
  dayOfWeek: true,
  startTime: true,
  endTime: true,
  isLocked: true,
  isParked: true,
  exemptFrom: true,
  recurrence: true,
  startDate: true,
  endDate: true,
  extraGroups: { select: { studentGroupId: true } },
  participants: { select: { studentId: true } },
} as const;

/** The scalar columns a created lesson comes back with (createManyAndReturn reads no relation). */
const CREATED_SELECT = {
  id: true,
  academicYearId: true,
  subjectId: true,
  studentGroupId: true,
  teacherId: true,
  coTeacherId: true,
  roomId: true,
  dayOfWeek: true,
  startTime: true,
  endTime: true,
  isLocked: true,
  isParked: true,
  recurrence: true,
  startDate: true,
  endDate: true,
} as const;

/**
 * SKRIV IN FÖRLÄGGNINGARNA (E4b, beslut 7): the year's förläggningar that hold and name a room are written to the grundschema as the lessons
 * Generera would write from them, and nothing is asked of the engine. A school that has placed lessons and cannot get Generera to finish
 * gets a week to work in; Generera then takes what is left (placement-write-in.ts says what is written, replaced and left, and why).
 *
 * THE ROWS ARE JUDGED AS GENERERA'S PRE-FLIGHT JUDGES THEM (RequirementPlacementsService.judgedYear, the week's own call), against the lessons
 * Generera keeps and each other, and the verdicts are read in the same transaction that writes. Generera refuses the whole run for a row the
 * week does not hold; the bridge writes the others and names that one.
 *
 * ONE REWRITE OF THE YEAR AT A TIME. It replaces lessons the way Generera does (the year's regeneration lock, exclusive and waited for at most
 * 5 s, then 409 SCHEDULE_BUSY), so it cannot land in the middle of a Generera's write or an apply, and a hand edit meeting it answers the same
 * 409. In DIRECT mode the dated lessons of the lessons it replaces are swept off the calendar from the school's today on, as a regeneration does
 * it; a publish writes the new ones. A restore point is taken first (a version, as a swap takes one).
 *
 * WHAT IT WRITES IS THE RUN'S OWN: locked, `isGenerated` and `fromPlacement`, so the next Generera replaces it from the rows as they then stand
 * and a hand edit cannot move it (LESSON_IS_PLACED).
 */
@Injectable()
export class PlacementWriteInService {
  private readonly logger = new Logger(PlacementWriteInService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly placements: RequirementPlacementsService,
    private readonly versions: ScheduleVersionsService,
    private readonly realtime: RealtimeService,
  ) {}

  /** What a write would do now, written nowhere. A read every administrator may make. */
  async preview(academicYearId: string, user: AuthenticatedUser): Promise<PlacementWriteInResult> {
    return this.prisma.withRls(user, async (tx) => {
      const { plan } = await this.planOf(tx, user, academicYearId);
      return this.resultOf(academicYearId, plan, { preview: true, calendarLessonsRemoved: 0, safetyVersionId: null });
    });
  }

  async write(academicYearId: string, user: AuthenticatedUser): Promise<PlacementWriteInResult> {
    let mode = 'DIRECT' as PublishMode;
    let result: PlacementWriteInResult;
    try {
      result = await this.prisma.withRls(user, async (tx) => {
        const schoolId = requireSchoolId(user);
        const year = await tx.academicYear.findUnique({ where: { id: academicYearId }, select: { id: true } });
        if (!year) throw new NotFoundException('Läsåret finns inte.');
        mode = await enterGrundschemaWrite(tx, schoolId);
        await lockYearForRegeneration(tx, academicYearId);
        const { plan, existing } = await this.planOf(tx, user, academicYearId);
        if (plan.creates.length === 0 && plan.deleteIds.length === 0) {
          return this.resultOf(academicYearId, plan, { preview: false, calendarLessonsRemoved: 0, safetyVersionId: null });
        }

        // The restore point first, in this transaction: a refused write leaves no version of a change that never happened.
        const safety = await this.versions.snapshotInTransaction(tx, academicYearId, 'Före inskrivning av förläggningar', user);
        const sweepFrom = mode === 'DRAFT' ? null : await regenerationSweepDay(tx, schoolId);
        const { count: calendarLessonsRemoved } =
          sweepFrom === null || plan.deleteIds.length === 0
            ? { count: 0 }
            : await tx.calendarLesson.deleteMany({ where: calendarSweepWhere({ kind: 'IDS', ids: plan.deleteIds }, academicYearId, sweepFrom) });
        if (plan.deleteIds.length > 0) {
          const { count } = await tx.masterLesson.deleteMany({ where: { academicYearId, fromPlacement: true, id: { in: plan.deleteIds } } });
          // The year's regeneration lock is held, so these rows are as they were read; one gone is a draft that moved.
          if (count !== plan.deleteIds.length) throw writeConflict();
        }
        const created = plan.creates.length === 0 ? [] : await tx.masterLesson.createManyAndReturn({ data: plan.creates, select: CREATED_SELECT });

        const replaced = existing.filter((lesson) => plan.deleteIds.includes(lesson.id));
        await tx.scheduleChangeLog.createMany({
          data: [
            ...replaced.map((lesson) => ({
              schoolId,
              academicYearId,
              masterLessonId: lesson.id,
              actorId: user.userId ?? null,
              action: 'DELETE' as const,
              before: toResult(lesson as LessonRecord) as unknown as Prisma.InputJsonValue,
            })),
            ...created.map((lesson) => ({
              schoolId,
              academicYearId,
              masterLessonId: lesson.id,
              actorId: user.userId ?? null,
              action: 'CREATE' as const,
              after: toResult({ ...lesson, extraGroups: [], participants: [] } as LessonRecord) as unknown as Prisma.InputJsonValue,
            })),
          ],
        });
        this.logger.log(
          `Förläggningar written to the grundschema [year=${academicYearId}, written=${created.length}, replaced=${plan.deleteIds.length}, notWritten=${plan.notWritten.length}, version=${safety.id}]`,
        );
        return this.resultOf(academicYearId, plan, { preview: false, calendarLessonsRemoved, safetyVersionId: safety.id });
      });
    } catch (error) {
      if (isWriteConflict(error)) throw writeConflict();
      throw error;
    }
    // After the commit, so a page that reads on hearing of it finds the lessons as they now are.
    if (result.lessonsWritten > 0 || result.lessonsReplaced > 0) {
      const schoolId = requireSchoolId(user);
      if (mode === 'DRAFT') this.realtime.notifyMasterTimetableChanged(schoolId, { draft: true });
      else this.realtime.notifyMasterTimetableChanged(schoolId);
    }
    return result;
  }

  /** The year's rows judged now, and what writing them would do. */
  private async planOf(tx: PrismaClient, user: AuthenticatedUser, academicYearId: string) {
    const judged = await this.placements.judgedYear(tx, user, academicYearId);
    const existing = await tx.masterLesson.findMany({ where: { academicYearId, fromPlacement: true }, select: EXISTING_SELECT, orderBy: { id: 'asc' } });
    const posts = new Map<string, PlacedPost>(judged.posts.map((post) => [post.id, post]));
    const plan = planWriteIn({
      schoolId: requireSchoolId(user),
      academicYearId,
      rows: judged.rows,
      verdicts: judged.verdicts,
      posts,
      blockRows: judged.ofBlocks.flatMap((entry) => entry.block.rows.map((row) => ({ id: row.id, blockId: entry.block.id }))),
      existing,
    });
    return { plan, existing };
  }

  private resultOf(
    academicYearId: string,
    plan: WriteInPlan,
    facts: { preview: boolean; calendarLessonsRemoved: number; safetyVersionId: string | null },
  ): PlacementWriteInResult {
    return {
      academicYearId,
      preview: facts.preview,
      lessonsWritten: plan.creates.length,
      lessonsReplaced: plan.deleteIds.length,
      calendarLessonsRemoved: facts.calendarLessonsRemoved,
      postsWritten: plan.postsWritten,
      notWritten: plan.notWritten,
      safetyVersionId: facts.safetyVersionId,
    };
  }
}
