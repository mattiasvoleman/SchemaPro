import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { calendarLessonRosters } from '../calendar/lesson-roster';
import { RealtimeService } from '../realtime/realtime.service';
import { NotificationsService } from '../notifications/notifications.service';
import { checkScope, createCreditInTransaction } from '../timplan/timplan-credits.service';
import { enterGrundschemaWrite } from './publish-mode';
import {
  inScope,
  inWindow,
  selectLessons,
  selectionDigest,
  type SelectionCandidate,
} from './cancellation-selection';
import {
  BATCH_SELECT,
  CANDIDATE_SELECT,
  CANCELLATION_CREDIT,
  CANCELLATION_REVERSED,
  CANCELLATION_SCOPE,
  applyReinstatement,
  asDay,
  cancelInto,
  checkSelection,
  clock,
  creditDatesOf,
  creditTargetsOf,
  day,
  digestLessonOf,
  digestLessonsOf,
  reversePlan,
  ruleOf,
  stale,
  time,
  toCandidate,
  yearOf,
  type BatchRow,
  type StoredSelection,
} from './cancellation-core';
import { digestAudience, sendDigest, type DigestAudience } from './cancellation-digest';
import {
  expandNamedGroups,
  cancelledNoteOf,
  teacherClashes,
  type GroupFacts,
  type PlannedReplacement,
  type ScopeRule,
} from './activity-plan';
import {
  loadGroupFacts,
  memberHomes,
  ownersWithPupils,
  planOf,
  syncReplacementsInTransaction,
  type ReplacedLesson,
  type SyncResult,
} from './activity-replacements';
import type { BatchLessonView } from './cancellation-batches.service';
import type { CreateScheduleActivityDto, ScheduleActivitySelectionDto } from './dto/schedule-activity.dto';

export const ACTIVITY_SUBJECT = 'ACTIVITY_SUBJECT';
export const ACTIVITY_SUBJECT_COUNTS = 'ACTIVITY_SUBJECT_COUNTS';
export const ACTIVITY_CREDIT_SUBJECT = 'ACTIVITY_CREDIT_SUBJECT';
export const ACTIVITY_TEACHER = 'ACTIVITY_TEACHER';
export const ACTIVITY_SCOPE_TOO_WIDE = 'ACTIVITY_SCOPE_TOO_WIDE';
export const ACTIVITY_REMOVED = 'ACTIVITY_REMOVED';

/** A class or group with a replacement lesson, and who is responsible for it. */
export interface ActivityClassView {
  groupId: string;
  name: string;
  teachers: Array<{ teacherId: string; role: 'LEAD' | 'ASSISTANT' }>;
  /** Days it has a replacement lesson. */
  days: number;
  firstDate: string | null;
  lastDate: string | null;
}

export interface ActivityPreview {
  /** Lessons the activity cancels (on a change: takes now and holds). */
  matched: number;
  /** The first 50, in time order. */
  lessons: BatchLessonView[];
  excluded: { started: number; notScheduled: number; attendance: number };
  ungradedGroups: string[];
  /** Groups beyond the named ones that the cancellation takes: halves and groups wholly inside the named classes. */
  expandedGroups: Array<{ id: string; name: string }>;
  classes: ActivityClassView[];
  replacementLessons: number;
  warnings: {
    /** Classes with a replacement lesson and nobody responsible: the lesson counts as teacherless. */
    classesWithoutTeacher: string[];
    /** Lessons that go on for pupils of the activity's classes: a group with pupils of other classes too. */
    continuing: Array<{ name: string; lessons: number }>;
    /** Pupils on a cancelled lesson whom no class of the activity holds. */
    uncoveredPupils: number;
    teacherClashes: Array<{ teacherId: string; date: string; groupName: string; busyWith: string }>;
  };
  creditDates: string[];
  digest: string;
  audience: { pupils: number; guardians: number; teachers: number };
  /** Only on a change: what it puts back and what it takes. */
  change?: { released: number; taken: number };
}

export interface ScheduleActivityView {
  id: string;
  batchId: string;
  name: string;
  description: string | null;
  fromDate: string;
  toDate: string;
  startTime: string | null;
  endTime: string | null;
  scope: string;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  scopeGroupIds: string[];
  replacementSubject: { id: string; name: string; countsTowardTimplan: boolean } | null;
  cancelled: number;
  replacementLessons: number;
  credits: number;
  teachers: Array<{ studentGroupId: string; teacherId: string; role: 'LEAD' | 'ASSISTANT' }>;
  notifies: boolean;
  createdAt: string;
  createdByUserId: string | null;
  removedAt: string | null;
  reinstated: number;
  /** The subject counts toward the timplan now: the day's minutes would be counted twice. */
  doubleCounts: boolean;
}

export interface RemovePreview {
  reinstate: number;
  /** People the removal's digest reaches; 0 for an activity that told nobody. */
  notify: number;
  replacementsDeleted: number;
  /** Replacement lessons that have begun or carry attendance: kept, with the lessons they replaced. */
  replacementsKept: number;
  creditsDeleted: number;
  skippedRoomTaken: Array<{ lessonId: string; date: string; roomId: string; by: 'LESSON' | 'BOOKING' }>;
  removedTemplateMoved: Array<{ lessonId: string; date: string }>;
  notReinstatable: number;
}

const ACTIVITY_SELECT = {
  id: true,
  schoolId: true,
  academicYearId: true,
  batchId: true,
  replacementSubjectId: true,
  description: true,
  scopeGroupIds: true,
  createdAt: true,
  createdByUserId: true,
  removedAt: true,
  teachers: { select: { studentGroupId: true, teacherId: true, role: true } },
  batch: { select: BATCH_SELECT },
  _count: { select: { lessons: true } },
} as const;

/** What a request says, checked and normalised. */
interface Checked {
  /** As the administrator named it. */
  named: StoredSelection;
  replacementSubjectId: string;
  description: string | null;
  teachers: Array<{ studentGroupId: string; teacherId: string; role: 'LEAD' | 'ASSISTANT' }>;
  credits: Array<{ subjectId: string; minutes: number }>;
  notify: boolean;
}

interface Evaluation {
  preview: ActivityPreview;
  checked: Checked;
  /** The selection the cancellation runs by: the named one, widened (GROUPS). */
  effective: StoredSelection;
  timezone: string;
  today: string;
  groups: GroupFacts[];
  /** The lessons the activity newly takes. */
  take: SelectionCandidate[];
  /** On a change: the lessons it holds, as the new selection reads them. */
  keep: SelectionCandidate[];
  /** On a change: the lessons it puts back. */
  drop: SelectionCandidate[];
  plan: PlannedReplacement[];
  ownerNames: Map<string, string>;
}

/**
 * SCHEMABRYTANDE AKTIVITET: an avbokning and what takes its place.
 *
 * The activity owns one avbokning (cause EVENT) and uses all of its machinery:
 * the same selection, the same cancelled lessons carrying "Inställd: <namn>",
 * the same reversal rules (never a lesson that has begun, been held or carries
 * attendance), the same credit link. On top of it, a replacement lesson per
 * class and day that carries the attendance, with the teachers responsible,
 * and credits for the subjects the school names.
 *
 * The publication layer. A lesson exists in the calendar only once the
 * grundschema is published, DIRECT or DRAFT alike, so the activity acts on
 * the calendar as it is: lessons published into its days later are taken by
 * the avbokning's re-application (S7), which runs the replacement sync after
 * them. Every write holds the publication lock shared (enterGrundschemaWrite),
 * so no DRAFT publish moves rows between a selection and its writes. A
 * replacement lesson has no master lesson, so no publish, template change or
 * draft discard touches it; only the activity does.
 *
 * ADMIN ONLY, area DRIFT (the controller).
 */
@Injectable()
export class ScheduleActivitiesService {
  private readonly logger = new Logger(ScheduleActivitiesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
  ) {}

  async preview(dto: ScheduleActivitySelectionDto, user: AuthenticatedUser): Promise<ActivityPreview> {
    requireSchoolId(user);
    const checked = check(dto, true);
    return this.prisma.withRls(user, async (tx) => (await this.evaluate(tx, checked, null)).preview);
  }

  async create(
    dto: CreateScheduleActivityDto,
    user: AuthenticatedUser,
  ): Promise<{ activity: ScheduleActivityView; cancelled: number; replacementLessons: number; credits: number }> {
    const schoolId = requireSchoolId(user);
    const checked = check(dto, dto.notify !== false);
    const done = await this.prisma.withRls(
      user,
      async (tx) => {
        await enterGrundschemaWrite(tx, schoolId);
        const evaluation = await this.evaluate(tx, checked, null);
        if (dto.expectedDigest && dto.expectedDigest !== evaluation.preview.digest) throw stale();
        if (evaluation.take.length === 0) {
          throw new BadRequestException({
            message: 'Urvalet träffar inga lektioner att ställa in.',
            code: CANCELLATION_SCOPE,
          });
        }
        const { effective, take, today } = evaluation;
        const batch = await tx.cancellationBatch.create({
          data: {
            schoolId,
            academicYearId: effective.academicYearId,
            name: effective.name,
            cause: 'EVENT',
            fromDate: day(effective.fromDate),
            toDate: day(effective.toDate),
            startTime: effective.startTime ? time(effective.startTime) : null,
            endTime: effective.endTime ? time(effective.endTime) : null,
            scope: effective.scope,
            minGradeLevel: effective.minGradeLevel,
            maxGradeLevel: effective.maxGradeLevel,
            groupIds: effective.groupIds,
            createdByUserId: user.userId ?? null,
            notifies: checked.notify,
          },
          select: { id: true },
        });
        await cancelInto(tx, schoolId, batch.id, effective, take);
        const activity = await tx.scheduleActivity.create({
          data: {
            schoolId,
            academicYearId: effective.academicYearId,
            batchId: batch.id,
            replacementSubjectId: checked.replacementSubjectId,
            description: checked.description,
            scopeGroupIds: checked.named.groupIds,
            createdByUserId: user.userId ?? null,
            teachers: {
              // The school comes from the parent through the composite key.
              create: checked.teachers.map((teacher) => ({ ...teacher })),
            },
          },
          select: { id: true },
        });
        const credits = await writeCredits(tx, schoolId, batch.id, effective, checked.named, take, today, checked.credits);
        const synced = await syncReplacementsInTransaction(tx, schoolId, batch.id);
        await tx.cancellationBatch.update({ where: { id: batch.id }, data: { cancelled: take.length } });
        if (checked.notify) {
          const audience = await this.audienceOf(tx, take, checked, evaluation.plan, evaluation.ownerNames);
          await sendDigest(
            this.notifications,
            tx,
            schoolId,
            { id: batch.id, name: effective.name },
            audience.audience,
            false,
            { responsible: audience.responsible },
          );
        }
        return { id: activity.id, take, synced, credits, range: { from: effective.fromDate, to: effective.toDate } };
      },
      { timeoutMs: 120_000 },
    );
    await this.broadcast(user, [...done.take.map((lesson) => lesson.id), ...done.synced.created]);
    this.boardChanged(schoolId, done.range.from, done.range.to);
    this.logger.log(
      `Schedule activity created [activity=${done.id}, cancelled=${done.take.length}, replacements=${done.synced.created.length}, credits=${done.credits}]`,
    );
    const view = await this.prisma.withRls(user, async (tx) => this.viewById(tx, done.id));
    return {
      activity: view,
      cancelled: done.take.length,
      replacementLessons: done.synced.created.length,
      credits: done.credits,
    };
  }

  async list(academicYearId: string, user: AuthenticatedUser): Promise<ScheduleActivityView[]> {
    requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const rows = await tx.scheduleActivity.findMany({
        where: { academicYearId },
        orderBy: [{ batch: { fromDate: 'desc' } }, { createdAt: 'desc' }],
        select: ACTIVITY_SELECT,
      });
      return this.views(tx, rows);
    });
  }

  /** What a change would do: the plan as the new description reads it, and what it puts back and takes. */
  async updatePreview(id: string, dto: ScheduleActivitySelectionDto, user: AuthenticatedUser): Promise<ActivityPreview> {
    requireSchoolId(user);
    const checked = check(dto, true);
    return this.prisma.withRls(user, async (tx) => {
      const activity = await this.requireActivity(tx, id);
      return (await this.evaluate(tx, checked, activity)).preview;
    });
  }

  async update(
    id: string,
    dto: CreateScheduleActivityDto,
    user: AuthenticatedUser,
  ): Promise<{ activity: ScheduleActivityView; released: number; taken: number }> {
    const schoolId = requireSchoolId(user);
    const done = await this.prisma.withRls(
      user,
      async (tx) => {
        await enterGrundschemaWrite(tx, schoolId);
        const activity = await this.requireActivity(tx, id);
        const checked = check(dto, dto.notify ?? activity.batch.notifies);
        const evaluation = await this.evaluate(tx, checked, activity);
        if (dto.expectedDigest && dto.expectedDigest !== evaluation.preview.digest) throw stale();
        const { effective, take, drop, today, timezone } = evaluation;
        const batchId = activity.batchId;
        const row = activity.batch;

        // 1. Put back what the new description no longer takes.
        let reinstated: Array<{ id: string }> = [];
        if (drop.length > 0) {
          const plan = await reversePlan(tx, schoolId, row, timezone, { only: new Set(drop.map((lesson) => lesson.id)) });
          await applyReinstatement(tx, 'EVENT', plan);
          const gone = [...plan.reinstate.map((lesson) => lesson.id), ...plan.templateMoved.map((entry) => entry.lessonId)];
          if (gone.length > 0) {
            await tx.cancellationBatchLesson.deleteMany({ where: { batchId, calendarLessonId: { in: gone } } });
          }
          reinstated = plan.reinstate;
        }

        // 2. The avbokning itself: name, days, window, scope.
        const renamed = row.name !== effective.name;
        if (renamed) {
          await tx.calendarLesson.updateMany({
            where: {
              batchLessons: { some: { batchId } },
              status: 'CANCELLED',
              cancelCause: 'EVENT',
              note: cancelledNoteOf(row.name),
            },
            data: { note: cancelledNoteOf(effective.name) },
          });
        }
        await tx.cancellationBatch.update({
          where: { id: batchId },
          data: {
            name: effective.name,
            fromDate: day(effective.fromDate),
            toDate: day(effective.toDate),
            startTime: effective.startTime ? time(effective.startTime) : null,
            endTime: effective.endTime ? time(effective.endTime) : null,
            scope: effective.scope,
            minGradeLevel: effective.minGradeLevel,
            maxGradeLevel: effective.maxGradeLevel,
            groupIds: effective.groupIds,
            notifies: checked.notify,
          },
        });

        // 3. Take what it newly takes.
        if (take.length > 0) await cancelInto(tx, schoolId, batchId, effective, take);

        // 4. The activity's own: subject, text, classes, teachers.
        await tx.scheduleActivity.update({
          where: { id },
          data: {
            replacementSubjectId: checked.replacementSubjectId,
            description: checked.description,
            scopeGroupIds: checked.named.groupIds,
            updatedAt: new Date(),
          },
        });
        await tx.scheduleActivityTeacher.deleteMany({ where: { activityId: id } });
        if (checked.teachers.length > 0) {
          await tx.scheduleActivityTeacher.createMany({
            data: checked.teachers.map((teacher) => ({ ...teacher, activityId: id, schoolId })),
          });
        }

        // 5. Credits dated today or later are the school's decision again.
        const future = await futureCreditIds(tx, batchId, today, false);
        if (future.length > 0) await tx.timplanCredit.deleteMany({ where: { id: { in: future } } });
        const held = [...evaluation.keep, ...take];
        const credits = await writeCredits(tx, schoolId, batchId, effective, checked.named, held, today, checked.credits);

        // 6. The replacement lessons follow.
        const synced = await syncReplacementsInTransaction(tx, schoolId, batchId);
        const cancelled = await tx.cancellationBatchLesson.count({
          where: { batchId, calendarLesson: { is: { status: 'CANCELLED', cancelCause: 'EVENT' } } },
        });
        await tx.cancellationBatch.update({ where: { id: batchId }, data: { cancelled } });

        // 7. The people whose day moved hear of exactly that: what is newly
        // cancelled, and what comes back.
        if (checked.notify) {
          if (take.length > 0) {
            const audience = await this.audienceOf(tx, take, checked, evaluation.plan, evaluation.ownerNames);
            await sendDigest(this.notifications, tx, schoolId, { id: batchId, name: effective.name }, audience.audience, false, {
              responsible: audience.responsible,
            });
          }
          if (reinstated.length > 0) {
            await sendDigest(
              this.notifications,
              tx,
              schoolId,
              { id: batchId, name: effective.name },
              await digestAudience(tx, await digestLessonsOf(tx, reinstated)),
              true,
              { responsible: new Map() },
            );
          }
        }
        return {
          take,
          reinstated,
          synced,
          credits,
          range: {
            from: [row.fromDate, day(effective.fromDate)].map(asDay).sort()[0],
            to: [row.toDate, day(effective.toDate)].map(asDay).sort().reverse()[0],
          },
        };
      },
      { timeoutMs: 120_000 },
    );
    await this.broadcast(user, [
      ...done.take.map((lesson) => lesson.id),
      ...done.reinstated.map((lesson) => lesson.id),
      ...done.synced.created,
      ...done.synced.updated,
    ]);
    this.boardChanged(schoolId, done.range.from, done.range.to);
    const view = await this.prisma.withRls(user, async (tx) => this.viewById(tx, id));
    return { activity: view, released: done.reinstated.length, taken: done.take.length };
  }

  async removePreview(id: string, user: AuthenticatedUser): Promise<RemovePreview> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const activity = await this.requireActivity(tx, id);
      const plan = await this.removalPlan(tx, schoolId, activity);
      const audience = activity.batch.notifies
        ? await digestAudience(tx, await digestLessonsOf(tx, plan.reversal.reinstate))
        : null;
      return {
        reinstate: plan.reversal.reinstate.length,
        notify: audience?.people.size ?? 0,
        replacementsDeleted: plan.deletable.length,
        replacementsKept: plan.keptReplacements,
        creditsDeleted: plan.creditIds.length,
        skippedRoomTaken: plan.reversal.skipped,
        removedTemplateMoved: plan.reversal.templateMoved,
        notReinstatable: plan.reversal.notReinstatable,
      };
    });
  }

  /**
   * Takes the activity away: the lessons it cancelled that are ahead come back
   * (as a reversal of an avbokning puts them back), its replacement lessons
   * ahead and without attendance are deleted, and the credits dated today or
   * later go. A replacement lesson that has begun or carries a register is the
   * record of a day that was held: it stays, and so do the lessons it
   * replaced, because putting them back beside it would give the class two
   * lessons that day. Once.
   */
  async remove(id: string, user: AuthenticatedUser): Promise<RemovePreview> {
    const schoolId = requireSchoolId(user);
    const done = await this.prisma.withRls(
      user,
      async (tx) => {
        await enterGrundschemaWrite(tx, schoolId);
        const activity = await this.requireActivity(tx, id);
        const plan = await this.removalPlan(tx, schoolId, activity);
        await applyReinstatement(tx, 'EVENT', plan.reversal);
        if (plan.deletable.length > 0) {
          await tx.calendarLesson.deleteMany({ where: { id: { in: plan.deletable } } });
        }
        if (plan.creditIds.length > 0) await tx.timplanCredit.deleteMany({ where: { id: { in: plan.creditIds } } });
        const now = new Date();
        await tx.cancellationBatch.update({
          where: { id: activity.batchId },
          data: {
            reversedAt: now,
            reversedByUserId: user.userId ?? null,
            reinstated: plan.reversal.reinstate.length,
            skippedRoomTaken: plan.reversal.skipped.length,
          },
        });
        await tx.scheduleActivity.update({
          where: { id },
          data: { removedAt: now, removedByUserId: user.userId ?? null, updatedAt: now },
        });
        const told = activity.batch.notifies
          ? await sendDigest(
              this.notifications,
              tx,
              schoolId,
              { id: activity.batchId, name: activity.batch.name },
              await digestAudience(tx, await digestLessonsOf(tx, plan.reversal.reinstate)),
              true,
              { responsible: new Map() },
            )
          : 0;
        return {
          ids: [...plan.reversal.reinstate.map((lesson) => lesson.id)],
          range: { from: asDay(activity.batch.fromDate), to: asDay(activity.batch.toDate) },
          result: {
            reinstate: plan.reversal.reinstate.length,
            notify: told,
            replacementsDeleted: plan.deletable.length,
            replacementsKept: plan.keptReplacements,
            creditsDeleted: plan.creditIds.length,
            skippedRoomTaken: plan.reversal.skipped,
            removedTemplateMoved: plan.reversal.templateMoved,
            notReinstatable: plan.reversal.notReinstatable,
          } satisfies RemovePreview,
        };
      },
      { timeoutMs: 120_000 },
    );
    await this.broadcast(user, done.ids);
    this.boardChanged(schoolId, done.range.from, done.range.to);
    this.logger.log(`Schedule activity removed [activity=${id}, reinstated=${done.result.reinstate}, kept=${done.result.replacementsKept}]`);
    return done.result;
  }

  // ---------------------------------------------------------------------

  /** What removing would do: the lessons to put back, and the replacement lessons that go. */
  private async removalPlan(tx: PrismaClient, schoolId: string, activity: ActivityRow) {
    const now = new Date();
    const links = await tx.scheduleActivityLesson.findMany({
      where: { activityId: activity.id },
      select: {
        studentGroupId: true,
        date: true,
        calendarLesson: {
          select: { id: true, startsAt: true, _count: { select: { attendanceRecords: true } } },
        },
      },
    });
    const history = (row: (typeof links)[number]) =>
      row.calendarLesson.startsAt <= now || row.calendarLesson._count.attendanceRecords > 0;
    const deletable = links.filter((row) => !history(row)).map((row) => row.calendarLesson.id);
    const keptKeys = new Set(links.filter(history).map((row) => `${row.studentGroupId}|${asDay(row.date)}`));

    // The lessons a kept replacement stands for stay cancelled with it.
    const groups = await loadGroupFacts(tx, activity.academicYearId);
    const rule: ScopeRule = scopeRuleOf(activity);
    const stay = new Set<string>();
    if (keptKeys.size > 0) {
      const owned = await ownedLessons(tx, activity.batchId);
      const { planOwners } = await ownersWithPupils(tx, rule, groups, activity.replacementSubjectId);
      const { plan } = await planOf(tx, owned, planOwners);
      for (const entry of plan) {
        if (keptKeys.has(`${entry.groupId}|${entry.date}`)) for (const lessonId of entry.lessonIds) stay.add(lessonId);
      }
    }
    const linked = await tx.cancellationBatchLesson.findMany({ where: { batchId: activity.batchId }, select: { calendarLessonId: true } });
    const only = new Set(linked.map((row) => row.calendarLessonId).filter((lessonId) => !stay.has(lessonId)));
    const { timezone, today } = await yearOf(tx, activity.academicYearId, null);
    const reversal = await reversePlan(tx, schoolId, activity.batch, timezone, { only });
    const creditIds = await futureCreditIds(tx, activity.batchId, today, true);
    return { reversal, deletable, keptReplacements: links.length - deletable.length, creditIds };
  }

  /**
   * Everything a request means, read in the caller's transaction: the plan, the
   * lessons it takes and (on a change) holds and puts back, and what the
   * administrator should read before saying yes.
   */
  private async evaluate(tx: PrismaClient, checked: Checked, activity: ActivityRow | null): Promise<Evaluation> {
    const named = checked.named;
    // An activity belongs to its läsår for good: its lessons, credits and teachers are that year's.
    if (activity && activity.academicYearId !== named.academicYearId) {
      throw new BadRequestException({
        message: 'academicYearId: en aktivitet byter inte läsår. Ta bort den och gör en ny.',
        code: CANCELLATION_SCOPE,
      });
    }
    const { timezone, today } = await yearOf(tx, named.academicYearId, named);
    const now = new Date();

    const subject = await tx.subject.findUnique({
      where: { id: checked.replacementSubjectId },
      select: { id: true, name: true, countsTowardTimplan: true },
    });
    if (!subject) {
      throw new BadRequestException({ message: 'replacementSubjectId: ämnet finns inte.', code: ACTIVITY_SUBJECT });
    }
    if (subject.countsTowardTimplan) {
      throw new BadRequestException({
        message: `replacementSubjectId: ${subject.name} räknas mot timplanen, så dagens minuter skulle räknas två gånger (lektionen och krediten). Välj ett ämne som inte räknas, till exempel "Temadag", och lägg minuterna som krediter.`,
        code: ACTIVITY_SUBJECT_COUNTS,
      });
    }
    if (checked.credits.length > 0) {
      const found = await tx.subject.findMany({
        where: { id: { in: checked.credits.map((credit) => credit.subjectId) } },
        select: { id: true, name: true, countsTowardTimplan: true },
      });
      const byId = new Map(found.map((row) => [row.id, row]));
      for (const credit of checked.credits) {
        const row = byId.get(credit.subjectId);
        if (!row || !row.countsTowardTimplan) {
          throw new BadRequestException({
            message: row
              ? `credits: ${row.name} räknas inte mot timplanen, så en kredit på det når ingen elev.`
              : 'credits: ämnet finns inte.',
            code: ACTIVITY_CREDIT_SUBJECT,
          });
        }
      }
    }

    // The groups: which the cancellation takes, which get a replacement lesson.
    const groups = await loadGroupFacts(tx, named.academicYearId);
    let effective = named;
    const expandedGroups: Array<{ id: string; name: string }> = [];
    if (named.scope === 'GROUPS') {
      const candidates = groups.filter((group) => group.kind === 'TEACHING_GROUP' && group.halfOfId === null);
      const homes = await memberHomes(tx, candidates.map((group) => group.id));
      const expanded = expandNamedGroups(named.groupIds, groups, homes);
      if (expanded.length > 200) {
        throw new BadRequestException({
          message: 'Urvalet med halvklasser och grupper blir fler än 200: välj årskurser eller hela skolan i stället.',
          code: ACTIVITY_SCOPE_TOO_WIDE,
        });
      }
      effective = { ...named, groupIds: expanded };
      const nameOf = new Map(groups.map((group) => [group.id, group.name]));
      for (const id of expanded) if (!named.groupIds.includes(id)) expandedGroups.push({ id, name: nameOf.get(id) ?? id });
      expandedGroups.sort((a, b) => a.name.localeCompare(b.name, 'sv'));
    }

    const rule = ruleOf(effective, timezone, now);
    const batchId = activity?.batchId ?? null;

    // The lessons: those the avbokning already holds (a change), and those the selection takes now.
    const lessonRows = await tx.calendarLesson.findMany({
      where: {
        studentGroup: { is: { academicYearId: named.academicYearId } },
        // The replacement lessons are the activity's own; they are never what it cancels.
        activityLinks: { none: {} },
        OR: [
          { date: { gte: day(effective.fromDate), lte: day(effective.toDate) } },
          ...(batchId ? [{ batchLessons: { some: { batchId } } }] : []),
        ],
      },
      select: { ...CANDIDATE_SELECT, batchLessons: batchId ? { where: { batchId }, select: { batchId: true } } : false },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    });
    const heldRows = batchId ? lessonRows.filter((row) => (row.batchLessons?.length ?? 0) > 0) : [];
    const heldCandidates = heldRows
      .filter((row) => row.status === 'CANCELLED')
      .map((row) => toCandidate(row as Parameters<typeof toCandidate>[0]));
    const geometric = (candidate: SelectionCandidate) =>
      candidate.date >= effective.fromDate &&
      candidate.date <= effective.toDate &&
      inWindow(candidate, rule) &&
      inScope(candidate, rule) === true;
    const keep = heldCandidates.filter(geometric);
    const drop = heldCandidates.filter((candidate) => !geometric(candidate));
    const heldIds = new Set(heldRows.map((row) => row.id));
    const free = lessonRows.filter((row) => !heldIds.has(row.id)).map((row) => toCandidate(row as Parameters<typeof toCandidate>[0]));
    const outcome = selectLessons(
      free.filter((candidate) => candidate.date >= effective.fromDate && candidate.date <= effective.toDate),
      rule,
    );
    const take = outcome.matched;

    // The plan: a replacement lesson per owner and day for every lesson the activity holds after the change.
    const { owners, planOwners } = await ownersWithPupils(tx, scopeRuleOfChecked(named), groups, checked.replacementSubjectId);
    const ownerNames = new Map(owners.map((owner) => [owner.id, owner.name]));
    const replaced: ReplacedLesson[] = [...keep, ...take].map(replacedOf);
    const { plan, uncovered } = replaced.length === 0 ? { plan: [], uncovered: 0 } : await planOf(tx, replaced, planOwners);

    // Teachers: only for owners, only for teachers.
    const people = await tx.user.findMany({
      where: { id: { in: checked.teachers.map((teacher) => teacher.teacherId) }, role: 'TEACHER', isActive: true },
      select: { id: true },
    });
    const knownTeachers = new Set(people.map((person) => person.id));
    for (const teacher of checked.teachers) {
      if (!ownerNames.has(teacher.studentGroupId)) {
        throw new BadRequestException({
          message: 'teachers: en ansvarig lärare anges för en klass eller grupp som aktiviteten gäller.',
          code: ACTIVITY_TEACHER,
        });
      }
      if (!knownTeachers.has(teacher.teacherId)) {
        throw new BadRequestException({
          message: 'teachers: läraren finns inte eller är inte en aktiv lärare i skolan.',
          code: ACTIVITY_TEACHER,
        });
      }
    }

    // What the administrator should read.
    const days = new Map<string, PlannedReplacement[]>();
    for (const entry of plan) days.set(entry.groupId, [...(days.get(entry.groupId) ?? []), entry]);
    const classes: ActivityClassView[] = owners
      .filter((owner) => days.has(owner.id))
      .map((owner) => {
        const mine = days.get(owner.id)!;
        return {
          groupId: owner.id,
          name: owner.name,
          teachers: checked.teachers
            .filter((teacher) => teacher.studentGroupId === owner.id)
            .map((teacher) => ({ teacherId: teacher.teacherId, role: teacher.role })),
          days: mine.length,
          firstDate: mine[0].date,
          lastDate: mine[mine.length - 1].date,
        };
      });
    const classesWithoutTeacher = classes.filter((entry) => entry.teachers.length === 0).map((entry) => entry.name);

    const continuing = await this.continuing(tx, effective, new Set([...keep, ...take].map((lesson) => lesson.id)), planOwners, now);
    const busy = await this.busyLessons(tx, checked, effective, new Set([...keep, ...take].map((lesson) => lesson.id)), activity?.id ?? null);
    const clashes = teacherClashes(plan, checked.teachers, busy).map((clash) => ({
      teacherId: clash.teacherId,
      date: clash.date,
      groupName: ownerNames.get(clash.groupId) ?? clash.groupId,
      busyWith: clash.busyWith,
    }));

    const creditDates = creditDatesOf(effective, [...keep, ...take], today);
    if (checked.credits.length > 0 && (effective.startTime !== null || creditDates.length === 0)) {
      throw new BadRequestException({
        message:
          'En tillgodoräknad dag gäller hela dagar efter i dag: ta bort tidsfönstret, eller lägg tiden som en egen tillgodoräkning.',
        code: CANCELLATION_CREDIT,
      });
    }

    const taken = [...keep, ...take];
    const reached = await this.audienceOf(tx, take, checked, plan, ownerNames);
    const digest = createHash('sha256')
      .update(
        JSON.stringify([
          selectionDigest(effective, take),
          taken.map((lesson) => lesson.id).sort(),
          plan.map((entry) => [entry.groupId, entry.date, entry.startsAt.toISOString(), entry.endsAt.toISOString()]),
          checked.teachers.map((teacher) => [teacher.studentGroupId, teacher.teacherId, teacher.role]).sort(),
          checked.credits.map((credit) => [credit.subjectId, credit.minutes]).sort(),
          checked.replacementSubjectId,
          checked.description,
          drop.map((lesson) => lesson.id).sort(),
        ]),
      )
      .digest('hex');

    const preview: ActivityPreview = {
      matched: taken.length,
      lessons: taken.slice(0, 50).map(viewOfCandidate),
      excluded: outcome.excluded,
      ungradedGroups: outcome.ungradedGroups,
      expandedGroups,
      classes,
      replacementLessons: plan.length,
      warnings: { classesWithoutTeacher, continuing, uncoveredPupils: uncovered, teacherClashes: clashes.slice(0, 20) },
      creditDates,
      digest,
      audience: reached.audience.counts,
      ...(activity
        ? {
            change: {
              released: drop.filter((lesson) => lesson.startsAt > now && lesson.attendance === 0).length,
              taken: take.length,
            },
          }
        : {}),
    };
    return { preview, checked, effective, timezone, today, groups, take, keep, drop, plan, ownerNames };
  }

  /** Lessons that go on for pupils of the activity's classes (a group with pupils from other classes too). */
  private async continuing(
    tx: PrismaClient,
    selection: StoredSelection,
    taken: ReadonlySet<string>,
    owners: ReadonlyArray<{ groupId: string; pupils: ReadonlySet<string> }>,
    now: Date,
  ): Promise<Array<{ name: string; lessons: number }>> {
    if (selection.scope === 'SCHOOL') return [];
    const pupils = new Set<string>();
    for (const owner of owners) for (const pupil of owner.pupils) pupils.add(pupil);
    if (pupils.size === 0) return [];
    const rows = await tx.calendarLesson.findMany({
      where: {
        status: 'SCHEDULED',
        startsAt: { gt: now },
        date: { gte: day(selection.fromDate), lte: day(selection.toDate) },
        id: { notIn: [...taken] },
        activityLinks: { none: {} },
        studentGroup: { is: { academicYearId: selection.academicYearId } },
      },
      select: {
        id: true,
        subjectId: true,
        studentGroupId: true,
        studentGroup: { select: { name: true } },
        extraGroups: { select: { studentGroupId: true } },
      },
    });
    if (rows.length === 0) return [];
    const rosters = await calendarLessonRosters(tx, rows, { pupils: 'ACTIVE' });
    const counts = new Map<string, number>();
    for (const row of rows) {
      const roster = rosters.get(row.id);
      if (!roster) continue;
      for (const pupil of roster) {
        if (pupils.has(pupil)) {
          counts.set(row.studentGroup.name, (counts.get(row.studentGroup.name) ?? 0) + 1);
          break;
        }
      }
    }
    return [...counts.entries()]
      .map(([name, lessons]) => ({ name, lessons }))
      .sort((a, b) => b.lessons - a.lessons || a.name.localeCompare(b.name, 'sv'))
      .slice(0, 10);
  }

  /** The named teachers' other lessons in the activity's days, that the activity does not take. */
  private async busyLessons(
    tx: PrismaClient,
    checked: Checked,
    selection: StoredSelection,
    taken: ReadonlySet<string>,
    activityId: string | null,
  ) {
    const teacherIds = [...new Set(checked.teachers.map((teacher) => teacher.teacherId))];
    if (teacherIds.length === 0) return [];
    const rows = await tx.calendarLessonTeacher.findMany({
      where: {
        teacherId: { in: teacherIds },
        calendarLesson: {
          is: {
            status: 'SCHEDULED',
            date: { gte: day(selection.fromDate), lte: day(selection.toDate) },
            id: { notIn: [...taken] },
            ...(activityId ? { activityLinks: { none: { activityId } } } : {}),
          },
        },
      },
      select: {
        teacherId: true,
        calendarLesson: { select: { date: true, startsAt: true, endsAt: true, studentGroup: { select: { name: true } } } },
      },
    });
    return rows.map((row) => ({
      teacherId: row.teacherId,
      date: asDay(row.calendarLesson.date),
      startsAt: row.calendarLesson.startsAt,
      endsAt: row.calendarLesson.endsAt,
      groupName: row.calendarLesson.studentGroup.name,
    }));
  }

  /** The digest's audience, with the responsible teachers who teach nothing that was cancelled added. */
  private async audienceOf(
    tx: PrismaClient,
    lessons: readonly SelectionCandidate[],
    checked: Checked,
    plan: readonly PlannedReplacement[],
    ownerNames: ReadonlyMap<string, string>,
  ) {
    const audience = await digestAudience(tx, lessons.map(digestLessonOf));
    const responsible = responsibleOf(checked, ownerNames);
    const byGroup = new Map<string, PlannedReplacement[]>();
    for (const entry of plan) byGroup.set(entry.groupId, [...(byGroup.get(entry.groupId) ?? []), entry]);
    const dayOf = new Map(lessons.map((lesson) => [lesson.id, lesson.date]));
    for (const teacher of checked.teachers) {
      const share = audience.people.get(teacher.teacherId);
      if (share) continue;
      const mine = (byGroup.get(teacher.studentGroupId) ?? []).flatMap((entry) => entry.lessonIds).filter((id) => dayOf.has(id));
      if (mine.length === 0) continue;
      const dates = mine.map((id) => dayOf.get(id)!).sort();
      audience.people.set(teacher.teacherId, { lessons: new Set(mine), first: dates[0], last: dates[dates.length - 1] });
      audience.counts.teachers++;
    }
    return { audience: audience as DigestAudience, responsible };
  }

  private async requireActivity(tx: PrismaClient, id: string): Promise<ActivityRow> {
    const row = await tx.scheduleActivity.findUnique({ where: { id }, select: ACTIVITY_SELECT });
    if (!row) throw new NotFoundException('Aktiviteten finns inte.');
    if (row.removedAt !== null) {
      throw new ConflictException({ message: 'Aktiviteten är redan borttagen.', code: ACTIVITY_REMOVED });
    }
    if (row.batch.reversedAt !== null) {
      throw new ConflictException({ message: 'Aktivitetens avbokning är redan återställd.', code: CANCELLATION_REVERSED });
    }
    return row as ActivityRow;
  }

  private async viewById(tx: PrismaClient, id: string): Promise<ScheduleActivityView> {
    const row = await tx.scheduleActivity.findUniqueOrThrow({ where: { id }, select: ACTIVITY_SELECT });
    return (await this.views(tx, [row]))[0];
  }

  private async views(tx: PrismaClient, rows: ReadonlyArray<ActivityRow>): Promise<ScheduleActivityView[]> {
    if (rows.length === 0) return [];
    const subjects = new Map(
      (
        await tx.subject.findMany({
          where: { id: { in: [...new Set(rows.map((row) => row.replacementSubjectId))] } },
          select: { id: true, name: true, countsTowardTimplan: true },
        })
      ).map((subject) => [subject.id, subject]),
    );
    const credits = await tx.cancellationBatchCredit.groupBy({
      by: ['batchId'],
      where: { batchId: { in: rows.map((row) => row.batchId) } },
      _count: { _all: true },
    });
    const creditCount = new Map(credits.map((entry) => [entry.batchId, entry._count._all]));
    return rows.map((row) => {
      const subject = subjects.get(row.replacementSubjectId) ?? null;
      return {
        id: row.id,
        batchId: row.batchId,
        name: row.batch.name,
        description: row.description,
        fromDate: asDay(row.batch.fromDate),
        toDate: asDay(row.batch.toDate),
        startTime: clock(row.batch.startTime),
        endTime: clock(row.batch.endTime),
        scope: row.batch.scope,
        minGradeLevel: row.batch.minGradeLevel,
        maxGradeLevel: row.batch.maxGradeLevel,
        scopeGroupIds: row.scopeGroupIds,
        replacementSubject: subject,
        cancelled: row.batch.cancelled,
        replacementLessons: row._count.lessons,
        credits: creditCount.get(row.batchId) ?? 0,
        teachers: row.teachers.map((teacher) => ({
          studentGroupId: teacher.studentGroupId,
          teacherId: teacher.teacherId,
          role: teacher.role as 'LEAD' | 'ASSISTANT',
        })),
        notifies: row.batch.notifies,
        createdAt: row.createdAt.toISOString(),
        createdByUserId: row.createdByUserId,
        removedAt: row.removedAt ? row.removedAt.toISOString() : null,
        reinstated: row.batch.reinstated,
        doubleCounts: subject?.countsTowardTimplan === true,
      };
    });
  }

  private boardChanged(schoolId: string, from: string, to: string): void {
    try {
      this.realtime.notifyCoverBoardChanged(schoolId, from, to);
    } catch {
      this.logger.debug(`Cover board broadcast failed [school=${schoolId}]`);
    }
  }

  private async broadcast(user: AuthenticatedUser, ids: readonly string[]): Promise<void> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return;
    await this.prisma.withRls(user, (tx) => this.realtime.notifyLessonsChanged(tx, unique)).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------

type ActivityRow = {
  id: string;
  schoolId: string;
  academicYearId: string;
  batchId: string;
  replacementSubjectId: string;
  description: string | null;
  scopeGroupIds: string[];
  createdAt: Date;
  createdByUserId: string | null;
  removedAt: Date | null;
  teachers: Array<{ studentGroupId: string; teacherId: string; role: string }>;
  batch: BatchRow;
  _count: { lessons: number };
};

/** The request, checked: the avbokning's rules, and the activity's. */
function check(dto: ScheduleActivitySelectionDto & { notify?: boolean }, notify: boolean): Checked {
  const named = checkSelection({ ...dto, cause: 'EVENT' });
  const perGroup = new Map<string, number>();
  const seen = new Set<string>();
  const teachers: Checked['teachers'] = [];
  for (const entry of dto.teachers ?? []) {
    const key = `${entry.studentGroupId}|${entry.teacherId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const count = perGroup.get(entry.studentGroupId) ?? 0;
    if (count >= 8) {
      throw new BadRequestException({ message: 'teachers: högst åtta ansvariga lärare per klass.', code: ACTIVITY_TEACHER });
    }
    perGroup.set(entry.studentGroupId, count + 1);
    teachers.push({ studentGroupId: entry.studentGroupId, teacherId: entry.teacherId, role: entry.role ?? 'ASSISTANT' });
  }
  // The first named teacher of a group leads it unless the request says who does.
  const leads = new Map<string, number>();
  for (const teacher of teachers) if (teacher.role === 'LEAD') leads.set(teacher.studentGroupId, (leads.get(teacher.studentGroupId) ?? 0) + 1);
  for (const n of leads.values()) {
    if (n > 1) {
      throw new BadRequestException({ message: 'teachers: en klass har högst en ledande lärare.', code: ACTIVITY_TEACHER });
    }
  }
  const promoted = new Set<string>();
  for (const teacher of teachers) {
    if (!leads.has(teacher.studentGroupId) && !promoted.has(teacher.studentGroupId)) {
      teacher.role = 'LEAD';
      promoted.add(teacher.studentGroupId);
    }
  }
  const creditSubjects = new Set<string>();
  for (const credit of dto.credits ?? []) {
    if (creditSubjects.has(credit.subjectId)) {
      throw new BadRequestException({ message: 'credits: ett ämne anges en gång.', code: ACTIVITY_CREDIT_SUBJECT });
    }
    creditSubjects.add(credit.subjectId);
  }
  return {
    named,
    replacementSubjectId: dto.replacementSubjectId,
    description: dto.description && dto.description.length > 0 ? dto.description : null,
    teachers,
    credits: (dto.credits ?? []).map((credit) => ({ subjectId: credit.subjectId, minutes: credit.minutes })),
    notify,
  };
}

const scopeRuleOfChecked = (named: StoredSelection): ScopeRule => ({
  scope: named.scope,
  minGradeLevel: named.minGradeLevel,
  maxGradeLevel: named.maxGradeLevel,
  groupIds: named.groupIds,
});

const scopeRuleOf = (activity: ActivityRow): ScopeRule => ({
  scope: activity.batch.scope as ScopeRule['scope'],
  minGradeLevel: activity.batch.minGradeLevel,
  maxGradeLevel: activity.batch.maxGradeLevel,
  groupIds: activity.scopeGroupIds,
});

const replacedOf = (candidate: SelectionCandidate): ReplacedLesson => ({
  id: candidate.id,
  date: day(candidate.date),
  startsAt: candidate.startsAt,
  endsAt: candidate.endsAt,
  subjectId: candidate.subjectId,
  studentGroupId: candidate.studentGroupId,
  extraGroups: candidate.extraGroups,
});

const viewOfCandidate = (lesson: SelectionCandidate): BatchLessonView => ({
  id: lesson.id,
  date: lesson.date,
  startsAt: lesson.startsAt.toISOString(),
  endsAt: lesson.endsAt.toISOString(),
  subjectName: lesson.subjectName,
  groupName: lesson.groupName,
});

/** Each responsible teacher's classes, by name, for the digest's e-mail. */
function responsibleOf(checked: Checked, ownerNames: ReadonlyMap<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const teacher of checked.teachers) {
    const name = ownerNames.get(teacher.studentGroupId);
    if (!name) continue;
    out.set(teacher.teacherId, [...(out.get(teacher.teacherId) ?? []), name].sort((a, b) => a.localeCompare(b, 'sv')));
  }
  return out;
}

/** The cancelled lessons an avbokning holds, in force. */
async function ownedLessons(tx: PrismaClient, batchId: string): Promise<ReplacedLesson[]> {
  return tx.calendarLesson.findMany({
    where: { batchLessons: { some: { batchId } }, status: 'CANCELLED', cancelCause: 'EVENT' },
    select: {
      id: true,
      date: true,
      startsAt: true,
      endsAt: true,
      subjectId: true,
      studentGroupId: true,
      extraGroups: { select: { studentGroupId: true } },
    },
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
  });
}

/**
 * The credits of an avbokning a change or a removal takes. A removal takes
 * those dated today or later, as a reversal does; a change only those after
 * today, because a credit is never written for a day under way (creditDatesOf)
 * and today's would not be written again.
 */
async function futureCreditIds(tx: PrismaClient, batchId: string, today: string, inclusive: boolean): Promise<string[]> {
  const rows = await tx.cancellationBatchCredit.findMany({
    where: { batchId, credit: { is: { date: inclusive ? { gte: day(today) } : { gt: day(today) } } } },
    select: { creditId: true },
  });
  return rows.map((row) => row.creditId);
}

/** One credit per day, subject and target (the school, the span or each group), linked to the avbokning. */
async function writeCredits(
  tx: PrismaClient,
  schoolId: string,
  batchId: string,
  selection: StoredSelection,
  named: StoredSelection,
  held: readonly SelectionCandidate[],
  today: string,
  lines: ReadonlyArray<{ subjectId: string; minutes: number }>,
): Promise<number> {
  if (lines.length === 0) return 0;
  const dates = creditDatesOf(selection, held, today);
  // The credit reaches the classes the administrator named: a half or a group
  // the cancellation took with them is inside a class credit already (the
  // 7AB-tjej rule), and its own credit would count the same pupils twice.
  const targets = creditTargetsOf(named);
  let count = 0;
  for (const date of dates) {
    for (const line of lines) {
      for (const target of targets) {
        const credit = await createCreditInTransaction(
          tx,
          schoolId,
          { academicYearId: selection.academicYearId, date, minutes: line.minutes, subjectId: line.subjectId, name: selection.name, ...target },
          checkScope(target),
        );
        await tx.cancellationBatchCredit.create({ data: { batchId, creditId: credit.id, schoolId } });
        count++;
      }
    }
  }
  return count;
}

export type { SyncResult };
