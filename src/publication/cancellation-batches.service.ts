import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { RealtimeService } from '../realtime/realtime.service';
import { NotificationsService } from '../notifications/notifications.service';
import { checkScope, createCreditInTransaction } from '../timplan/timplan-credits.service';
import { enterGrundschemaWrite } from './publish-mode';
import {
  selectLessons,
  selectionDigest,
  type SelectionCandidate,
} from './cancellation-selection';
import type { CancellationSelectionDto, CreateCancellationBatchDto } from './dto/cancellation-batch.dto';
import { digestAudience, sendDigest } from './cancellation-digest';
import {
  BATCH_SELECT,
  CANCELLATION_CREDIT,
  CANCELLATION_RANGE,
  CANCELLATION_REVERSED,
  CANCELLATION_SCOPE,
  CANCELLATION_STALE,
  CANDIDATE_SELECT,
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
  pendingLessons,
  reversePlan,
  reversed,
  ruleOf,
  stale,
  storedSelection,
  time,
  toCandidate,
  yearOf,
  type BatchRow,
  type StoredSelection,
} from './cancellation-core';
import { syncReplacementsInTransaction, type SyncResult } from './activity-replacements';

export { CANCELLATION_CREDIT, CANCELLATION_RANGE, CANCELLATION_REVERSED, CANCELLATION_SCOPE, CANCELLATION_STALE };

/** One lesson as the preview lists it: never a pupil. */
export interface BatchLessonView {
  id: string;
  date: string;
  startsAt: string;
  endsAt: string;
  subjectName: string;
  groupName: string;
}

export interface CancellationPreview {
  matched: number;
  /** The first 50, in time order. */
  lessons: BatchLessonView[];
  excluded: { started: number; notScheduled: number; attendance: number };
  /** GRADES: groups with no year of their own; their lessons are left, and named. */
  ungradedGroups: string[];
  /** Dates a credit would be written for (whole-day batches ahead of today only). */
  creditDates: string[];
  digest: string;
  /** Who the optional digest would reach (cancellation-digest.ts): the preview's tickbox says it. */
  audience: { pupils: number; guardians: number; teachers: number };
}

export interface CancellationBatchView {
  id: string;
  name: string;
  cause: 'EVENT' | 'MANUAL';
  fromDate: string;
  toDate: string;
  startTime: string | null;
  endTime: string | null;
  scope: string;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  groupIds: string[];
  cancelled: number;
  createdAt: string;
  createdByUserId: string | null;
  reversedAt: string | null;
  reinstated: number;
  skippedRoomTaken: number;
  credits: number;
  /** Unreversed, ahead: lessons in its range and scope written since it was made (S7). */
  addedSince: number;
  /** It told its people (CANCELLATION_DIGEST), so its reversal tells them too. */
  notifies: boolean;
}

export interface ReversePreview {
  reinstate: number;
  /** People the reversal's digest reaches; 0 for a batch that told nobody. */
  notify: number;
  /** Rows whose room was booked while they were cancelled: left cancelled, and named. */
  skippedRoomTaken: Array<{ lessonId: string; date: string; roomId: string; by: 'LESSON' | 'BOOKING' }>;
  /**
   * Rows whose lesson no longer runs at that slot: the grundschema has moved
   * it (or deleted it) since the batch, and the lesson is where it runs now.
   * The batch is all that kept such a row; reinstating it would give the
   * class the lesson twice that week, and leaving it would keep an
   * "Inställd" (and its lost minutes) for an event that was taken back. It
   * is deleted, as a template change deletes a stale row, and named.
   */
  removedTemplateMoved: Array<{ lessonId: string; date: string }>;
  /**
   * Rows whose lesson the grundschema moved since the batch and wrote no row for (a DIRECT school's edit moves what it can carry,
   * and a cancelled row stands in its own way): the lesson is the class's that week, so the row goes to the template's slot, from
   * `from` to `to`, and is a lesson again. A row whose new slot already has one is in `removedTemplateMoved` instead.
   */
  relocated: Array<{ lessonId: string; from: string; to: string }>;
  /** Rows the batch took that have begun, been held or been changed since: history. */
  notReinstatable: number;
  /** Credits dated today or later that the reversal deletes. */
  creditsDeleted: number;
}



/**
 * Bulk avbokning (migration 20261011110000): cancel a day's, a week's, a
 * class's or a span of years' lessons for one named reason, previewed first,
 * in one transaction, logged as a batch, reversible as a whole. Never a
 * lesson that has begun, been held or carries attendance (the past is not
 * rewritten), and never a teacher's or a room's cause.
 *
 * No notification per lesson: a week of prao is thirty notices per pupil.
 * The note on each cancelled lesson ("Inställd: Prao åk 9") is what the pupil
 * and guardian read, and the teacher app hears every row by realtime. The
 * admin may tick one digest per person instead (`notify`, unticked by
 * default), and a batch that sent one sends another when it is reversed
 * (cancellation-digest.ts).
 */
@Injectable()
export class CancellationBatchesService {
  private readonly logger = new Logger(CancellationBatchesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
  ) {}

  async preview(dto: CancellationSelectionDto, user: AuthenticatedUser): Promise<CancellationPreview> {
    requireSchoolId(user);
    const selection = checkSelection(dto);
    return this.prisma.withRls(user, async (tx) => {
      const { timezone, today } = await this.yearOf(tx, selection.academicYearId, selection);
      const outcome = await this.select(tx, selection, timezone);
      const audience = await digestAudience(tx, outcome.matched.map(digestLessonOf));
      return {
        matched: outcome.matched.length,
        lessons: outcome.matched.slice(0, 50).map(viewOf),
        excluded: outcome.excluded,
        ungradedGroups: outcome.ungradedGroups,
        creditDates: creditDatesOf(selection, outcome.matched, today),
        digest: selectionDigest(selection, outcome.matched),
        audience: audience.counts,
      };
    });
  }

  async create(
    dto: CreateCancellationBatchDto,
    user: AuthenticatedUser,
  ): Promise<{ batch: CancellationBatchView; cancelled: number; credits: number }> {
    const schoolId = requireSchoolId(user);
    const selection = checkSelection(dto);
    const { batch, lessonIds, credits } = await this.prisma.withRls(
      user,
      async (tx) => {
        // The publication lock, shared: no DRAFT publish moves rows between
        // this selection and its writes (publish-mode.ts).
        await enterGrundschemaWrite(tx, schoolId);
        const { timezone, today } = await this.yearOf(tx, selection.academicYearId, selection);
        const outcome = await this.select(tx, selection, timezone);
        if (dto.expectedDigest && dto.expectedDigest !== selectionDigest(selection, outcome.matched)) throw stale();
        if (outcome.matched.length === 0) {
          throw new BadRequestException({
            message: 'Urvalet träffar inga lektioner att ställa in.',
            code: CANCELLATION_SCOPE,
          });
        }
        const creditDates = dto.credit ? creditDatesOf(selection, outcome.matched, today) : [];
        if (dto.credit && (selection.startTime !== null || creditDates.length === 0)) {
          throw new BadRequestException({
            message:
              'En tillgodoräknad dag gäller hela dagar efter i dag: ta bort tidsfönstret, eller lägg tiden som en egen tillgodoräkning.',
            code: CANCELLATION_CREDIT,
          });
        }
        const row = await tx.cancellationBatch.create({
          data: {
            schoolId,
            academicYearId: selection.academicYearId,
            name: selection.name,
            cause: selection.cause,
            fromDate: day(selection.fromDate),
            toDate: day(selection.toDate),
            startTime: selection.startTime ? time(selection.startTime) : null,
            endTime: selection.endTime ? time(selection.endTime) : null,
            scope: selection.scope,
            minGradeLevel: selection.minGradeLevel,
            maxGradeLevel: selection.maxGradeLevel,
            groupIds: selection.groupIds,
            createdByUserId: user.userId ?? null,
            notifies: dto.notify === true,
          },
          select: { id: true },
        });
        const cancelled = await cancelInto(tx, schoolId, row.id, selection, outcome.matched);
        if (dto.notify === true) {
          const audience = await digestAudience(tx, outcome.matched.map(digestLessonOf));
          await sendDigest(this.notifications, tx, schoolId, { id: row.id, name: selection.name }, audience, false);
        }
        let creditCount = 0;
        for (const date of creditDates) {
          for (const target of creditTargetsOf(selection)) {
            const credit = await createCreditInTransaction(
              tx,
              schoolId,
              {
                academicYearId: selection.academicYearId,
                date,
                minutes: dto.credit!.minutes,
                subjectId: dto.credit!.subjectId ?? null,
                name: selection.name,
                ...target,
              },
              checkScope(target),
            );
            await tx.cancellationBatchCredit.create({ data: { batchId: row.id, creditId: credit.id, schoolId } });
            creditCount++;
          }
        }
        const stored = await tx.cancellationBatch.update({
          where: { id: row.id },
          data: { cancelled },
          select: BATCH_SELECT,
        });
        return { batch: stored, lessonIds: outcome.matched.map((lesson) => lesson.id), credits: creditCount };
      },
      { timeoutMs: 60_000 },
    );
    await this.broadcast(user, lessonIds);
    this.boardChanged(schoolId, selection.fromDate, selection.toDate);
    this.logger.log(`Cancellation batch created [batch=${batch.id}, cancelled=${batch.cancelled}, credits=${credits}]`);
    return { batch: toView(batch, 0), cancelled: batch.cancelled, credits };
  }

  async list(academicYearId: string, user: AuthenticatedUser): Promise<CancellationBatchView[]> {
    requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const { timezone, today } = await this.yearOf(tx, academicYearId, null);
      const rows = await tx.cancellationBatch.findMany({
        // An activity's avbokning is the activity's: listed, changed and removed
        // there (schedule-activities.service.ts), not here.
        where: { academicYearId, activities: { none: {} } },
        orderBy: [{ fromDate: 'desc' }, { createdAt: 'desc' }],
        select: BATCH_SELECT,
      });
      const views: CancellationBatchView[] = [];
      for (const row of rows) {
        let addedSince = 0;
        if (row.reversedAt === null && asDay(row.toDate) >= today) {
          const outcome = await this.select(tx, storedSelection(row), timezone);
          const taken = new Set(
            (await tx.cancellationBatchLesson.findMany({ where: { batchId: row.id }, select: { calendarLessonId: true } })).map(
              (entry) => entry.calendarLessonId,
            ),
          );
          addedSince = outcome.matched.filter((lesson) => !taken.has(lesson.id)).length;
        }
        views.push(toView(row, addedSince));
      }
      return views;
    });
  }

  /**
   * "Tillämpa igen": the batch's own selection run again, so a lesson
   * published into its range since — a refill, a moved lesson — is cancelled
   * with the rest and joins the batch.
   */
  async reapply(id: string, user: AuthenticatedUser): Promise<{ batch: CancellationBatchView; added: number }> {
    const schoolId = requireSchoolId(user);
    const { batch, added } = await this.prisma.withRls(user, async (tx) => {
      await enterGrundschemaWrite(tx, schoolId);
      const row = await this.requireBatch(tx, id);
      if (row.reversedAt !== null) throw reversed();
      const added = await reapplyInTransaction(tx, schoolId, row, await this.timezoneOf(tx, row.academicYearId));
      const stored = await tx.cancellationBatch.findUniqueOrThrow({ where: { id }, select: BATCH_SELECT });
      return { batch: stored, added };
    });
    await this.broadcast(user, added.ids);
    this.boardChanged(schoolId, asDay(batch.fromDate), asDay(batch.toDate));
    return { batch: toView(batch, 0), added: added.ids.length };
  }

  async reversePreview(id: string, user: AuthenticatedUser): Promise<ReversePreview> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const row = await this.requireBatch(tx, id);
      if (row.reversedAt !== null) throw reversed();
      await this.requireNoActivity(tx, id);
      const plan = await reversePlan(tx, schoolId, row, await this.timezoneOf(tx, row.academicYearId));
      const audience = row.notifies ? await digestAudience(tx, await digestLessonsOf(tx, [...plan.reinstate, ...plan.relocate])) : null;
      return {
        reinstate: plan.reinstate.length,
        notify: audience?.people.size ?? 0,
        skippedRoomTaken: plan.skipped,
        removedTemplateMoved: plan.templateMoved,
        relocated: relocatedOf(plan),
        notReinstatable: plan.notReinstatable,
        creditsDeleted: plan.creditIds.length,
      };
    });
  }

  /**
   * Takes the batch back: every row it cancelled that is still cancelled by
   * it and ahead goes back to SCHEDULED with the note it had, except a row
   * whose room was booked while it was free — that one stays cancelled and
   * is named (a reinstated row would double-book the room). A row whose
   * lesson the grundschema has moved since is deleted instead: the lesson is
   * where it runs now, and the old slot would hold it twice that week. Its
   * credits dated
   * today or later are deleted; a past one was a day already counted. Once.
   */
  async reverse(id: string, user: AuthenticatedUser): Promise<ReversePreview> {
    const schoolId = requireSchoolId(user);
    const { result, ids, range } = await this.prisma.withRls(user, async (tx) => {
      await enterGrundschemaWrite(tx, schoolId);
      const row = await this.requireBatch(tx, id);
      if (row.reversedAt !== null) throw reversed();
      await this.requireNoActivity(tx, id);
      const plan = await reversePlan(tx, schoolId, row, await this.timezoneOf(tx, row.academicYearId));
      await applyReinstatement(tx, row.cause, plan);
      if (plan.creditIds.length > 0) {
        await tx.timplanCredit.deleteMany({ where: { id: { in: plan.creditIds } } });
      }
      await tx.cancellationBatch.update({
        where: { id },
        data: {
          reversedAt: new Date(),
          reversedByUserId: user.userId ?? null,
          reinstated: plan.reinstate.length,
          skippedRoomTaken: plan.skipped.length,
        },
      });
      // A lesson carried to another day may land in a day another batch still holds: it is cancelled with that one (S7). After the
      // batch is marked reversed, so that this one does not take its own lesson back.
      const landed = await holdRelocated(tx, schoolId, row.academicYearId, plan.relocate, await this.timezoneOf(tx, row.academicYearId));
      // Told when it was made, so told now: about the lessons that come back.
      const told = row.notifies
        ? await sendDigest(
            this.notifications,
            tx,
            schoolId,
            { id: row.id, name: row.name },
            await digestAudience(tx, await digestLessonsOf(tx, [...plan.reinstate, ...plan.relocate].filter((lesson) => !landed.has(lesson.id)))),
            true,
          )
        : 0;
      const days = plan.relocate.flatMap((move) => [move.from, move.to]);
      return {
        ids: [...plan.reinstate, ...plan.relocate].map((lesson) => lesson.id),
        range: {
          from: [asDay(row.fromDate), ...days].sort()[0]!,
          to: [asDay(row.toDate), ...days].sort().reverse()[0]!,
        },
        result: {
          reinstate: plan.reinstate.length,
          notify: told,
          skippedRoomTaken: plan.skipped,
          removedTemplateMoved: plan.templateMoved,
          relocated: relocatedOf(plan),
          notReinstatable: plan.notReinstatable,
          creditsDeleted: plan.creditIds.length,
        },
      };
    });
    await this.broadcast(user, ids);
    this.boardChanged(schoolId, range.from, range.to);
    this.logger.log(`Cancellation batch reversed [batch=${id}, reinstated=${result.reinstate}, skipped=${result.skippedRoomTaken.length}]`);
    return result;
  }

  // ---------------------------------------------------------------------

  private async select(tx: PrismaClient, selection: StoredSelection, timezone: string) {
    const rows = await tx.calendarLesson.findMany({
      where: {
        studentGroup: { is: { academicYearId: selection.academicYearId } },
        date: { gte: day(selection.fromDate), lte: day(selection.toDate) },
        // An activity's replacement lesson is what takes the cancelled ones' place.
        activityLinks: { none: {} },
      },
      select: CANDIDATE_SELECT,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    });
    return selectLessons(rows.map(toCandidate), ruleOf(selection, timezone, new Date()));
  }

  /**
   * The cover board's admins hear that these days changed: a batch cancels
   * lessons an absence may be waiting on, and a reversal brings them back.
   * After commit, best effort.
   */
  private boardChanged(schoolId: string, from: string, to: string): void {
    try {
      this.realtime.notifyCoverBoardChanged(schoolId, from, to);
    } catch {
      this.logger.debug(`Cover board broadcast failed [school=${schoolId}]`);
    }
  }

  /** After commit, one read for all the rows, then one emit each (realtime.service.ts). */
  private async broadcast(user: AuthenticatedUser, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.withRls(user, (tx) => this.realtime.notifyLessonsChanged(tx, ids)).catch(() => undefined);
  }

  private async requireBatch(tx: PrismaClient, id: string) {
    const row = await tx.cancellationBatch.findUnique({ where: { id }, select: BATCH_SELECT });
    if (!row) throw new NotFoundException('Avbokningen finns inte.');
    return row;
  }

  /**
   * An avbokning an activity owns is taken back with the activity, which puts
   * its replacement lessons away with it; reversing it here would leave them
   * standing for a day that is no longer cancelled.
   */
  private async requireNoActivity(tx: PrismaClient, batchId: string): Promise<void> {
    const owner = await tx.scheduleActivity.findFirst({ where: { batchId }, select: { id: true } });
    if (owner) {
      throw new ConflictException({
        message: 'Avbokningen hör till en schemabrytande aktivitet: ta bort aktiviteten i stället.',
        code: 'ACTIVITY_OWNS_BATCH',
        params: { activityId: owner.id },
      });
    }
  }

  private async timezoneOf(tx: PrismaClient, academicYearId: string): Promise<string> {
    const year = await tx.academicYear.findUnique({
      where: { id: academicYearId },
      select: { school: { select: { timezone: true } } },
    });
    return year?.school.timezone ?? 'Europe/Stockholm';
  }

  private yearOf(tx: PrismaClient, academicYearId: string, selection: StoredSelection | null) {
    return yearOf(tx, academicYearId, selection);
  }
}

// ---------------------------------------------------------------------------

function toView(row: BatchRow, addedSince: number): CancellationBatchView {
  return {
    id: row.id,
    name: row.name,
    cause: row.cause as 'EVENT' | 'MANUAL',
    fromDate: asDay(row.fromDate),
    toDate: asDay(row.toDate),
    startTime: clock(row.startTime),
    endTime: clock(row.endTime),
    scope: row.scope,
    minGradeLevel: row.minGradeLevel,
    maxGradeLevel: row.maxGradeLevel,
    groupIds: row.groupIds,
    cancelled: row.cancelled,
    createdAt: row.createdAt.toISOString(),
    createdByUserId: row.createdByUserId,
    reversedAt: row.reversedAt ? row.reversedAt.toISOString() : null,
    reinstated: row.reinstated,
    skippedRoomTaken: row.skippedRoomTaken,
    credits: row._count.credits,
    addedSince,
    notifies: row.notifies,
  };
}

const viewOf = (lesson: SelectionCandidate): BatchLessonView => ({
  id: lesson.id,
  date: lesson.date,
  startsAt: lesson.startsAt.toISOString(),
  endsAt: lesson.endsAt.toISOString(),
  subjectName: lesson.subjectName,
  groupName: lesson.groupName,
});


/** The plan's relocations as the answers name them. */
export function relocatedOf(plan: { relocate: ReadonlyArray<{ id: string; from: string; to: string }> }): ReversePreview['relocated'] {
  return plan.relocate.map((move) => ({ lessonId: move.id, from: move.from, to: move.to }));
}

/**
 * Lessons carried to the template's slot, held against every batch still on: one that holds the new day takes them (S7), as it takes a
 * row a template change moves there. Called after the batch that gave them back is marked reversed. The ids it took.
 */
export async function holdRelocated(
  tx: PrismaClient,
  schoolId: string,
  academicYearId: string,
  relocated: ReadonlyArray<{ id: string; to: string }>,
  timezone: string,
): Promise<Set<string>> {
  if (relocated.length === 0) return new Set();
  const days = relocated.map((move) => move.to).sort();
  const taken = await reapplyActiveBatches(tx, schoolId, academicYearId, days[0]!, days[days.length - 1]!, timezone);
  return new Set(taken);
}

/**
 * A batch's selection over the calendar as it is now, cancelling what it
 * takes that the batch does not hold yet. Also run by a publish or a refill
 * for every unreversed batch they write into (S7), so a lesson materialised
 * into a prao week is cancelled like its neighbours.
 */
export async function reapplyInTransaction(
  tx: PrismaClient,
  schoolId: string,
  row: BatchRow,
  timezone: string,
): Promise<{ ids: string[]; replacements?: SyncResult }> {
  const selection = storedSelection(row);
  const matched = await pendingLessons(tx, row, timezone);
  if (matched.length === 0) return { ids: [] };
  const added = await cancelInto(tx, schoolId, row.id, selection, matched);
  await tx.cancellationBatch.update({ where: { id: row.id }, data: { cancelled: { increment: added } } });
  // An activity's replacement lessons follow its cancelled lessons: the class
  // whose day grew starts earlier or ends later, a day that had no lesson
  // before gets one. A batch no activity owns writes nothing here.
  const replacements = await syncReplacementsInTransaction(tx, schoolId, row.id);
  return { ids: matched.map((lesson) => lesson.id), replacements };
}

/** Every unreversed batch overlapping [from, to], applied again (S7). Returns the rows it cancelled. */
export async function reapplyActiveBatches(
  tx: PrismaClient,
  schoolId: string,
  academicYearId: string,
  from: string,
  to: string,
  timezone: string,
): Promise<string[]> {
  const batches = await tx.cancellationBatch.findMany({
    where: { academicYearId, reversedAt: null, fromDate: { lte: day(to) }, toDate: { gte: day(from) } },
    select: BATCH_SELECT,
  });
  const ids: string[] = [];
  for (const batch of batches) ids.push(...(await reapplyInTransaction(tx, schoolId, batch, timezone)).ids);
  return ids;
}


