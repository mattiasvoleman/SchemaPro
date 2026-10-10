import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { todayInZone, zonedTimeToUtc } from '../common/utils/time';
import { runsOn } from '../calendar/lesson-recurrence';
import { isoWeekday, timeToString } from '../calendar/publish-days';
import { effectiveSegments } from './publication-validity';
import { snapshotRanges } from './published-grundschema';
import { RealtimeService } from '../realtime/realtime.service';
import { checkScope, createCreditInTransaction } from '../timplan/timplan-credits.service';
import { enterGrundschemaWrite, publishModeOf } from './publish-mode';
import {
  selectLessons,
  selectionDigest,
  type SelectionCandidate,
  type SelectionRule,
} from './cancellation-selection';
import type { CancellationSelectionDto, CreateCancellationBatchDto } from './dto/cancellation-batch.dto';

export const CANCELLATION_STALE = 'CANCELLATION_STALE';
export const CANCELLATION_REVERSED = 'CANCELLATION_REVERSED';
export const CANCELLATION_RANGE = 'CANCELLATION_RANGE';
export const CANCELLATION_SCOPE = 'CANCELLATION_SCOPE';
export const CANCELLATION_CREDIT = 'CANCELLATION_CREDIT';

const asDay = (value: Date): string => value.toISOString().slice(0, 10);
const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
const clock = (value: Date | null): string | null => (value ? value.toISOString().slice(11, 16) : null);
const time = (value: string): Date => new Date(`1970-01-01T${value}:00.000Z`);

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
}

export interface ReversePreview {
  reinstate: number;
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
  /** Rows the batch took that have begun, been held or been changed since: history. */
  notReinstatable: number;
  /** Credits dated today or later that the reversal deletes. */
  creditsDeleted: number;
}

const CANDIDATE_SELECT = {
  id: true,
  date: true,
  startsAt: true,
  endsAt: true,
  status: true,
  note: true,
  studentGroupId: true,
  studentGroup: { select: { name: true, gradeLevel: true } },
  subject: { select: { name: true } },
  extraGroups: { select: { studentGroupId: true, studentGroup: { select: { gradeLevel: true } } } },
  _count: { select: { attendanceRecords: true } },
} as const satisfies Prisma.CalendarLessonSelect;

type CandidateRow = Prisma.CalendarLessonGetPayload<{ select: typeof CANDIDATE_SELECT }>;

const toCandidate = (row: CandidateRow): SelectionCandidate => ({
  id: row.id,
  date: asDay(row.date),
  startsAt: row.startsAt,
  endsAt: row.endsAt,
  status: row.status,
  attendance: row._count.attendanceRecords,
  studentGroupId: row.studentGroupId,
  gradeLevel: row.studentGroup.gradeLevel,
  groupName: row.studentGroup.name,
  subjectName: row.subject.name,
  extraGroups: row.extraGroups.map((entry) => ({
    studentGroupId: entry.studentGroupId,
    gradeLevel: entry.studentGroup.gradeLevel,
  })),
  note: row.note,
});

interface StoredSelection {
  academicYearId: string;
  name: string;
  cause: 'EVENT' | 'MANUAL';
  fromDate: string;
  toDate: string;
  startTime: string | null;
  endTime: string | null;
  scope: 'SCHOOL' | 'GRADES' | 'GROUPS';
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  groupIds: string[];
}

/**
 * Bulk avbokning (migration 20261011110000): cancel a day's, a week's, a
 * class's or a span of years' lessons for one named reason, previewed first,
 * in one transaction, logged as a batch, reversible as a whole. Never a
 * lesson that has begun, been held or carries attendance (the past is not
 * rewritten), and never a teacher's or a room's cause.
 *
 * No notification per lesson: a week of prao is thirty notices per pupil,
 * and a digest needs a notification type the mobile app does not render yet
 * — the note on each cancelled lesson ("Inställd: Prao åk 9") is what the
 * pupil and guardian read, and the teacher app hears every row by realtime.
 */
@Injectable()
export class CancellationBatchesService {
  private readonly logger = new Logger(CancellationBatchesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  async preview(dto: CancellationSelectionDto, user: AuthenticatedUser): Promise<CancellationPreview> {
    requireSchoolId(user);
    const selection = checkSelection(dto);
    return this.prisma.withRls(user, async (tx) => {
      const { timezone, today } = await this.yearOf(tx, selection.academicYearId, selection);
      const outcome = await this.select(tx, selection, timezone);
      return {
        matched: outcome.matched.length,
        lessons: outcome.matched.slice(0, 50).map(viewOf),
        excluded: outcome.excluded,
        ungradedGroups: outcome.ungradedGroups,
        creditDates: creditDatesOf(selection, outcome.matched, today),
        digest: selectionDigest(selection, outcome.matched),
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
          },
          select: { id: true },
        });
        const cancelled = await cancelInto(tx, schoolId, row.id, selection, outcome.matched);
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
    this.logger.log(`Cancellation batch created [batch=${batch.id}, cancelled=${batch.cancelled}, credits=${credits}]`);
    return { batch: toView(batch, 0), cancelled: batch.cancelled, credits };
  }

  async list(academicYearId: string, user: AuthenticatedUser): Promise<CancellationBatchView[]> {
    requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const { timezone, today } = await this.yearOf(tx, academicYearId, null);
      const rows = await tx.cancellationBatch.findMany({
        where: { academicYearId },
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
    return { batch: toView(batch, 0), added: added.ids.length };
  }

  async reversePreview(id: string, user: AuthenticatedUser): Promise<ReversePreview> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const row = await this.requireBatch(tx, id);
      if (row.reversedAt !== null) throw reversed();
      const plan = await reversePlan(tx, schoolId, row, await this.timezoneOf(tx, row.academicYearId));
      return {
        reinstate: plan.reinstate.length,
        skippedRoomTaken: plan.skipped,
        removedTemplateMoved: plan.templateMoved,
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
    const { result, ids } = await this.prisma.withRls(user, async (tx) => {
      await enterGrundschemaWrite(tx, schoolId);
      const row = await this.requireBatch(tx, id);
      if (row.reversedAt !== null) throw reversed();
      const plan = await reversePlan(tx, schoolId, row, await this.timezoneOf(tx, row.academicYearId));
      const byNote = new Map<string | null, string[]>();
      for (const lesson of plan.reinstate) {
        const list = byNote.get(lesson.previousNote) ?? [];
        list.push(lesson.id);
        byNote.set(lesson.previousNote, list);
      }
      for (const [note, lessonIds] of byNote) {
        await tx.calendarLesson.updateMany({
          where: { id: { in: lessonIds }, status: 'CANCELLED', cancelCause: row.cause },
          data: { status: 'SCHEDULED', cancelCause: null, note },
        });
      }
      if (plan.templateMoved.length > 0) {
        // The same guard the plan read them by, repeated in the write.
        await tx.calendarLesson.deleteMany({
          where: {
            id: { in: plan.templateMoved.map((entry) => entry.lessonId) },
            status: 'CANCELLED',
            cancelCause: row.cause,
            startsAt: { gt: new Date() },
            attendanceRecords: { none: {} },
          },
        });
      }
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
      return {
        ids: plan.reinstate.map((lesson) => lesson.id),
        result: {
          reinstate: plan.reinstate.length,
          skippedRoomTaken: plan.skipped,
          removedTemplateMoved: plan.templateMoved,
          notReinstatable: plan.notReinstatable,
          creditsDeleted: plan.creditIds.length,
        },
      };
    });
    await this.broadcast(user, ids);
    this.logger.log(`Cancellation batch reversed [batch=${id}, reinstated=${result.reinstate}, skipped=${result.skippedRoomTaken.length}]`);
    return result;
  }

  // ---------------------------------------------------------------------

  private async select(tx: PrismaClient, selection: StoredSelection, timezone: string) {
    const rows = await tx.calendarLesson.findMany({
      where: {
        studentGroup: { is: { academicYearId: selection.academicYearId } },
        date: { gte: day(selection.fromDate), lte: day(selection.toDate) },
      },
      select: CANDIDATE_SELECT,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    });
    return selectLessons(rows.map(toCandidate), ruleOf(selection, timezone, new Date()));
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

  private async timezoneOf(tx: PrismaClient, academicYearId: string): Promise<string> {
    const year = await tx.academicYear.findUnique({
      where: { id: academicYearId },
      select: { school: { select: { timezone: true } } },
    });
    return year?.school.timezone ?? 'Europe/Stockholm';
  }

  /** The year, its timezone and the school's today; the range must lie inside the year. */
  private async yearOf(
    tx: PrismaClient,
    academicYearId: string,
    selection: StoredSelection | null,
  ): Promise<{ timezone: string; today: string }> {
    const year = await tx.academicYear.findUnique({
      where: { id: academicYearId },
      select: { startDate: true, endDate: true, school: { select: { timezone: true } } },
    });
    if (!year) throw new NotFoundException('Läsåret finns inte.');
    if (selection && (selection.fromDate < asDay(year.startDate) || selection.toDate > asDay(year.endDate))) {
      throw new BadRequestException({
        message: `fromDate/toDate: avbokningen ligger inom läsåret (${asDay(year.startDate)}–${asDay(year.endDate)}).`,
        code: CANCELLATION_RANGE,
      });
    }
    if (selection && selection.scope === 'GROUPS') {
      const found = await tx.studentGroup.count({ where: { id: { in: selection.groupIds }, academicYearId } });
      if (found !== new Set(selection.groupIds).size) {
        throw new BadRequestException({
          message: 'groupIds: varje grupp ska vara en grupp i läsåret.',
          code: CANCELLATION_SCOPE,
        });
      }
    }
    return { timezone: year.school.timezone, today: asDay(todayInZone(year.school.timezone)) };
  }
}

// ---------------------------------------------------------------------------

const BATCH_SELECT = {
  id: true,
  academicYearId: true,
  name: true,
  cause: true,
  fromDate: true,
  toDate: true,
  startTime: true,
  endTime: true,
  scope: true,
  minGradeLevel: true,
  maxGradeLevel: true,
  groupIds: true,
  cancelled: true,
  createdAt: true,
  createdByUserId: true,
  reversedAt: true,
  reinstated: true,
  skippedRoomTaken: true,
  _count: { select: { credits: true } },
} as const satisfies Prisma.CancellationBatchSelect;

type BatchRow = Prisma.CancellationBatchGetPayload<{ select: typeof BATCH_SELECT }>;

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
  };
}

function storedSelection(row: BatchRow): StoredSelection {
  return {
    academicYearId: row.academicYearId,
    name: row.name,
    cause: row.cause as 'EVENT' | 'MANUAL',
    fromDate: asDay(row.fromDate),
    toDate: asDay(row.toDate),
    startTime: clock(row.startTime),
    endTime: clock(row.endTime),
    scope: row.scope as StoredSelection['scope'],
    minGradeLevel: row.minGradeLevel,
    maxGradeLevel: row.maxGradeLevel,
    groupIds: row.groupIds,
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

function ruleOf(selection: StoredSelection, timezone: string, now: Date): SelectionRule {
  return {
    scope: selection.scope,
    minGradeLevel: selection.minGradeLevel,
    maxGradeLevel: selection.maxGradeLevel,
    groupIds: selection.groupIds,
    startTime: selection.startTime,
    endTime: selection.endTime,
    timezone,
    now,
  };
}

/** The cross-field rules a DTO cannot state, with the fields named. Mirrors the CHECKs. */
function checkSelection(dto: CancellationSelectionDto): StoredSelection {
  if (dto.toDate < dto.fromDate) {
    throw new BadRequestException({ message: 'toDate: avbokningens sista dag ligger före den första.', code: CANCELLATION_RANGE });
  }
  if ((day(dto.toDate).getTime() - day(dto.fromDate).getTime()) / 86_400_000 > 30) {
    throw new BadRequestException({ message: 'toDate: en avbokning gäller högst 31 dagar.', code: CANCELLATION_RANGE });
  }
  if ((dto.startTime === undefined) !== (dto.endTime === undefined) || (dto.startTime && dto.endTime && dto.startTime >= dto.endTime)) {
    throw new BadRequestException({
      message: 'startTime/endTime: ett tidsfönster har en början före sitt slut, eller utelämnas helt.',
      code: CANCELLATION_RANGE,
    });
  }
  const span = dto.minGradeLevel !== undefined || dto.maxGradeLevel !== undefined;
  const groups = dto.groupIds !== undefined && dto.groupIds.length > 0;
  const scopeOk =
    dto.scope === 'SCHOOL'
      ? !span && !groups
      : dto.scope === 'GRADES'
        ? dto.minGradeLevel !== undefined && dto.maxGradeLevel !== undefined && dto.minGradeLevel <= dto.maxGradeLevel && !groups
        : groups && !span;
  if (!scopeOk) {
    throw new BadRequestException({
      message:
        'scope: SCHOOL anger varken årskurser eller grupper, GRADES anger minGradeLevel och maxGradeLevel i ordning, GROUPS anger groupIds.',
      code: CANCELLATION_SCOPE,
    });
  }
  return {
    academicYearId: dto.academicYearId,
    name: dto.name.trim(),
    cause: dto.cause,
    fromDate: dto.fromDate,
    toDate: dto.toDate,
    startTime: dto.startTime ?? null,
    endTime: dto.endTime ?? null,
    scope: dto.scope,
    minGradeLevel: dto.scope === 'GRADES' ? dto.minGradeLevel! : null,
    maxGradeLevel: dto.scope === 'GRADES' ? dto.maxGradeLevel! : null,
    groupIds: dto.scope === 'GROUPS' ? [...new Set(dto.groupIds!)] : [],
  };
}

/**
 * The dates a credit is written for: a whole-day batch's dates that lie
 * after the school's today and on which the batch cancels a lesson — a day
 * that had teaching to count. A day with a time window, or one already under
 * way, could be partly held, and a credit for all of it would count the held
 * part twice.
 */
function creditDatesOf(selection: StoredSelection, matched: readonly SelectionCandidate[], today: string): string[] {
  if (selection.startTime !== null) return [];
  return [...new Set(matched.map((lesson) => lesson.date))].filter((date) => date > today).sort();
}

/** One credit per date for the school or the span, one per group per date for GROUPS. */
function creditTargetsOf(
  selection: StoredSelection,
): Array<{ studentGroupId: string | null; minGradeLevel: number | null; maxGradeLevel: number | null }> {
  if (selection.scope === 'GROUPS') {
    return selection.groupIds.map((studentGroupId) => ({ studentGroupId, minGradeLevel: null, maxGradeLevel: null }));
  }
  return [{ studentGroupId: null, minGradeLevel: selection.minGradeLevel, maxGradeLevel: selection.maxGradeLevel }];
}

/** Cancels the rows into the batch, keeping each one's note to give back. */
async function cancelInto(
  tx: PrismaClient,
  schoolId: string,
  batchId: string,
  selection: Pick<StoredSelection, 'cause' | 'name'>,
  lessons: readonly SelectionCandidate[],
): Promise<number> {
  if (lessons.length === 0) return 0;
  await tx.cancellationBatchLesson.createMany({
    data: lessons.map((lesson) => ({ batchId, calendarLessonId: lesson.id, schoolId, previousNote: lesson.note })),
  });
  const { count } = await tx.calendarLesson.updateMany({
    where: {
      id: { in: lessons.map((lesson) => lesson.id) },
      status: 'SCHEDULED',
      startsAt: { gt: new Date() },
      attendanceRecords: { none: {} },
    },
    data: { status: 'CANCELLED', cancelCause: selection.cause, note: `Inställd: ${selection.name}` },
  });
  // Read and written in one transaction under the publication lock; a row
  // that changed in between (a cancel, a vikarie's first register) means the
  // preview no longer says what this would do.
  if (count !== lessons.length) throw stale();
  return count;
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
): Promise<{ ids: string[] }> {
  const selection = storedSelection(row);
  const rows = await tx.calendarLesson.findMany({
    where: {
      studentGroup: { is: { academicYearId: selection.academicYearId } },
      date: { gte: day(selection.fromDate), lte: day(selection.toDate) },
      batchLessons: { none: { batchId: row.id } },
    },
    select: CANDIDATE_SELECT,
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
  });
  const { matched } = selectLessons(rows.map(toCandidate), ruleOf(selection, timezone, new Date()));
  if (matched.length === 0) return { ids: [] };
  const added = await cancelInto(tx, schoolId, row.id, selection, matched);
  await tx.cancellationBatch.update({ where: { id: row.id }, data: { cancelled: { increment: added } } });
  return { ids: matched.map((lesson) => lesson.id) };
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

/** A template as the slot check reads it: the master's, or a snapshot's row. */
interface SlotTemplate {
  dayOfWeek: number;
  startTime: Date;
  endTime: Date;
  recurrence: Prisma.MasterLessonGetPayload<{ select: { recurrence: true } }>['recurrence'];
  startDate: Date | null;
  endDate: Date | null;
}

const SLOT_SELECT = {
  dayOfWeek: true,
  startTime: true,
  endTime: true,
  recurrence: true,
  startDate: true,
  endDate: true,
} as const;

/**
 * For each row, the published template it would run by on its date, or null
 * when its lesson no longer has one. DIRECT: the master itself. DRAFT: the
 * snapshot of the segment the date lies in (publication-validity.ts) — the
 * draft is not what is published. A row whose master was deleted in a draft
 * is keyed on its recorded id (PublicationPendingRemovals), as every
 * published-key reader keys it.
 */
async function publishedTemplates(
  tx: PrismaClient,
  schoolId: string,
  academicYearId: string,
  rows: ReadonlyArray<{ id: string; date: Date; masterLessonId: string | null }>,
): Promise<Map<string, SlotTemplate | null>> {
  const out = new Map<string, SlotTemplate | null>();
  if (rows.length === 0) return out;
  const pending = new Map(
    (
      await tx.publicationPendingRemoval.findMany({
        where: { calendarLessonId: { in: rows.filter((row) => row.masterLessonId === null).map((row) => row.id) } },
        select: { calendarLessonId: true, masterLessonId: true },
      })
    ).map((entry) => [entry.calendarLessonId, entry.masterLessonId]),
  );
  const keyOf = (row: (typeof rows)[number]) => row.masterLessonId ?? pending.get(row.id) ?? null;
  const ids = [...new Set(rows.map(keyOf).filter((id): id is string => id !== null))];
  if ((await publishModeOf(tx, schoolId)) === 'DIRECT') {
    const masters = new Map(
      (await tx.masterLesson.findMany({ where: { id: { in: ids } }, select: { id: true, isParked: true, ...SLOT_SELECT } })).map(
        (master) => [master.id, master],
      ),
    );
    for (const row of rows) {
      const master = masters.get(keyOf(row) ?? '');
      out.set(row.id, master ?? null);
    }
    return out;
  }
  const segments = effectiveSegments(await snapshotRanges(tx, academicYearId));
  const bySegment = new Map<string, Map<string, SlotTemplate>>();
  for (const row of rows) {
    const date = asDay(row.date);
    const segment = segments.find((entry) => entry.from <= date && date <= entry.to);
    const key = keyOf(row);
    if (!segment || key === null) {
      out.set(row.id, null);
      continue;
    }
    let published = bySegment.get(segment.publicationId);
    if (!published) {
      published = new Map(
        (
          await tx.publishedLesson.findMany({
            where: { publicationId: segment.publicationId, masterLessonId: { in: ids } },
            select: { masterLessonId: true, ...SLOT_SELECT },
          })
        ).map((lesson) => [lesson.masterLessonId, lesson]),
      );
      bySegment.set(segment.publicationId, published);
    }
    out.set(row.id, published.get(key) ?? null);
  }
  return out;
}

/** Does the template run this row's lesson at exactly this date and slot? */
function runsAt(template: SlotTemplate | null, row: { date: Date; startsAt: Date; endsAt: Date }, timezone: string): boolean {
  if (template === null) return false;
  const date = asDay(row.date);
  return (
    template.dayOfWeek === isoWeekday(date) &&
    zonedTimeToUtc(date, timeToString(template.startTime), timezone).getTime() === row.startsAt.getTime() &&
    zonedTimeToUtc(date, timeToString(template.endTime), timezone).getTime() === row.endsAt.getTime() &&
    runsOn(template, row.date)
  );
}

async function reversePlan(tx: PrismaClient, schoolId: string, row: BatchRow, timezone: string) {
  const today = asDay(todayInZone(timezone));
  const lessons = await tx.cancellationBatchLesson.findMany({
    where: { batchId: row.id },
    select: {
      previousNote: true,
      calendarLesson: {
        select: {
          id: true,
          date: true,
          startsAt: true,
          endsAt: true,
          status: true,
          cancelCause: true,
          roomId: true,
          masterLessonId: true,
          _count: { select: { attendanceRecords: true } },
        },
      },
    },
  });
  const now = new Date();
  const candidates = lessons.filter(
    (entry) =>
      entry.calendarLesson.status === 'CANCELLED' &&
      entry.calendarLesson.cancelCause === row.cause &&
      entry.calendarLesson.startsAt > now &&
      entry.calendarLesson._count.attendanceRecords === 0,
  );
  const skipped: ReversePreview['skippedRoomTaken'] = [];
  const templateMoved: ReversePreview['removedTemplateMoved'] = [];
  const reinstate: Array<{ id: string; previousNote: string | null }> = [];
  // The slot the lesson runs at NOW. A publish (or a DIRECT edit) since the
  // batch moves the template, materialises the new day, and the batch takes
  // that row too (S7); reinstating the old day's row as well would give the
  // class the lesson twice that week, at a slot no timetable has any more.
  const templates = await publishedTemplates(
    tx,
    schoolId,
    row.academicYearId,
    candidates.map((entry) => entry.calendarLesson),
  );
  for (const entry of candidates) {
    const lesson = entry.calendarLesson;
    if (!runsAt(templates.get(lesson.id) ?? null, lesson, timezone)) {
      templateMoved.push({ lessonId: lesson.id, date: asDay(lesson.date) });
      continue;
    }
    if (lesson.roomId !== null) {
      // The room's other SCHEDULED lessons, and its live bookings (the
      // booking flow's own predicate: PENDING or APPROVED), over the slot.
      const other = await tx.calendarLesson.findFirst({
        where: {
          id: { not: lesson.id },
          roomId: lesson.roomId,
          status: 'SCHEDULED',
          startsAt: { lt: lesson.endsAt },
          endsAt: { gt: lesson.startsAt },
        },
        select: { id: true },
      });
      const booking = other
        ? null
        : await tx.roomBooking.findFirst({
            where: {
              roomId: lesson.roomId,
              status: { in: ['PENDING', 'APPROVED'] },
              startsAt: { lt: lesson.endsAt },
              endsAt: { gt: lesson.startsAt },
            },
            select: { id: true },
          });
      if (other || booking) {
        skipped.push({ lessonId: lesson.id, date: asDay(lesson.date), roomId: lesson.roomId, by: other ? 'LESSON' : 'BOOKING' });
        continue;
      }
    }
    reinstate.push({ id: lesson.id, previousNote: entry.previousNote });
  }
  const credits = await tx.cancellationBatchCredit.findMany({
    where: { batchId: row.id, credit: { is: { date: { gte: day(today) } } } },
    select: { creditId: true },
  });
  return {
    reinstate,
    skipped,
    templateMoved,
    notReinstatable: lessons.length - candidates.length,
    creditIds: credits.map((entry) => entry.creditId),
  };
}

function stale(): ConflictException {
  return new ConflictException({
    message: 'Lektionerna i urvalet har ändrats sedan förhandsgranskningen. Granska igen.',
    code: CANCELLATION_STALE,
  });
}

function reversed(): ConflictException {
  return new ConflictException({
    message: 'Avbokningen är redan återställd.',
    code: CANCELLATION_REVERSED,
  });
}

