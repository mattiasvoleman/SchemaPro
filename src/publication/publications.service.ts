import { createHash } from 'node:crypto';
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
import { todayInZone } from '../common/utils/time';
import { CalendarService, publishWindow, type PublishResult } from '../calendar/calendar.service';
import type { PublishScheduleDto } from '../calendar/dto/publish-schedule.dto';
import { StaffingLoadService } from '../staffing/staffing-load.service';
import { readCheckPolicy } from '../staffing/staffing-enforcement';
import { TimplanCoverageService } from '../timplan/timplan-coverage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.service';
import { carryDraft, draftWindow } from './draft-publish';
import { reapplyActiveBatches } from './cancellation-batches.service';
import { readDraftMasters, snapshotMasters, type PublishedMaster } from './published-grundschema';
import { enterPublication } from './publish-mode';
import {
  DEFAULT_GATE_POLICY,
  GATE_POLICY_KEYS,
  gateVerdict,
  refusesAnything,
  settleGates,
  type GateFinding,
  type GateItem,
  type GatePolicy,
} from './publication-gates';
import {
  clashFinding,
  lessonFindings,
  lunchFinding,
  readGateLessons,
  unstaffedFinding,
  type GateLesson,
} from './publication-gates.reader';
import {
  classifyOverlap,
  effectiveSegments,
  nextDay,
  uncoveredRanges,
  type PublicationRange,
  type ValiditySegment,
} from './publication-validity';
import type {
  PublicationRangeDto,
  PublishTimetableDto,
  UpsertPublicationSettingsDto,
} from './dto/publication.dto';

export type PublishModeName = 'DIRECT' | 'DRAFT';

export interface PublicViewerSettings {
  publicViewerEnabled: boolean;
  publicGroups: boolean;
  publicTeachers: boolean;
  publicRooms: boolean;
  publicTeacherDisplay: 'NONE' | 'SIGNATURE' | 'NAME';
  publicShowMeals: boolean;
  publicMinGroupSize: number;
}

export const DEFAULT_VIEWER_SETTINGS: PublicViewerSettings = {
  publicViewerEnabled: false,
  publicGroups: false,
  publicTeachers: false,
  publicRooms: false,
  publicTeacherDisplay: 'NONE',
  publicShowMeals: true,
  publicMinGroupSize: 5,
};

const VIEWER_KEYS = Object.keys(DEFAULT_VIEWER_SETTINGS) as (keyof PublicViewerSettings)[];

export interface PublicationSettingsResponse extends GatePolicy, PublicViewerSettings {
  publishMode: PublishModeName;
  /** False when the school has no row: every value above is the default. */
  stored: boolean;
}

export interface PublicationRow {
  id: string;
  kind: 'PUBLISH' | 'LEGACY_PUBLISH' | 'BASELINE' | 'REFILL';
  outcome: 'PUBLISHED' | 'REFUSED';
  publishMode: PublishModeName;
  validFrom: string;
  validTo: string;
  publishedAt: string;
  publishedByUserId: string | null;
  created: number;
  cancelled: number;
  skipped: number;
  moved: number;
  removed: number;
  adopted: number;
  lessonCount: number | null;
  gates: GateItem[];
  acknowledgedWarnings: boolean;
}

export interface PublicationTimeline {
  academicYearId: string;
  /** The school's today: "valid now" is judged on it. */
  today: string;
  publications: PublicationRow[];
  /** Which publication is valid when, earliest first (publication-validity.ts). */
  segments: ValiditySegment[];
  /** The publication valid today, or null. */
  validNow: string | null;
}

export interface PublicationPreview {
  academicYearId: string;
  publishMode: PublishModeName;
  validFrom: string;
  validTo: string;
  /** What the calendar would answer: the materialiser's own counts, rolled back. */
  result: PublishResult;
  /** DRAFT: what carrying the draft over moves, removes and adopts. */
  draft?: DraftCounts;
  gates: GateItem[];
  refused: boolean;
  needsAcknowledgement: boolean;
  /** Send back as expectedDigest to publish exactly what was previewed. */
  digest: string;
}

export interface PublicationOutcome {
  publication: PublicationRow;
  result: PublishResult;
  draft?: DraftCounts;
  gates: GateItem[];
}

/** The problem codes this module answers with. */
export const PUBLISH_GATES_REFUSED = 'PUBLISH_GATES_REFUSED';
export const PUBLISH_WARNINGS_UNACKNOWLEDGED = 'PUBLISH_WARNINGS_UNACKNOWLEDGED';
export const PUBLISH_STALE = 'PUBLISH_STALE';
export const PUBLISH_MODE_DRAFT = 'PUBLISH_MODE_DRAFT';
export const PUBLISH_FROM_IN_PAST = 'PUBLISH_FROM_IN_PAST';
export const PUBLISH_RANGE_EMPTY = 'PUBLISH_RANGE_EMPTY';
export const PUBLISH_DRAFT_PENDING = 'PUBLISH_DRAFT_PENDING';
export const PUBLISH_NOT_DRAFT = 'PUBLISH_NOT_DRAFT';
export const PUBLISH_NOTHING_PUBLISHED = 'PUBLISH_NOTHING_PUBLISHED';
export const PUBLIC_TEACHERS_UNNAMED = 'PUBLIC_TEACHERS_UNNAMED';

/** What a DRAFT publish did beside materialising. */
export interface DraftCounts {
  moved: number;
  removed: number;
  adopted: number;
  /** Rows moved onto a closure and written CANCELLED. */
  cancelledByMove: number;
  /** Rows an unreversed bulk avbokning took again after the publish wrote them (S7). */
  cancelledByBatch: number;
}

/** Thrown inside a transaction to roll it back while carrying its answer out. */
class Rollback<T> extends Error {
  constructor(readonly value: T) {
    super('rollback');
  }
}

/** run's answer, or the answer a Rollback carried out of it. */
async function settle<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Rollback) return error.value as T;
    throw error;
  }
}

const asDay = (value: Date): string => value.toISOString().slice(0, 10);

const PUBLICATION_SELECT = {
  id: true,
  kind: true,
  outcome: true,
  publishMode: true,
  validFrom: true,
  validTo: true,
  publishedAt: true,
  publishedByUserId: true,
  created: true,
  cancelled: true,
  skipped: true,
  moved: true,
  removed: true,
  adopted: true,
  lessonCount: true,
  gates: true,
  acknowledgedWarnings: true,
} as const;

type StoredPublication = Prisma.TimetablePublicationGetPayload<{ select: typeof PUBLICATION_SELECT }>;

function toRow(row: StoredPublication): PublicationRow {
  return {
    ...row,
    validFrom: asDay(row.validFrom),
    validTo: asDay(row.validTo),
    publishedAt: row.publishedAt.toISOString(),
    gates: (row.gates as unknown as GateItem[]) ?? [],
  };
}

/**
 * Publicering: the validity-dated record of what was published, the school's
 * gate policy, and the gated publish itself (migration 20261011090000).
 *
 * DIRECT — the default, and every school that never opens the settings — is
 * today's behaviour exactly: POST /publications runs the gates and then
 * CalendarService.materialise over the window the old route would have
 * materialised, and writes one log row. The old POST /calendar/publish writes
 * what it always wrote and the same log row (LEGACY_PUBLISH); it asks the
 * gates only when the school has set one to REFUSE, so a school that has not
 * is refused nothing it could do before.
 */
@Injectable()
export class PublicationsService {
  private readonly logger = new Logger(PublicationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: CalendarService,
    private readonly coverage: TimplanCoverageService,
    private readonly load: StaffingLoadService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeService,
  ) {}

  // ---------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------

  async settings(user: AuthenticatedUser): Promise<PublicationSettingsResponse> {
    const schoolId = requireSchoolId(user);
    const row = await this.prisma.queryWithRls(user, (db) =>
      db.publicationSettings.findUnique({ where: { schoolId } }),
    );
    return toSettings(row);
  }

  async upsertSettings(
    dto: UpsertPublicationSettingsDto,
    user: AuthenticatedUser,
  ): Promise<PublicationSettingsResponse> {
    const schoolId = requireSchoolId(user);
    const gates: Partial<GatePolicy> = {};
    for (const key of GATE_POLICY_KEYS) {
      if (dto[key] !== undefined) gates[key] = dto[key];
    }
    const viewer: Partial<PublicViewerSettings> = {};
    for (const key of VIEWER_KEYS) {
      if (dto[key] !== undefined) (viewer as Record<string, unknown>)[key] = dto[key];
    }
    const row = await this.prisma.withRls(user, async (tx) => {
      const current = toSettings(await tx.publicationSettings.findUnique({ where: { schoolId } }));
      const merged = { ...current, ...viewer };
      // The table's CHECK, said with the fields named: a teacher's page that
      // names nobody would be a grid of anonymous lessons.
      if (merged.publicTeachers && merged.publicTeacherDisplay === 'NONE') {
        throw new BadRequestException({
          message: 'publicTeacherDisplay: lärarscheman visar läraren som signatur eller namn; välj ett av dem.',
          code: PUBLIC_TEACHERS_UNNAMED,
        });
      }
      return tx.publicationSettings.upsert({
        where: { schoolId },
        create: { schoolId, ...gates, ...viewer },
        update: { ...gates, ...viewer },
      });
    });
    return toSettings(row);
  }

  // ---------------------------------------------------------------------
  // Timeline
  // ---------------------------------------------------------------------

  async timeline(academicYearId: string, user: AuthenticatedUser): Promise<PublicationTimeline> {
    requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const year = await this.requireYear(tx, academicYearId);
      const rows = await tx.timetablePublication.findMany({
        where: { academicYearId },
        orderBy: [{ publishedAt: 'asc' }, { id: 'asc' }],
        select: PUBLICATION_SELECT,
      });
      const publications = rows.map(toRow);
      const segments = effectiveSegments(publications.filter(countsForValidity));
      const today = asDay(todayInZone(year.timezone));
      const now = segments.find((segment) => segment.from <= today && today <= segment.to);
      return {
        academicYearId,
        today,
        publications,
        segments,
        validNow: now?.publicationId ?? null,
      };
    });
  }

  // ---------------------------------------------------------------------
  // Preview and publish
  // ---------------------------------------------------------------------

  /**
   * Everything a publish would do and say, in a transaction that is rolled
   * back: the gates, and the materialiser's own counts (in DRAFT also what the
   * draft moves, adopts and removes). Nothing is written, not even a log row.
   */
  async preview(dto: PublicationRangeDto, user: AuthenticatedUser): Promise<PublicationPreview> {
    const schoolId = requireSchoolId(user);
    const external = await this.externalFindings(dto.academicYearId, schoolId, user);
    return settle<PublicationPreview>(() =>
      this.prisma.withRls(
        user,
        async (tx) => {
          const attempt = await this.attempt(tx, user, schoolId, dto, external, { dryRun: true });
          throw new Rollback<PublicationPreview>({
            academicYearId: dto.academicYearId,
            publishMode: attempt.context.mode,
            validFrom: attempt.context.validFrom,
            validTo: attempt.context.validTo,
            result: attempt.result,
            ...(attempt.draft ? { draft: attempt.draft } : {}),
            gates: attempt.gates,
            refused: attempt.verdict.refused,
            needsAcknowledgement: attempt.verdict.needsAcknowledgement,
            digest: attempt.context.digest,
          });
        },
        { timeoutMs: 120_000 },
      ),
    );
  }

  async publish(dto: PublishTimetableDto, user: AuthenticatedUser): Promise<PublicationOutcome> {
    const schoolId = requireSchoolId(user);
    const external = await this.externalFindings(dto.academicYearId, schoolId, user);
    type Attempt =
      | { kind: 'published'; outcome: PublicationOutcome; mode: PublishModeName }
      | { kind: 'refused'; gates: GateItem[]; context: PublishContext }
      | { kind: 'unacknowledged'; gates: GateItem[] };

    const attempt = await settle<Attempt>(() =>
      this.prisma.withRls(
        user,
        async (tx): Promise<Attempt> => {
          const run = await this.attempt(tx, user, schoolId, dto, external, {
            dryRun: false,
            expectedDigest: dto.expectedDigest,
          });
          const { context, result, gates, verdict, draft } = run;
          if (verdict.refused) throw new Rollback<Attempt>({ kind: 'refused', gates, context });
          if (verdict.needsAcknowledgement && dto.acknowledgeWarnings !== true) {
            throw new Rollback<Attempt>({ kind: 'unacknowledged', gates });
          }
          const row = await tx.timetablePublication.create({
            data: {
              schoolId,
              academicYearId: dto.academicYearId,
              kind: 'PUBLISH',
              outcome: 'PUBLISHED',
              publishMode: context.mode,
              validFrom: new Date(`${context.validFrom}T00:00:00.000Z`),
              validTo: new Date(`${context.validTo}T00:00:00.000Z`),
              publishedByUserId: user.userId ?? null,
              created: result.created,
              cancelled: result.cancelled + (draft?.cancelledByMove ?? 0) + (draft?.cancelledByBatch ?? 0) + run.batchCancelled,
              skipped: result.skipped,
              moved: draft?.moved ?? 0,
              removed: draft?.removed ?? 0,
              adopted: draft?.adopted ?? 0,
              lessonCount: run.masters ? run.masters.length : null,
              gates: gates as unknown as Prisma.InputJsonValue,
              acknowledgedWarnings: gates.some((gate) => gate.severity === 'WARN'),
            },
            select: PUBLICATION_SELECT,
          });
          if (run.masters) {
            await snapshotMasters(tx, { id: row.id, schoolId, academicYearId: dto.academicYearId }, run.masters);
            await this.tellClasses(tx, schoolId, run.masters, run.changedMasterIds ?? []);
          }
          return {
            kind: 'published',
            mode: context.mode,
            outcome: { publication: toRow(row), result, ...(draft ? { draft } : {}), gates },
          };
        },
        { timeoutMs: 120_000 },
      ),
    );

    if (attempt.kind === 'published') {
      const { publication } = attempt.outcome;
      this.logger.log(
        `Timetable published [publication=${publication.id}, ${publication.validFrom}..${publication.validTo}, created=${publication.created}, moved=${publication.moved}, removed=${publication.removed}]`,
      );
      // A DRAFT publish is the moment the staff room hears of the draft.
      if (attempt.mode === 'DRAFT') this.realtime.notifyMasterTimetableChanged(schoolId);
      return attempt.outcome;
    }
    if (attempt.kind === 'unacknowledged') {
      throw new ConflictException({
        message:
          'Publiceringen har varningar. Läs dem i förhandsgranskningen och välj "Publicera ändå" för att publicera.',
        code: PUBLISH_WARNINGS_UNACKNOWLEDGED,
        params: { warnings: attempt.gates.filter((gate) => gate.severity === 'WARN').map((gate) => gate.code).join(',') },
      });
    }
    const refusedRow = await this.logRefusal(user, schoolId, dto.academicYearId, 'PUBLISH', attempt.context, attempt.gates);
    throw refusedConflict(attempt.gates, refusedRow);
  }

  /**
   * One attempt, preview or publish, inside the caller's transaction: the
   * context (and in DRAFT the exclusive publication lock, before the masters
   * are read), the gates, the calendar work, and the gates that can only be
   * known after it. Nothing here writes the log or the snapshot.
   */
  private async attempt(
    tx: PrismaClient,
    user: AuthenticatedUser,
    schoolId: string,
    dto: PublicationRangeDto,
    external: GateFinding[],
    options: { dryRun: boolean; expectedDigest?: string },
  ): Promise<{
    context: PublishContext;
    result: PublishResult;
    draft?: DraftCounts;
    masters?: PublishedMaster[];
    changedMasterIds?: string[];
    /** DIRECT: rows an unreversed bulk avbokning took again (DRAFT carries it in `draft`). */
    batchCancelled: number;
    gates: GateItem[];
    verdict: ReturnType<typeof gateVerdict>;
  }> {
    const context = await this.contextOf(tx, schoolId, dto);
    if (options.expectedDigest && options.expectedDigest !== context.digest) {
      throw new ConflictException({
        message:
          'Grundschemat eller publiceringarna har ändrats sedan förhandsgranskningen. Granska igen innan du publicerar.',
        code: PUBLISH_STALE,
      });
    }
    const findings: GateFinding[] = [...external, ...(await this.internalFindings(tx, user, context))];
    const empty: PublishResult = { created: 0, cancelled: 0, skipped: 0, fromDate: context.validFrom, toDate: context.validTo };
    let result = empty;
    let draft: DraftCounts | undefined;
    let masters: PublishedMaster[] | undefined;
    let changedMasterIds: string[] | undefined;
    let batchCancelled = 0;
    try {
      if (context.mode === 'DRAFT') {
        const now = new Date();
        masters = await readDraftMasters(tx, context.year.id);
        const carry = await carryDraft(tx, {
          schoolId,
          academicYearId: context.year.id,
          timezone: context.year.timezone,
          validFrom: context.validFrom,
          validTo: context.validTo,
          masters,
          now,
        });
        result = await this.calendar.materialise(tx, schoolId, this.windowDto(context), { notBefore: now });
        draft = {
          moved: carry.moved,
          removed: carry.removed,
          adopted: carry.adopted,
          cancelledByMove: carry.cancelled,
          cancelledByBatch: (
            await reapplyActiveBatches(tx, schoolId, context.year.id, context.validFrom, context.validTo, context.year.timezone)
          ).length,
        };
        changedMasterIds = carry.changedMasterIds;
        findings.push(
          { code: 'PUB_WEEK_SPLIT', count: carry.weekSplit.length, entries: carry.weekSplit, params: { validFrom: context.validFrom } },
          {
            code: 'PUB_DAY_OPS_LOST',
            count: carry.lostDayOperations.length,
            entries: carry.lostDayOperations.map((operation) => ({
              label: `${operation.date}: ${[
                operation.substitute ? 'vikarie' : null,
                operation.roomChanged ? 'ändrad sal' : null,
                operation.note ? 'anteckning' : null,
              ]
                .filter(Boolean)
                .join(', ')}`,
              calendarLessonId: operation.calendarLessonId,
            })),
          },
        );
      } else {
        result = await this.calendar.materialise(tx, schoolId, this.windowDto(context));
        // A bulk avbokning still in force takes what this materialised into
        // its range (S7). A school that never made one asks one statement.
        const batched = await reapplyActiveBatches(
          tx,
          schoolId,
          context.year.id,
          context.validFrom,
          context.validTo,
          context.year.timezone,
        );
        batchCancelled = batched.length;
      }
    } catch (error) {
      if (!options.dryRun || error instanceof Rollback) throw error;
      // The database refused the dry run (a booked room, a key): the publish
      // would be refused the same way, so it is a REFUSE gate rather than an
      // error page.
      const message = error instanceof Error ? error.message : String(error);
      findings.push({ code: 'PUB_CALENDAR_REFUSED', count: 1, entries: [{ label: message.slice(0, 300) }] });
      result = empty;
    }
    const changedNothing =
      result.created + result.cancelled + (draft ? draft.moved + draft.removed + draft.adopted : 0) === 0;
    findings.push({ code: 'PUB_NOTHING_TO_PUBLISH', count: changedNothing ? 1 : 0, info: true });
    const gates = settleGates(findings, context.policy);
    return { context, result, draft, masters, changedMasterIds, batchCancelled, gates, verdict: gateVerdict(gates) };
  }

  /**
   * A DRAFT publish tells each class whose published lessons moved or went,
   * as DIRECT's update() tells it per edit — once per recipient here, with
   * the first changed lesson that reaches them, since one publish may carry
   * many edits and a notice per edit would be a pile of them.
   */
  private async tellClasses(
    tx: PrismaClient,
    schoolId: string,
    masters: readonly PublishedMaster[],
    changedMasterIds: readonly string[],
  ): Promise<void> {
    const byId = new Map(masters.map((master) => [master.id, master]));
    const told = new Set<string>();
    for (const id of changedMasterIds) {
      const master = byId.get(id);
      if (!master) continue;
      const recipients = (
        await this.notifications.recipientsForGroups(tx, [
          master.studentGroupId,
          ...master.extraGroups.map((entry) => entry.studentGroupId),
        ])
      ).filter((userId) => !told.has(userId));
      if (recipients.length === 0) continue;
      for (const userId of recipients) told.add(userId);
      await this.notifications.notifyUsers(tx, {
        schoolId,
        userIds: recipients,
        type: 'SCHEDULE_CHANGED',
        meta: {
          subjectName: master.subject.name,
          dayOfWeek: master.dayOfWeek,
          startTime: master.startTime.toISOString().slice(11, 16),
          endTime: master.endTime.toISOString().slice(11, 16),
        },
      });
    }
  }

  /**
   * The old POST /calendar/publish: the same writes and the same answer as
   * before, plus a LEGACY_PUBLISH log row in the same transaction. Its gates
   * are asked only when the school has set one to REFUSE — a school that has
   * not set one is refused nothing it could do before, and pays nothing for
   * checks it would only be warned about.
   */
  async legacyPublish(dto: PublishScheduleDto, user: AuthenticatedUser): Promise<PublishResult> {
    const schoolId = requireSchoolId(user);
    const policy = await this.prisma.queryWithRls(user, (db) =>
      db.publicationSettings.findUnique({ where: { schoolId } }),
    );
    if (toSettings(policy).publishMode === 'DRAFT') {
      // The old route materialises the masters — in DRAFT, the draft. It has
      // no validity, no gate and no snapshot to keep a draft apart from what
      // is published, so a DRAFT school publishes through POST /publications.
      throw new ConflictException({
        message: 'Skolan publicerar via utkast. Publicera från Publicering, där utkastet granskas först.',
        code: PUBLISH_MODE_DRAFT,
      });
    }
    const gated = refusesAnything(toSettings(policy));
    const external = gated ? await this.externalFindings(dto.academicYearId, schoolId, user) : [];

    type Attempt = { kind: 'published'; result: PublishResult } | { kind: 'refused'; gates: GateItem[]; context: PublishContext };
    const attempt = await settle<Attempt>(() =>
      this.prisma.withRls(
        user,
        async (tx): Promise<Attempt> => {
          const year = await this.requireYear(tx, dto.academicYearId);
          const window = publishWindow(year, dto);
          let gates: GateItem[] = [];
          if (gated) {
            const context = await this.contextOf(tx, schoolId, {
              academicYearId: dto.academicYearId,
              validFrom: window.fromDate,
              validTo: window.toDate,
            });
            gates = settleGates([...external, ...(await this.internalFindings(tx, user, context))], context.policy);
            if (gateVerdict(gates).refused) throw new Rollback<Attempt>({ kind: 'refused', gates, context });
          }
          const result = await this.calendar.materialise(tx, schoolId, dto);
          await tx.timetablePublication.create({
            data: {
              schoolId,
              academicYearId: dto.academicYearId,
              kind: 'LEGACY_PUBLISH',
              outcome: 'PUBLISHED',
              publishMode: 'DIRECT',
              validFrom: new Date(`${result.fromDate}T00:00:00.000Z`),
              validTo: new Date(`${result.toDate}T00:00:00.000Z`),
              publishedByUserId: user.userId ?? null,
              created: result.created,
              cancelled: result.cancelled,
              skipped: result.skipped,
              gates: gates as unknown as Prisma.InputJsonValue,
            },
            select: { id: true },
          });
          return { kind: 'published', result };
        },
        { timeoutMs: 120_000 },
      ),
    );
    if (attempt.kind === 'published') return attempt.result;
    const refusedRow = await this.logRefusal(
      user,
      schoolId,
      dto.academicYearId,
      'LEGACY_PUBLISH',
      attempt.context,
      attempt.gates,
    );
    throw refusedConflict(attempt.gates, refusedRow);
  }

  // ---------------------------------------------------------------------

  private async logRefusal(
    user: AuthenticatedUser,
    schoolId: string,
    academicYearId: string,
    kind: 'PUBLISH' | 'LEGACY_PUBLISH',
    context: PublishContext,
    gates: GateItem[],
  ): Promise<string> {
    const row = await this.prisma.withRls(user, (tx) =>
      tx.timetablePublication.create({
        data: {
          schoolId,
          academicYearId,
          kind,
          outcome: 'REFUSED',
          publishMode: context.mode,
          validFrom: new Date(`${context.validFrom}T00:00:00.000Z`),
          validTo: new Date(`${context.validTo}T00:00:00.000Z`),
          publishedByUserId: user.userId ?? null,
          gates: gates as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      }),
    );
    this.logger.log(`Timetable publish refused by the school's gates [publication=${row.id}]`);
    return row.id;
  }

  private async requireYear(
    tx: PrismaClient,
    academicYearId: string,
  ): Promise<{ id: string; startDate: Date; endDate: Date; timezone: string }> {
    const year = await tx.academicYear.findUnique({
      where: { id: academicYearId },
      select: { id: true, startDate: true, endDate: true, school: { select: { timezone: true } } },
    });
    if (!year) throw new NotFoundException('Academic year not found.');
    return { id: year.id, startDate: year.startDate, endDate: year.endDate, timezone: year.school.timezone };
  }

  /** The window, the policy, the mode and the digest, read once per attempt. */
  private async contextOf(tx: PrismaClient, schoolId: string, dto: PublicationRangeDto): Promise<PublishContext> {
    const year = await this.requireYear(tx, dto.academicYearId);
    const settings = toSettings(await tx.publicationSettings.findUnique({ where: { schoolId } }));
    const today = asDay(todayInZone(year.timezone));
    let window: { fromDate: string; toDate: string };
    let pendingIds: string[] = [];
    if (settings.publishMode === 'DRAFT') {
      // The exclusive publication lock, before the masters are read: no
      // grundschema write lands between what this reads and what it writes
      // (publish-mode.ts). A DIRECT publish takes none.
      await enterPublication(tx, schoolId);
      const draft = draftWindow({ start: asDay(year.startDate), end: asDay(year.endDate) }, today, dto);
      if ('error' in draft) {
        throw new BadRequestException({
          message:
            draft.error === 'PAST'
              ? `Ett utkast publiceras från i dag (${today}) eller senare; det som redan har hänt skrivs aldrig om.`
              : 'Giltighetsintervallet är tomt.',
          code: draft.error === 'PAST' ? PUBLISH_FROM_IN_PAST : PUBLISH_RANGE_EMPTY,
          params: { today },
        });
      }
      window = { fromDate: draft.validFrom, toDate: draft.validTo };
      pendingIds = (
        await tx.publicationPendingRemoval.findMany({
          where: { academicYearId: dto.academicYearId },
          select: { calendarLessonId: true },
          orderBy: { calendarLessonId: 'asc' },
        })
      ).map((row) => row.calendarLessonId);
    } else {
      window = publishWindow(year, { fromDate: dto.validFrom, toDate: dto.validTo });
    }
    const lessons = await readGateLessons(tx, dto.academicYearId);
    const publications = await tx.timetablePublication.findMany({
      where: { academicYearId: dto.academicYearId, outcome: 'PUBLISHED' },
      orderBy: [{ publishedAt: 'asc' }, { id: 'asc' }],
      select: { id: true, kind: true, publishedAt: true, validFrom: true, validTo: true },
    });
    const ranges: PublicationRange[] = publications
      .filter((row) => row.kind !== 'REFILL')
      .map((row) => ({ id: row.id, publishedAt: row.publishedAt, validFrom: asDay(row.validFrom), validTo: asDay(row.validTo) }));
    return {
      schoolId,
      year: { ...year, start: asDay(year.startDate), end: asDay(year.endDate) },
      mode: settings.publishMode,
      policy: settings,
      validFrom: window.fromDate,
      validTo: window.toDate,
      today,
      lessons,
      ranges,
      digest: digestOf(dto.academicYearId, window, lessons, ranges, pendingIds),
    };
  }

  private windowDto(context: PublishContext): PublishScheduleDto {
    return { academicYearId: context.year.id, fromDate: context.validFrom, toDate: context.validTo };
  }

  /** The checks read inside the publish's own transaction. */
  private async internalFindings(
    tx: PrismaClient,
    user: AuthenticatedUser,
    context: PublishContext,
  ): Promise<GateFinding[]> {
    const findings: GateFinding[] = [
      await clashFinding(tx, user, context.year.id, context.lessons),
      ...lessonFindings(context.lessons),
      await unstaffedFinding(tx, context.year.id),
      await lunchFinding(tx, context.schoolId),
    ];
    if (context.mode === 'DIRECT' && context.validFrom < context.today) {
      findings.push({
        code: 'PUB_FROM_IN_PAST',
        count: 1,
        params: { validFrom: context.validFrom, today: context.today },
        entries: [{ label: `${context.validFrom} – ${nextDay(context.today, -1)}`, from: context.validFrom, to: nextDay(context.today, -1) }],
      });
    }
    findings.push(...(await this.rangeFindings(tx, context)));
    return findings;
  }

  /** PUB_RANGE_OVERLAP and PUB_RANGE_GAP, from the publications already made. */
  private async rangeFindings(tx: PrismaClient, context: PublishContext): Promise<GateFinding[]> {
    const before = effectiveSegments(context.ranges);
    const overlaps = classifyOverlap(before, context.validFrom, context.validTo, context.today);
    const split = overlaps.some((overlap) => overlap.kind === 'SPLIT');
    const findings: GateFinding[] = [
      {
        code: 'PUB_RANGE_OVERLAP',
        count: overlaps.length,
        // DIRECT republishes are idempotent and overlap by nature; in DRAFT
        // only a range that leaves an older one valid on both sides warns.
        info: context.mode === 'DIRECT' || !split,
        entries: overlaps.map((overlap) => ({
          label: `${overlap.from} – ${overlap.to} (${overlap.kind})`,
          from: overlap.from,
          to: overlap.to,
        })),
      },
    ];

    // The school days the new range leaves uncovered next to a neighbour.
    const after = effectiveSegments([
      ...context.ranges,
      { id: '__new__', publishedAt: new Date(8.64e15), validFrom: context.validFrom, validTo: context.validTo },
    ]);
    const horizonFrom = context.today > context.year.start ? context.today : context.year.start;
    if (horizonFrom <= context.year.end) {
      const gaps = uncoveredRanges(after, horizonFrom, context.year.end).filter((gap) => {
        const touchesBefore = nextDay(gap.to) === context.validFrom && after.some((s) => s.to === nextDay(gap.from, -1));
        const touchesAfter = nextDay(gap.from, -1) === context.validTo && after.some((s) => s.from === nextDay(gap.to));
        return touchesBefore || touchesAfter;
      });
      if (gaps.length > 0) {
        const breaks = await tx.schoolBreak.findMany({
          where: { academicYearId: context.year.id, minGradeLevel: null, maxGradeLevel: null },
          select: { startDate: true, endDate: true },
        });
        const isSchoolDay = (date: string): boolean => {
          const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
          if (weekday === 0 || weekday === 6) return false;
          return !breaks.some((entry) => asDay(entry.startDate) <= date && date <= asDay(entry.endDate));
        };
        let days = 0;
        const entries = [];
        for (const gap of gaps) {
          let count = 0;
          for (let date = gap.from; date <= gap.to; date = nextDay(date)) if (isSchoolDay(date)) count++;
          if (count > 0) entries.push({ label: `${gap.from} – ${gap.to}: ${count} skoldagar`, from: gap.from, to: gap.to });
          days += count;
        }
        findings.push({ code: 'PUB_RANGE_GAP', count: days, entries, params: { days } });
      }
    }
    return findings;
  }

  /**
   * The checks that are another module's whole report, asked through its
   * public method so the gate reads what the admin's own page shows:
   *
   *   PUB_UNPLACED         timplan layer 2 (schemalagt mot planerat): lines
   *                        UNSCHEDULED or SHORT;
   *   PUB_TIMPLAN          timplan layer 1 (planerat mot timplan): its warnings;
   *   PUB_STAFFING_REFUSE  what the staffing policy's REFUSE modes would
   *                        refuse today: unqualified rows under a REFUSE
   *                        qualificationMode, teachers OVER target under a
   *                        REFUSE overAllocationMode. Asked only then.
   */
  private async externalFindings(
    academicYearId: string,
    schoolId: string,
    user: AuthenticatedUser,
  ): Promise<GateFinding[]> {
    const findings: GateFinding[] = [];
    const scheduled = await this.coverage.scheduled({ academicYearId }, user);
    const short = scheduled.groups.flatMap((group) =>
      group.lines
        .filter((line) => line.status === 'UNSCHEDULED' || line.status === 'SHORT')
        .map((line) => ({ group, line })),
    );
    if (short.length > 0) {
      const names = await this.prisma.queryWithRls(user, (db) =>
        db.subject.findMany({ where: { id: { in: short.map((s) => s.line.subjectId) } }, select: { id: true, name: true } }),
      );
      const groups = await this.prisma.queryWithRls(user, (db) =>
        db.studentGroup.findMany({ where: { id: { in: short.map((s) => s.group.studentGroupId) } }, select: { id: true, name: true } }),
      );
      const subjectName = new Map(names.map((row) => [row.id, row.name]));
      const groupName = new Map(groups.map((row) => [row.id, row.name]));
      findings.push({
        code: 'PUB_UNPLACED',
        count: short.length,
        entries: short.map(({ group, line }) => ({
          label: `${subjectName.get(line.subjectId) ?? '?'} för ${groupName.get(group.studentGroupId) ?? '?'}: ${line.scheduledMinutesPerWeek} av ${line.plannedMinutesPerWeek} min/vecka`,
          requirementId: line.requirementIds[0],
        })),
      });
    }
    const planned = await this.coverage.planned({ academicYearId }, user);
    const warnings = planned.verdicts.filter((verdict) => verdict.severity === 'warning');
    findings.push({
      code: 'PUB_TIMPLAN',
      count: warnings.length,
      entries: warnings.map((verdict) => ({ label: verdict.message })),
    });

    const policy = await this.prisma.withRls(user, (tx) => readCheckPolicy(tx as PrismaClient, schoolId));
    if (policy.qualificationMode === 'REFUSE' || policy.overAllocationMode === 'REFUSE') {
      const report = await this.load.load(academicYearId, 'planned', user);
      const unqualified = policy.qualificationMode === 'REFUSE' ? report.unqualifiedAssignments : [];
      const over = policy.overAllocationMode === 'REFUSE' ? report.teachers.filter((row) => row.status === 'OVER') : [];
      const ids = [...new Set([...unqualified.map((row) => row.userId), ...over.map((row) => row.userId)])];
      const people = ids.length
        ? await this.prisma.queryWithRls(user, (db) =>
            db.user.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true } }),
          )
        : [];
      const nameOf = new Map(people.map((row) => [row.id, `${row.firstName} ${row.lastName}`]));
      findings.push({
        code: 'PUB_STAFFING_REFUSE',
        count: unqualified.length + over.length,
        entries: [
          ...unqualified.map((row) => ({
            label: `${nameOf.get(row.userId) ?? '?'} saknar behörighet: ${row.subjectName} för ${row.groupName}`,
            teacherId: row.userId,
            requirementId: row.requirementId,
          })),
          ...over.map((row) => ({
            label: `${nameOf.get(row.userId) ?? '?'} över mål: ${row.countedMinutesPerWeek} av ${row.targetMinutesPerWeek ?? '?'} min/vecka`,
            teacherId: row.userId,
          })),
        ],
      });
    }
    return findings;
  }
}

/** What one attempt reads before it judges or writes. */
export interface PublishContext {
  schoolId: string;
  year: { id: string; startDate: Date; endDate: Date; timezone: string; start: string; end: string };
  mode: PublishModeName;
  policy: GatePolicy;
  validFrom: string;
  validTo: string;
  today: string;
  lessons: GateLesson[];
  ranges: PublicationRange[];
  digest: string;
}

function toSettings(
  row: (GatePolicy & Partial<PublicViewerSettings> & { publishMode: PublishModeName }) | null,
): PublicationSettingsResponse {
  const policy = { ...DEFAULT_GATE_POLICY };
  if (row) for (const key of GATE_POLICY_KEYS) policy[key] = row[key];
  const viewer = { ...DEFAULT_VIEWER_SETTINGS };
  if (row) for (const key of VIEWER_KEYS) if (row[key] !== undefined) (viewer as Record<string, unknown>)[key] = row[key];
  return { publishMode: row?.publishMode ?? 'DIRECT', ...policy, ...viewer, stored: row != null };
}

/** Which log rows decide validity: every PUBLISHED one but a refill of an older one. */
function countsForValidity(row: PublicationRow): boolean {
  return row.outcome === 'PUBLISHED' && row.kind !== 'REFILL';
}

function refusedConflict(gates: GateItem[], publicationId: string): ConflictException {
  return new ConflictException({
    message:
      'Skolans publiceringsregler stoppar publiceringen. Förhandsgranska för att se vilka kontroller som stoppar den.',
    code: PUBLISH_GATES_REFUSED,
    params: {
      refused: gates.filter((gate) => gate.severity === 'REFUSE').map((gate) => gate.code).join(','),
      publicationId,
    },
  });
}

/**
 * What a preview promised: the year, the window, every lesson as the gates
 * read it, and the publications already made. A publish whose digest differs
 * would publish something the admin did not preview.
 */
function digestOf(
  academicYearId: string,
  window: { fromDate: string; toDate: string },
  lessons: readonly GateLesson[],
  ranges: readonly PublicationRange[],
  pendingIds: readonly string[] = [],
): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([academicYearId, window.fromDate, window.toDate]));
  for (const lesson of lessons) {
    hash.update(
      JSON.stringify([
        lesson.id,
        lesson.subjectId,
        lesson.studentGroupId,
        lesson.teacherId,
        lesson.coTeacherId,
        lesson.roomId,
        lesson.dayOfWeek,
        lesson.startTime,
        lesson.endTime,
        lesson.recurrence,
        lesson.startDate,
        lesson.endDate,
        lesson.isParked,
        lesson.extraGroupIds,
        lesson.studentIds,
      ]),
    );
  }
  hash.update(JSON.stringify(ranges.map((range) => range.id)));
  if (pendingIds.length > 0) hash.update(JSON.stringify(pendingIds));
  return hash.digest('hex');
}
