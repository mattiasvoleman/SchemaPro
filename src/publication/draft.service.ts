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
import { todayInZone } from '../common/utils/time';
import { CalendarService, type MaterialiseTemplate, type PublishResult } from '../calendar/calendar.service';
import { ScheduleVersionsService } from '../calendar/schedule-versions.service';
import { RealtimeService } from '../realtime/realtime.service';
import { lunchFinding } from './publication-gates.reader';
import { DEFAULT_GATE_POLICY, gateVerdict, settleGates, type GateItem } from './publication-gates';
import { effectiveSegments, type ValiditySegment } from './publication-validity';
import {
  lessonDiffers,
  readDraftMasters,
  readPublishedMasters,
  snapshotFor,
  snapshotMasters,
  snapshotRanges,
  type PublishedMaster,
} from './published-grundschema';
import { enterPublication, publishModeOf } from './publish-mode';
import { reapplyActiveBatches } from './cancellation-batches.service';
import {
  PUBLISH_DRAFT_PENDING,
  PUBLISH_NOT_DRAFT,
  PUBLISH_NOTHING_PUBLISHED,
  PUBLISH_WARNINGS_UNACKNOWLEDGED,
  type PublishModeName,
} from './publications.service';

const asDay = (value: Date): string => value.toISOString().slice(0, 10);
const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

export interface ModeSwitchResult {
  publishMode: PublishModeName;
  /** DIRECT → DRAFT: the BASELINE publication recorded per year. */
  baselines: Array<{ academicYearId: string; publicationId: string; validFrom: string; validTo: string; lessonCount: number }>;
}

/** A lesson as the draft state lists it: what the admin compares. */
export interface DraftLessonView {
  id: string;
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  roomId: string | null;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  isParked: boolean;
}

export interface DraftState {
  academicYearId: string;
  publishMode: PublishModeName;
  /** The publication the draft is compared with: valid today, else ahead, else last. */
  publicationId: string | null;
  added: DraftLessonView[];
  changed: Array<{ before: DraftLessonView; after: DraftLessonView }>;
  removed: DraftLessonView[];
  /** Published rows of deleted lessons waiting for a publish to settle them. */
  pendingRemovals: number;
}

const view = (lesson: PublishedMaster): DraftLessonView => ({
  id: lesson.id,
  subjectId: lesson.subjectId,
  studentGroupId: lesson.studentGroupId,
  teacherId: lesson.teacherId,
  coTeacherId: lesson.coTeacherId,
  roomId: lesson.roomId,
  dayOfWeek: lesson.dayOfWeek,
  startTime: lesson.startTime.toISOString().slice(11, 16),
  endTime: lesson.endTime.toISOString().slice(11, 16),
  isParked: lesson.isParked,
});

/**
 * The draft layer's own operations (20261011100000): switching the mode,
 * the draft's state against what is published, discarding a draft, and a
 * DRAFT school's refill of its PUBLISHED grundschema. The gated publish
 * itself is PublicationsService's. Each takes the exclusive publication lock
 * first, so no grundschema write lands half-way through one.
 */
@Injectable()
export class DraftService {
  private readonly logger = new Logger(DraftService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: CalendarService,
    private readonly versions: ScheduleVersionsService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * DIRECT → DRAFT records, for every läsår of the school that has a
   * grundschema and has not ended, a BASELINE publication: a snapshot of the
   * masters, valid from today (or the year's start) to the year's end. That
   * is what teachers and SS12000 have been reading, so after the switch they
   * read the same rows from the snapshot — an empty draft changes no answer.
   *
   * DRAFT → DIRECT is refused (409 PUBLISH_DRAFT_PENDING) while the draft
   * differs from any snapshot still valid ahead, or a deleted lesson's
   * published rows are unsettled: in DIRECT the masters ARE what is published,
   * and switching would publish the draft without a gate. Publishing the
   * draft from today to the year's end is the way to make them equal.
   */
  async switchMode(target: PublishModeName, user: AuthenticatedUser): Promise<ModeSwitchResult> {
    const schoolId = requireSchoolId(user);
    const result = await this.prisma.withRls(
      user,
      async (tx): Promise<ModeSwitchResult> => {
        const current = await enterPublication(tx, schoolId);
        if (current === target) return { publishMode: current, baselines: [] };
        const school = await tx.school.findUnique({ where: { id: schoolId }, select: { timezone: true } });
        const today = asDay(todayInZone(school?.timezone ?? 'Europe/Stockholm'));
        const years = await tx.academicYear.findMany({
          where: { schoolId, endDate: { gte: day(today) } },
          select: { id: true, name: true, startDate: true, endDate: true },
          orderBy: { startDate: 'asc' },
        });

        if (target === 'DRAFT') {
          const baselines: ModeSwitchResult['baselines'] = [];
          for (const year of years) {
            const masters = await readDraftMasters(tx, year.id);
            if (masters.length === 0) continue;
            const validFrom = today > asDay(year.startDate) ? today : asDay(year.startDate);
            const validTo = asDay(year.endDate);
            const row = await tx.timetablePublication.create({
              data: {
                schoolId,
                academicYearId: year.id,
                kind: 'BASELINE',
                outcome: 'PUBLISHED',
                publishMode: 'DRAFT',
                validFrom: day(validFrom),
                validTo: day(validTo),
                publishedByUserId: user.userId ?? null,
                lessonCount: masters.length,
              },
              select: { id: true },
            });
            await snapshotMasters(tx, { id: row.id, schoolId, academicYearId: year.id }, masters);
            baselines.push({ academicYearId: year.id, publicationId: row.id, validFrom, validTo, lessonCount: masters.length });
          }
          await tx.publicationSettings.upsert({
            where: { schoolId },
            create: { schoolId, publishMode: 'DRAFT' },
            update: { publishMode: 'DRAFT' },
          });
          return { publishMode: 'DRAFT', baselines };
        }

        // A recorded row that has begun is history: DIRECT would have left it
        // an orphan too, so it is released rather than held against the switch.
        await tx.publicationPendingRemoval.deleteMany({
          where: { schoolId, calendarLesson: { is: { startsAt: { lte: new Date() } } } },
        });
        const pending = await tx.publicationPendingRemoval.count({ where: { schoolId } });
        for (const year of years) {
          const masters = new Map((await readDraftMasters(tx, year.id)).map((master) => [master.id, master]));
          const future = effectiveSegments(await snapshotRanges(tx, year.id)).filter((segment) => segment.to >= today);
          for (const segment of future) {
            const published = await readPublishedMasters(tx, segment.publicationId);
            const differs =
              published.length !== masters.size ||
              published.some((row) => {
                const master = masters.get(row.id);
                return !master || lessonDiffers(row, master);
              });
            if (differs) throw draftPending(year.name);
          }
        }
        if (pending > 0) throw draftPending(null);
        await tx.publicationSettings.update({ where: { schoolId }, data: { publishMode: 'DIRECT' } });
        return { publishMode: 'DIRECT', baselines: [] };
      },
      { timeoutMs: 60_000 },
    );
    this.logger.log(`Publish mode switched [school=${schoolId}, mode=${result.publishMode}]`);
    return result;
  }

  /** The draft against the publication valid today (else ahead, else last). */
  async state(academicYearId: string, user: AuthenticatedUser): Promise<DraftState> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const { today } = await this.yearOf(tx, academicYearId);
      const mode = await publishModeOf(tx, schoolId);
      const publicationId = snapshotFor(effectiveSegments(await snapshotRanges(tx, academicYearId)), today);
      const published = publicationId ? await readPublishedMasters(tx, publicationId) : [];
      const masters = await readDraftMasters(tx, academicYearId);
      const before = new Map(published.map((row) => [row.id, row]));
      const after = new Map(masters.map((row) => [row.id, row]));
      return {
        academicYearId,
        publishMode: mode,
        publicationId,
        added: masters.filter((row) => !before.has(row.id)).map(view),
        changed: masters
          .filter((row) => before.has(row.id) && lessonDiffers(before.get(row.id)!, row))
          .map((row) => ({ before: view(before.get(row.id)!), after: view(row) })),
        removed: published.filter((row) => !after.has(row.id)).map(view),
        pendingRemovals: await tx.publicationPendingRemoval.count({ where: { academicYearId } }),
      };
    });
  }

  /**
   * Discard the draft: the masters go back to the snapshot valid today (else
   * ahead, else last), keeping their ids — a deleted lesson is recreated with
   * its own id and its published rows relinked, so nothing published moves.
   * A safety version ("Före kasserat utkast") is saved first, so a discard
   * can itself be undone by a restore.
   */
  async discard(academicYearId: string, user: AuthenticatedUser): Promise<{ restored: number; removed: number; safetyVersionId: string }> {
    const schoolId = requireSchoolId(user);
    const result = await this.prisma.withRls(
      user,
      async (tx) => {
        const mode = await enterPublication(tx, schoolId);
        if (mode !== 'DRAFT') throw notDraft();
        const { today } = await this.yearOf(tx, academicYearId);
        const publicationId = snapshotFor(effectiveSegments(await snapshotRanges(tx, academicYearId)), today);
        if (!publicationId) throw nothingPublished();
        const safety = await this.versions.snapshotInTransaction(tx, academicYearId, 'Före kasserat utkast', user);
        const published = await readPublishedMasters(tx, publicationId);
        const keep = new Set(published.map((row) => row.id));
        // The draft's own lessons go; they were never published, so the
        // trigger finds no published row of theirs to record.
        const { count: removed } = await tx.masterLesson.deleteMany({
          where: { academicYearId, id: { notIn: [...keep] } },
        });
        for (const row of published) {
          const data = {
            subjectId: row.subjectId,
            studentGroupId: row.studentGroupId,
            teacherId: row.teacherId,
            coTeacherId: row.coTeacherId,
            roomId: row.roomId,
            dayOfWeek: row.dayOfWeek,
            startTime: row.startTime,
            endTime: row.endTime,
            isLocked: row.isLocked,
            isGenerated: row.isGenerated,
            isParked: row.isParked,
            recurrence: row.recurrence,
            startDate: row.startDate,
            endDate: row.endDate,
          };
          await tx.masterLesson.upsert({
            where: { id: row.id },
            create: { id: row.id, schoolId, academicYearId, ...data },
            update: data,
          });
          await tx.masterLessonGroup.deleteMany({ where: { masterLessonId: row.id } });
          await tx.masterLessonStudent.deleteMany({ where: { masterLessonId: row.id } });
          if (row.extraGroups.length > 0) {
            await tx.masterLessonGroup.createMany({
              data: row.extraGroups.map((entry) => ({ schoolId, masterLessonId: row.id, studentGroupId: entry.studentGroupId })),
            });
          }
          if (row.participants.length > 0) {
            await tx.masterLessonStudent.createMany({
              data: row.participants.map((entry) => ({ schoolId, masterLessonId: row.id, studentId: entry.studentId })),
            });
          }
        }
        // A deleted lesson is back under its own id: its published rows are
        // its own again, and nothing is pending for it.
        const relink = await tx.publicationPendingRemoval.findMany({
          where: { academicYearId, masterLessonId: { in: [...keep] } },
          select: { calendarLessonId: true, masterLessonId: true },
        });
        for (const row of relink) {
          await tx.calendarLesson.update({ where: { id: row.calendarLessonId }, data: { masterLessonId: row.masterLessonId } });
        }
        if (relink.length > 0) {
          await tx.publicationPendingRemoval.deleteMany({
            where: { calendarLessonId: { in: relink.map((row) => row.calendarLessonId) } },
          });
        }
        await tx.scheduleChangeLog.create({
          data: {
            schoolId,
            academicYearId,
            actorId: user.userId ?? null,
            action: 'RESTORE',
            after: { discardedDraft: true, publicationId, restoredLessons: published.length, safetyVersionId: safety.id },
          },
        });
        return { restored: published.length, removed, safetyVersionId: safety.id };
      },
      { timeoutMs: 60_000 },
    );
    this.realtime.notifyMasterTimetableChanged(schoolId, { draft: true });
    return result;
  }

  /**
   * A DRAFT school's way to fill the calendar from what is PUBLISHED — after
   * a lov is narrowed or lifted, a closure is removed, or the calendar was
   * published only part of the way. POST /publications would publish the
   * draft too; this materialises each published segment's own snapshot over
   * its part of [validFrom, validTo], never a day that has begun, and records
   * a REFILL row that changes no validity. Its only gate is the meal's.
   */
  async refill(
    dto: { academicYearId: string; validFrom?: string; validTo?: string; acknowledgeWarnings?: boolean },
    user: AuthenticatedUser,
  ): Promise<{ result: PublishResult; gates: GateItem[]; publicationId: string }> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(
      user,
      async (tx) => {
        const mode = await enterPublication(tx, schoolId);
        if (mode !== 'DRAFT') throw notDraft();
        const { today, start, end } = await this.yearOf(tx, dto.academicYearId);
        const from = maxOf(dto.validFrom ?? today, today, start);
        const to = minOf(dto.validTo ?? end, end);
        if (from > to) throw new BadRequestException('Intervallet ligger före i dag eller utanför läsåret.');
        const gates = settleGates([await lunchFinding(tx, schoolId)], DEFAULT_GATE_POLICY);
        if (gateVerdict(gates).needsAcknowledgement && dto.acknowledgeWarnings !== true) {
          throw new ConflictException({
            message: 'Påfyllningen har varningar. Välj "Fyll på ändå" för att fortsätta.',
            code: PUBLISH_WARNINGS_UNACKNOWLEDGED,
            params: { warnings: gates.map((gate) => gate.code).join(',') },
          });
        }
        const segments: ValiditySegment[] = effectiveSegments(await snapshotRanges(tx, dto.academicYearId)).filter(
          (segment) => segment.to >= from && segment.from <= to,
        );
        if (segments.length === 0) throw nothingPublished();
        const now = new Date();
        const total: PublishResult = { created: 0, cancelled: 0, skipped: 0, fromDate: from, toDate: to };
        for (const segment of segments) {
          const templates: MaterialiseTemplate[] = (await readPublishedMasters(tx, segment.publicationId))
            .filter((row) => !row.isParked)
            .map((row) => ({
              id: row.id,
              subjectId: row.subjectId,
              studentGroupId: row.studentGroupId,
              teacherId: row.teacherId,
              coTeacherId: row.coTeacherId,
              extraGroups: row.extraGroups,
              participants: row.participants,
              roomId: row.roomId,
              recurrence: row.recurrence,
              startDate: row.startDate,
              endDate: row.endDate,
              dayOfWeek: row.dayOfWeek,
              startTime: row.startTime,
              endTime: row.endTime,
            }));
          if (templates.length === 0) continue;
          const result = await this.calendar.materialise(
            tx,
            schoolId,
            {
              academicYearId: dto.academicYearId,
              fromDate: segment.from > from ? segment.from : from,
              toDate: segment.to < to ? segment.to : to,
            },
            { templates, notBefore: now },
          );
          total.created += result.created;
          total.cancelled += result.cancelled;
          total.skipped += result.skipped;
        }
        // An unreversed bulk avbokning takes what the refill wrote into its range (S7).
        const year = await tx.academicYear.findUnique({
          where: { id: dto.academicYearId },
          select: { school: { select: { timezone: true } } },
        });
        const batched = await reapplyActiveBatches(tx, schoolId, dto.academicYearId, from, to, year?.school.timezone ?? 'Europe/Stockholm');
        total.cancelled += batched.length;
        const row = await tx.timetablePublication.create({
          data: {
            schoolId,
            academicYearId: dto.academicYearId,
            kind: 'REFILL',
            outcome: 'PUBLISHED',
            publishMode: 'DRAFT',
            validFrom: day(from),
            validTo: day(to),
            publishedByUserId: user.userId ?? null,
            created: total.created,
            cancelled: total.cancelled,
            skipped: total.skipped,
            gates: gates as unknown as object,
            acknowledgedWarnings: gates.some((gate) => gate.severity === 'WARN'),
          },
          select: { id: true },
        });
        return { result: total, gates, publicationId: row.id };
      },
      { timeoutMs: 120_000 },
    );
  }

  private async yearOf(
    tx: PrismaClient,
    academicYearId: string,
  ): Promise<{ today: string; start: string; end: string }> {
    const year = await tx.academicYear.findUnique({
      where: { id: academicYearId },
      select: { startDate: true, endDate: true, school: { select: { timezone: true } } },
    });
    if (!year) throw new NotFoundException('Academic year not found.');
    return {
      today: asDay(todayInZone(year.school.timezone)),
      start: asDay(year.startDate),
      end: asDay(year.endDate),
    };
  }
}

const maxOf = (...values: string[]): string => values.reduce((a, b) => (a > b ? a : b));
const minOf = (...values: string[]): string => values.reduce((a, b) => (a < b ? a : b));

function draftPending(yearName: string | null): ConflictException {
  return new ConflictException({
    message:
      (yearName
        ? `Utkastet för ${yearName} skiljer sig från det publicerade schemat. `
        : 'Borttagna lektioner väntar på att publiceras. ') +
      'Publicera utkastet från i dag till läsårets slut, eller kassera det, innan skolan går över till direkt publicering.',
    code: PUBLISH_DRAFT_PENDING,
    params: yearName ? { year: yearName } : {},
  });
}

function notDraft(): ConflictException {
  return new ConflictException({
    message: 'Skolan publicerar direkt; det finns inget utkast.',
    code: PUBLISH_NOT_DRAFT,
  });
}

function nothingPublished(): ConflictException {
  return new ConflictException({
    message: 'Inget schema med ögonblicksbild är publicerat för läsåret.',
    code: PUBLISH_NOTHING_PUBLISHED,
  });
}

