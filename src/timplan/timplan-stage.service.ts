import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type SchoolForm } from '@prisma/client';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { todayInZone } from '../common/utils/time';
import { cohortNotice, htOf, type CohortNoticeRow } from '../common/timplan-cohorts';
import { planningWeeksInTenths } from '../common/timplan-coverage';
import { deliveredDatesToAsk, type DeliveredMasterLesson } from '../common/timplan-delivered';
import {
  computePupilStages,
  summarizeClassStages,
  type ClassStageSummary,
  type StageCoverage,
  type StageInput,
  type StagePupil,
  type StagePupilInput,
  type StageVerdict,
  type StageYearCells,
} from '../common/timplan-stage';
import { readPlannedRows } from './timplan-coverage.service';
import { readSegmentedDeliveredRows } from './timplan-delivered.sql';
import { publishBreaksOf, readPublishClosures } from './publish-context';
import {
  boundariesOf,
  futureBlocks,
  recordedBlocksOfYear,
  regimeOfBlocks,
  type FuturePlan,
  type StageSegment,
  type StageYearRead,
} from './timplan-stage-input';
import { describeStageVerdict } from './timplan-stage-messages';

const asDay = (value: Date): string => value.toISOString().slice(0, 10);
const asDayOrNull = (value: Date | null): string | null => (value === null ? null : asDay(value));
const asClock = (value: Date): string => value.toISOString().slice(11, 16);

/** The longest stage there is (HKK's låg- och mellanstadium in specialskolan, åk 1–7): how far back a year is read. */
const MAX_STAGE_YEARS = 7;
/** Long enough for a school of 2 000 pupils over seven years; withRls's default is 15 s. */
const STAGE_TIMEOUT_MS = 60_000;

export const TIMPLAN_STAGE_NOT_ACTIVE_YEAR = 'TIMPLAN_STAGE_NOT_ACTIVE_YEAR';
export const TIMPLAN_STAGE_PUBLISH_IN_PROGRESS = 'TIMPLAN_STAGE_PUBLISH_IN_PROGRESS';

export interface StagePublicationSummary {
  academicYearId: string;
  publishedAt: string;
  publishedByUserId: string | null;
  asOfDate: string;
  pupils: number;
}

export interface TimplanStageResponse {
  academicYearId: string;
  asOfDate: string;
  isActiveYear: boolean;
  /** Per home class and current stage, per cell: min / median / max. No pupil id. */
  classes: ClassStageSummary[];
  /** The drill-down (studentGroupId): every pupil of the class, ids only. Null otherwise. */
  pupils: (Omit<StagePupil, 'verdicts'> & { verdicts: (StageVerdict & { message: string })[] })[] | null;
  /** How many pupils carry each verdict, school-wide or in the class. */
  verdictCounts: { code: StageVerdict['code']; severity: StageVerdict['severity']; pupils: number }[];
  /** "Timplaner per årskull": which version each cohort's stages are judged against. */
  cohorts: CohortNoticeRow[];
  publication: StagePublicationSummary | null;
}

export interface TeachingTimeLine {
  subjectCode: string;
  subjectName: string;
  nationalHours: number | null;
  plannedHours: number;
  outcomeHours: number;
  projectedHours: number;
  status: string;
  projectedStatus: string;
}

export interface TeachingTimeStage {
  stage: string;
  versionCode: string | null;
  distributionPublished: boolean;
  gradesFrom: number;
  gradesTo: number;
  complete: boolean;
  recordedFrom: string | null;
  plannedGrades: number[];
  /** Grades with no class history. */
  unrecordedGrades: number[];
  /** Grades ahead that no plan carries yet. */
  unplannedGrades: number[];
  backfilled: boolean;
  /** When backfilled: the day the class history began; the class before it is assumed. */
  historyFrom: string | null;
  lines: TeachingTimeLine[];
}

export interface TeachingTimeCardResponse {
  statement: {
    studentId: string;
    academicYearId: string;
    /** The school's day the statement was computed and published: "Uppdaterad {asOfDate}". */
    asOfDate: string;
    stages: TeachingTimeStage[];
  } | null;
}

/**
 * Stadiesummor över läsår (timplan P4): per pupil and stadium, hours across
 * the stadium's läsår — planned, delivered and projected — against the
 * national hours of the lydelse that applies to the pupil
 * (src/common/timplan-stage.ts), and the statement the school publishes for
 * the pupils' and guardians' cards.
 *
 * WHAT IS READ, in one transaction under the admin's RLS: the active year;
 * every läsår; the active year's pupils (their open segments) and every
 * segment of theirs; then, per läsår they were enrolled in (back to the
 * longest stage, seven years), P2's rows (readPlannedRows), the year's
 * teaching-group memberships of these pupils, P3's statements with the
 * audiences cut at the year's move dates (segmentedAudienceStatement), the
 * credits and dated closures, and — the active year only — the grundschema;
 * the national reference data; the plans the future grades follow. The
 * number of statements is fixed per läsår, never per pupil (the probe (u5)
 * counts it). Nothing here classifies a lesson: held time is P3's ONE
 * definition (timplan-delivered.sql.ts) and the arithmetic P2's and P3's.
 *
 * ONLY THE HOME CLASS HAS HISTORY. Teaching-group membership
 * (StudentGroupMember) is today's set: StudentGroupsService.setMembers
 * replaces it (deleteMany + createMany), and nothing records when a pupil
 * joined or left. Every window and every past year therefore reads the
 * groups a pupil is in NOW: a pupil who left the Spanska group in March of a
 * recorded year loses that group's whole year, one who joined mid-year gets
 * all of it. This is P2's and P3's own reading of a group (inherited, not
 * new); it can create or hide a finding in an M2 or nivågrupp cell of a
 * complete stage. A membership history is a later step.
 *
 * THE ACTIVE YEAR ONLY. The view answers for the active year as of the
 * school's today; any other year answers isActiveYear: false and nothing
 * else (no R6 refusal is added: no roster basis is asked).
 *
 * SCHOOL_ADMIN only for the view and the statement (the controller); a
 * teacher's coverage strips every pupil figure, and the stage view is per
 * pupil by nature. The card reads the statement under the CALLER's RLS:
 * TimplanStatements' arms give a pupil their own rows and a guardian their
 * children's, and nothing else exists to read.
 *
 * PUPIL IDS ONLY, NEVER NAMES, and nothing here logs a pupil.
 */
@Injectable()
export class TimplanStageService {
  private readonly logger = new Logger(TimplanStageService.name);

  constructor(private readonly prisma: PrismaService) {}

  async overview(
    query: { academicYearId: string; studentGroupId?: string },
    user: AuthenticatedUser,
  ): Promise<TimplanStageResponse> {
    requireSchoolId(user);
    const now = new Date();
    try {
      return await this.prisma.withRls(
        user,
        async (tx) => {
          const computed = await computeStages(tx, query.academicYearId, now, query.studentGroupId ?? null);
          const publication = await readPublication(tx);
          if (!computed.isActiveYear) {
            return {
              academicYearId: query.academicYearId,
              asOfDate: computed.asOfDate,
              isActiveYear: false,
              classes: [],
              pupils: null,
              verdictCounts: [],
              cohorts: [],
              publication,
            };
          }
          const { coverage, subjectNames } = computed;
          const counts = new Map<string, { code: StageVerdict['code']; severity: StageVerdict['severity']; pupils: Set<string> }>();
          for (const pupil of coverage.pupils) {
            for (const verdict of pupil.verdicts) {
              const key = `${verdict.code}:${verdict.severity}`;
              const entry = counts.get(key) ?? { code: verdict.code, severity: verdict.severity, pupils: new Set<string>() };
              entry.pupils.add(pupil.pupilId);
              counts.set(key, entry);
            }
          }
          return {
            academicYearId: query.academicYearId,
            asOfDate: computed.asOfDate,
            isActiveYear: true,
            classes: summarizeClassStages(coverage),
            pupils:
              query.studentGroupId === undefined
                ? null
                : coverage.pupils.map((pupil) => ({
                    ...pupil,
                    verdicts: pupil.verdicts.map((verdict) => ({ ...verdict, message: describeStageVerdict(verdict, subjectNames) })),
                  })),
            verdictCounts: [...counts.values()]
              .map((entry) => ({ code: entry.code, severity: entry.severity, pupils: entry.pupils.size }))
              .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : a.severity < b.severity ? -1 : 1)),
            cohorts: computed.cohorts,
            publication,
          };
        },
        { timeoutMs: STAGE_TIMEOUT_MS },
      );
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      rethrowPrismaError(error);
    }
  }

  /**
   * Publishes the school's statement for the active year: the CURRENT stage
   * of every active pupil, cell by cell, replacing the previous statement in
   * one transaction. The publication row is locked first (FOR UPDATE), so a
   * second POST waits and then replaces; two POSTs racing on a school with no
   * statement yet meet the unique key, and the second is 409
   * TIMPLAN_STAGE_PUBLISH_IN_PROGRESS.
   */
  async publish(
    dto: { academicYearId: string },
    user: AuthenticatedUser,
  ): Promise<StagePublicationSummary & { rows: number }> {
    const schoolId = requireSchoolId(user);
    const now = new Date();
    try {
      const result = await this.prisma.withRls(
        user,
        async (tx) => {
          await tx.$queryRaw`
            SELECT "id" FROM "TimplanStatementPublications"
             WHERE "schoolId" = ${schoolId}::uuid
               FOR UPDATE
          `;
          const computed = await computeStages(tx, dto.academicYearId, now, null);
          if (!computed.isActiveYear) {
            throw new ConflictException({
              message: 'Undervisningstiden publiceras för det aktiva läsåret. Välj det och publicera igen.',
              code: TIMPLAN_STAGE_NOT_ACTIVE_YEAR,
            });
          }
          const rows = statementRows(computed.coverage);
          await tx.timplanStatementPublication.deleteMany({});
          const publication = await tx.timplanStatementPublication.create({
            data: {
              schoolId,
              academicYearId: dto.academicYearId,
              publishedByUserId: user.userId ?? null,
              asOfDate: new Date(`${computed.asOfDate}T00:00:00.000Z`),
              pupils: computed.coverage.pupils.length,
            },
            select: { id: true, publishedAt: true },
          });
          if (rows.length > 0) {
            // The rows carry their publication's year and day (the key holds
            // them equal): families read the card without the publication row.
            const asOfDate = new Date(`${computed.asOfDate}T00:00:00.000Z`);
            await tx.timplanStatement.createMany({
              data: rows.map((row) => ({ ...row, schoolId, publicationId: publication.id, academicYearId: dto.academicYearId, asOfDate })),
            });
          }
          return {
            academicYearId: dto.academicYearId,
            publishedAt: publication.publishedAt.toISOString(),
            publishedByUserId: user.userId ?? null,
            asOfDate: computed.asOfDate,
            pupils: computed.coverage.pupils.length,
            rows: rows.length,
          };
        },
        { timeoutMs: STAGE_TIMEOUT_MS },
      );
      this.logger.log(`Undervisningstid publicerad [school=${schoolId}, pupils=${result.pupils}, rows=${result.rows}]`);
      return result;
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ConflictException) throw error;
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        JSON.stringify(error.meta ?? {}).includes('TimplanStatementPublications')
      ) {
        throw new ConflictException({
          message: 'Undervisningstiden publiceras redan av någon annan. Vänta ett ögonblick och ladda om sidan.',
          code: TIMPLAN_STAGE_PUBLISH_IN_PROGRESS,
        });
      }
      rethrowPrismaError(error);
    }
  }

  /** Withdraws the statement: the cards disappear. Idempotent. */
  async withdraw(user: AuthenticatedUser): Promise<void> {
    requireSchoolId(user);
    try {
      await this.prisma.withRls(user, (tx) => tx.timplanStatementPublication.deleteMany({}));
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  /**
   * One pupil's "Undervisningstid", read under the caller's RLS: a pupil
   * reads their own (the studentId asked for is theirs, whatever was sent), a
   * guardian a child of theirs, an admin anyone of the school. Null — and the
   * card renders nothing — when the school has not published, when the
   * statement is for a year that is no longer the active one, or when the
   * caller may not read the pupil's rows (RLS answers that, as for every
   * other read). Only the statement's own rows are read — never the
   * publication row, which a family cannot read (it names the publishing
   * admin); each row carries its year and the school's day it was published.
   */
  async card(query: { studentId?: string }, user: AuthenticatedUser): Promise<TeachingTimeCardResponse> {
    requireSchoolId(user);
    const studentId = user.role === Role.STUDENT ? user.userId : query.studentId;
    if (!studentId) {
      throw new BadRequestException('studentId: ange vilken elev.');
    }
    try {
      return await this.prisma.withRls(user, async (tx) => {
        // At most one publication per school, so a pupil's rows are one statement.
        const rows = await tx.timplanStatement.findMany({
          where: { studentId },
          orderBy: [{ stage: 'asc' }, { subjectCode: 'asc' }],
        });
        if (rows.length === 0) return { statement: null };
        const { academicYearId, asOfDate } = rows[0]!;
        const year = await tx.academicYear.findUnique({ where: { id: academicYearId }, select: { isActive: true } });
        if (!year?.isActive) return { statement: null };
        const subjects = await tx.nationalSubject.findMany({
          where: { code: { in: [...new Set(rows.map((row) => row.subjectCode))] } },
          select: { code: true, name: true },
        });
        const names = new Map(subjects.map((subject) => [subject.code, subject.name]));
        const stages = new Map<string, TeachingTimeStage>();
        for (const row of rows) {
          let stage = stages.get(row.stage);
          if (!stage) {
            stages.set(
              row.stage,
              (stage = {
                stage: row.stage,
                versionCode: row.versionCode,
                distributionPublished: row.distributionPublished,
                gradesFrom: row.gradesFrom,
                gradesTo: row.gradesTo,
                complete: row.complete,
                recordedFrom: asDayOrNull(row.recordedFrom),
                plannedGrades: row.plannedGrades,
                unrecordedGrades: row.unrecordedGrades,
                unplannedGrades: row.unplannedGrades,
                backfilled: row.backfilled,
                historyFrom: asDayOrNull(row.historyFrom),
                lines: [],
              }),
            );
          }
          stage.lines.push({
            subjectCode: row.subjectCode,
            subjectName: names.get(row.subjectCode) ?? row.subjectCode,
            nationalHours: row.nationalHours === null ? null : Number(row.nationalHours),
            plannedHours: Number(row.plannedHours),
            outcomeHours: Number(row.outcomeHours),
            projectedHours: Number(row.projectedHours),
            status: row.status,
            projectedStatus: row.projectedStatus,
          });
        }
        const order = ['LAG', 'LAG_MELLAN', 'MELLAN', 'HOG'];
        return {
          statement: {
            studentId,
            academicYearId,
            asOfDate: asDay(asOfDate),
            stages: [...stages.values()].sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage)),
          },
        };
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }
}

async function readPublication(tx: Prisma.TransactionClient): Promise<StagePublicationSummary | null> {
  const row = await tx.timplanStatementPublication.findFirst({
    select: { academicYearId: true, publishedAt: true, publishedByUserId: true, asOfDate: true, pupils: true },
  });
  return row
    ? {
        academicYearId: row.academicYearId,
        publishedAt: row.publishedAt.toISOString(),
        publishedByUserId: row.publishedByUserId,
        asOfDate: asDay(row.asOfDate),
        pupils: row.pupils,
      }
    : null;
}

/** The statement's rows: every cell of every CURRENT stage of every pupil (data minimisation). */
export function statementRows(coverage: StageCoverage) {
  return coverage.pupils.flatMap((pupil) =>
    pupil.stages
      .filter((stage) => stage.current)
      .flatMap((stage) =>
        stage.cells.map((cell) => ({
          studentId: pupil.pupilId,
          stage: stage.stage,
          subjectCode: cell.code,
          versionCode: stage.versionCode,
          distributionPublished: stage.distributionPublished,
          gradesFrom: Math.min(...stage.grades),
          gradesTo: Math.max(...stage.grades),
          nationalHours: cell.nationalHours,
          plannedHours: cell.plannedHours,
          outcomeHours: cell.outcomeHours,
          projectedHours: cell.projectedHours,
          status: cell.status,
          projectedStatus: cell.projectedStatus,
          complete: stage.complete,
          recordedFrom: stage.recordedFrom === null ? null : new Date(`${stage.recordedFrom}T00:00:00.000Z`),
          plannedGrades: stage.plannedGrades,
          unrecordedGrades: stage.unrecordedGrades,
          unplannedGrades: stage.unplannedGrades,
          backfilled: stage.backfilled,
          historyFrom: stage.historyFrom === null ? null : new Date(`${stage.historyFrom}T00:00:00.000Z`),
        })),
      ),
  );
}

interface ComputedStages {
  isActiveYear: boolean;
  asOfDate: string;
  coverage: StageCoverage;
  input: StageInput | null;
  cohorts: CohortNoticeRow[];
  subjectNames: Map<string, string>;
}

/**
 * Reads everything for the active year's stage totals and computes them. See
 * the class comment for what is read. `groupId` narrows the pupils to one
 * home class (the drill-down) — and with them every read that is per pupil.
 */
export async function computeStages(
  tx: Prisma.TransactionClient,
  academicYearId: string,
  now: Date,
  groupId: string | null,
): Promise<ComputedStages> {
  const year = await tx.academicYear.findUnique({
    where: { id: academicYearId },
    select: { id: true, startDate: true, endDate: true, isActive: true, school: { select: { timezone: true } } },
  });
  if (!year) throw new NotFoundException('Läsåret finns inte.');
  const timezone = year.school?.timezone ?? 'Europe/Stockholm';
  const asOfDate = asDay(todayInZone(timezone, now));
  const empty: StageCoverage = { asOfDate, pupils: [] };
  if (!year.isActive) {
    return { isActiveYear: false, asOfDate, coverage: empty, input: null, cohorts: [], subjectNames: new Map() };
  }
  const activeStart = asDay(year.startDate);
  const activeHT = htOf(activeStart);

  const years = await tx.academicYear.findMany({
    select: { id: true, name: true, startDate: true, endDate: true, predecessorId: true },
    orderBy: { startDate: 'asc' },
  });
  const open = await tx.studentEnrollment.findMany({
    where: { academicYearId, validTo: null, ...(groupId ? { studentGroupId: groupId } : {}) },
    select: { studentId: true, studentGroupId: true, gradeLevel: true },
    orderBy: { studentId: 'asc' },
  });
  const pupilIds = open.map((row) => row.studentId);
  const segments: StageSegment[] =
    pupilIds.length === 0
      ? []
      : (
          await tx.studentEnrollment.findMany({
            where: { studentId: { in: pupilIds } },
            select: {
              studentId: true,
              academicYearId: true,
              studentGroupId: true,
              gradeLevel: true,
              validFrom: true,
              validTo: true,
              source: true,
              createdAt: true,
            },
            orderBy: [{ studentId: 'asc' }, { validFrom: 'asc' }],
          })
        ).map((row) => ({
          studentId: row.studentId,
          academicYearId: row.academicYearId,
          studentGroupId: row.studentGroupId,
          gradeLevel: row.gradeLevel,
          from: asDay(row.validFrom),
          to: asDayOrNull(row.validTo),
          source: row.source,
          // The school's day the row was written: a BACKFILL row's is the day the history began.
          writtenOn: asDay(todayInZone(timezone, row.createdAt)),
        }));

  // The years the pupils were enrolled in, back to the longest stage.
  const earliest = `${activeHT - MAX_STAGE_YEARS}-07-01`;
  const enrolledYears = new Set(segments.map((segment) => segment.academicYearId));
  const readYears = years.filter(
    (candidate) =>
      enrolledYears.has(candidate.id) && asDay(candidate.startDate) >= earliest && asDay(candidate.startDate) <= activeStart,
  );

  const versions = await tx.nationalTimplanVersion.findMany({
    select: {
      code: true,
      schoolForm: true,
      totalHours: true,
      reductionCapPercent: true,
      appliesFromCohortTerm: true,
      appliesBy: true,
      entries: { select: { subjectCode: true, stage: true, hours: true, minimumHoursPerChild: true, protectedFromReduction: true } },
    },
    orderBy: { code: 'asc' },
  });
  const nationalSubjects = await tx.nationalSubject.findMany({
    select: { code: true, name: true, parentCode: true },
    orderBy: { code: 'asc' },
  });

  const blocksOf = new Map<string, StageYearCells[]>();
  let activeRows: Awaited<ReturnType<typeof readPlannedRows>> | null = null;
  for (const candidate of readYears) {
    const bounds = { id: candidate.id, startDate: asDay(candidate.startDate), endDate: asDay(candidate.endDate) };
    const yearSegments = segments.filter((segment) => segment.academicYearId === candidate.id);
    const rows = await readPlannedRows(tx, candidate.id);
    if (candidate.id === academicYearId) activeRows = rows;
    const teachingIds = rows.groups.filter((group) => group.kind === 'TEACHING_GROUP').map((group) => group.id);
    const yearPupils = [...new Set(yearSegments.map((segment) => segment.studentId))];
    const memberships =
      teachingIds.length === 0 || yearPupils.length === 0
        ? []
        : await tx.studentGroupMember.findMany({
            where: { studentGroupId: { in: teachingIds }, studentId: { in: yearPupils } },
            select: { studentId: true, studentGroupId: true },
          });
    const plans =
      rows.attachments.length === 0
        ? []
        : await tx.localTimplan.findMany({
            where: { id: { in: [...new Set(rows.attachments.map((row) => row.localTimplanId))] } },
            select: { id: true, schoolForm: true },
          });
    const credits = await tx.timplanCredit.findMany({
      where: { academicYearId: candidate.id },
      select: { id: true, date: true, minutes: true, subjectId: true, studentGroupId: true, minGradeLevel: true, maxGradeLevel: true, name: true },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
    });
    const window = { academicYearId: candidate.id, yearStart: bounds.startDate, yearEnd: bounds.endDate, asOf: now };
    const closures = await readPublishClosures(tx, window);
    const breaks = publishBreaksOf(rows.closures);
    const creditRows = credits.map((row) => ({ ...row, date: asDay(row.date) }));
    const boundaries = boundariesOf(yearSegments, bounds);
    const delivered = await readSegmentedDeliveredRows(
      tx,
      window,
      deliveredDatesToAsk(creditRows, breaks, bounds, asOfDate),
      boundaries,
    );
    const masters = candidate.id === academicYearId ? await readMasters(tx, candidate.id) : [];
    const read: StageYearRead = {
      year: bounds,
      planned: { year: { startDate: bounds.startDate, endDate: bounds.endDate }, ...rows },
      memberships,
      audiences: delivered.audiences,
      horizon: delivered.horizon,
      published: delivered.published,
      publishedDays: delivered.publishedDays,
      dates: delivered.dates,
      boundaries,
      credits: creditRows,
      masters,
      publish: { breaks, closures, timezone },
      planForms: new Map(plans.map((plan) => [plan.id, plan.schoolForm as SchoolForm])),
    };
    for (const [pupilId, blocks] of recordedBlocksOfYear(read, yearSegments, now.toISOString(), asOfDate)) {
      blocksOf.set(pupilId, [...(blocksOf.get(pupilId) ?? []), ...blocks]);
    }
  }

  // The plans the grades ahead follow: this year's per årskurs, and the
  // rolled successor's when there is one.
  const successor = years.find((candidate) => candidate.predecessorId === academicYearId) ?? null;
  const successorAttachments = successor
    ? await tx.academicYearTimplan.findMany({ where: { academicYearId: successor.id }, select: { gradeLevel: true, localTimplanId: true } })
    : [];
  const futureIds = [...new Set([...(activeRows?.attachments ?? []), ...successorAttachments].map((row) => row.localTimplanId))];
  const futurePlans = new Map<string, FuturePlan>(
    (futureIds.length === 0
      ? []
      : await tx.localTimplan.findMany({
          where: { id: { in: futureIds } },
          select: { id: true, schoolForm: true, planningWeeks: true, entries: { select: { subjectId: true, gradeLevel: true, minutesPerWeek: true } } },
        })
    ).map((plan) => [
      plan.id,
      { id: plan.id, schoolForm: plan.schoolForm as SchoolForm, planningWeeksTenths: planningWeeksInTenths(plan.planningWeeks), entries: plan.entries },
    ]),
  );
  const currentPlanOf = new Map((activeRows?.attachments ?? []).map((row) => [row.gradeLevel, futurePlans.get(row.localTimplanId) ?? null]));
  const successorPlans = new Map(
    successorAttachments.flatMap((row) => (futurePlans.has(row.localTimplanId) ? [[row.gradeLevel, futurePlans.get(row.localTimplanId)!] as const] : [])),
  );
  const subjects = activeRows?.subjects ?? (await tx.subject.findMany({ select: { id: true, name: true, nationalCode: true, countsTowardTimplan: true } }));
  const codeOf = new Map(subjects.map((subject) => [subject.id, subject.nationalCode]));
  const counts = new Set(subjects.filter((subject) => subject.countsTowardTimplan).map((subject) => subject.id));

  const pupils: StagePupilInput[] = open.map((row) => {
    const recorded = blocksOf.get(row.studentId) ?? [];
    const currentPlan = row.gradeLevel === null ? null : (currentPlanOf.get(row.gradeLevel) ?? null);
    const future = futureBlocks({
      regime: regimeOfBlocks(recorded),
      activeHT,
      currentGrade: row.gradeLevel,
      schoolForm: currentPlan?.schoolForm ?? 'GRUNDSKOLA',
      currentPlan,
      successorPlans,
      codeOf,
      counts,
    });
    return { id: row.studentId, homeGroupId: row.studentGroupId, years: [...recorded, ...future] };
  });

  const input: StageInput = {
    asOfDate,
    activeYearId: academicYearId,
    versions: versions.map((version) => ({ ...version, schoolForm: version.schoolForm as SchoolForm })),
    nationalSubjects,
    pupils,
  };
  const coverage = computePupilStages(input);

  // "Timplaner per årskull", from this year's classes and the successor's.
  const successorGroups = successor
    ? await tx.studentGroup.findMany({
        where: { academicYearId: successor.id, kind: 'CLASS' },
        select: { id: true, name: true, gradeLevel: true },
      })
    : [];
  const classes = [
    ...(activeRows?.groups ?? []).filter((group) => group.kind === 'CLASS').map((group) => ({ ...group, ht: activeHT })),
    ...successorGroups.map((group) => ({ ...group, ht: htOf(asDay(successor!.startDate)) })),
  ];
  const forms = [...currentPlanOf.values()].filter((plan): plan is FuturePlan => plan !== null).map((plan) => plan.schoolForm);
  const schoolForm: SchoolForm = forms.length > 0 ? mostCommon(forms) : 'GRUNDSKOLA';
  const cohorts = cohortNotice(
    classes.map((group) => ({ id: group.id, name: group.name, gradeLevel: group.gradeLevel, ht: group.ht })),
    versions.map((version) => ({ ...version, schoolForm: version.schoolForm as SchoolForm, entryCount: version.entries.length })),
    schoolForm,
  );
  return {
    isActiveYear: true,
    asOfDate,
    coverage,
    input,
    cohorts,
    subjectNames: new Map(nationalSubjects.map((subject) => [subject.code, subject.name])),
  };
}

function mostCommon<T>(values: readonly T[]): T {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
}

async function readMasters(tx: Prisma.TransactionClient, academicYearId: string): Promise<DeliveredMasterLesson[]> {
  const masters = await tx.masterLesson.findMany({
    where: { academicYearId },
    select: {
      id: true,
      studentGroupId: true,
      subjectId: true,
      teacherId: true,
      coTeacherId: true,
      dayOfWeek: true,
      startTime: true,
      endTime: true,
      recurrence: true,
      startDate: true,
      endDate: true,
      isParked: true,
      extraGroups: { select: { studentGroupId: true } },
      participants: { select: { studentId: true } },
    },
    orderBy: { id: 'asc' },
  });
  return masters.map((row) => ({
    id: row.id,
    studentGroupId: row.studentGroupId,
    subjectId: row.subjectId,
    extraGroupIds: row.extraGroups.map((entry) => entry.studentGroupId),
    studentIds: row.participants.map((entry) => entry.studentId),
    teacherId: row.teacherId,
    coTeacherId: row.coTeacherId,
    dayOfWeek: row.dayOfWeek,
    startTime: asClock(row.startTime),
    endTime: asClock(row.endTime),
    recurrence: row.recurrence,
    startDate: asDayOrNull(row.startDate),
    endDate: asDayOrNull(row.endDate),
    isParked: row.isParked,
  }));
}
