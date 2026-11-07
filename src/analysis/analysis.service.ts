import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { recordRead } from '../access-log/access-log';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { checkWindow } from '../cover/cover.service';
import { CoverReportsService } from '../cover/cover-reports.service';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { todayInZone } from '../common/utils/time';
import { addDays } from '../common/year-rollover';
import type { GradeNumbering } from '../common/grade-numbering';
import { readPlannedInput } from '../timplan/timplan-coverage.service';
import {
  readPublishedSpans,
  staffingCreditStatement,
  substituteHoursStatement,
  type StaffingCreditRow,
  type SubstituteHoursRow,
} from '../timplan/timplan-delivered.sql';
import { postOn } from '../staffing/employment-periods';
import { HR_NOT_YOURS, readsHr } from '../staffing/hr-visibility';
import { readLoadInput } from '../staffing/load-input';
import { StaffingLoadService } from '../staffing/staffing-load.service';
import { markedIds } from '../users/person-protections';
import {
  COST_CATEGORIES,
  type AnalysisNotice,
  type CostBasisResponse,
  type CostCategory,
  type KeyFiguresResponse,
  type PayrollBasisResponse,
  type PayrollFileResponse,
  type PayrollPersonKind,
  type SchoolPartView,
} from './analysis.types';
import { audiencesOf, type Audiences } from './audience';
import { buildCostBasis, type SubstituteRow } from './cost-basis';
import { buildKeyFigures } from './key-figures';
import { buildPayroll } from './payroll-basis';
import {
  payrollFileName,
  payrollTable,
  PAYROLL_CONTENT_TYPE,
  renderPayrollCsv,
  renderPayrollXlsx,
  type PayrollFileRow,
} from './payroll-files';
import { partOfGrade, byGrade } from './school-part-rules';
import type { CostBasisQueryDto, PayrollExportDto, PayrollQueryDto } from './dto/analysis.dto';

/**
 * Analys och planering: nyckeltal per lärare och skola, kostnadsunderlag per
 * elev och löneunderlag med konton.
 *
 * Nothing is stored but the two things the school states (its skoldelar and
 * the cost of an hour per personalkategori); every figure is computed on the
 * request from the rows the rest of the product already keeps, by the
 * arithmetic that already exists:
 *
 *   - time and load are the belastningsrapport's (StaffingLoadService.readReports
 *     builds the planned and the scheduled report from one read);
 *   - the pupils of a row are the timplan's rosters (readPlannedInput, which
 *     reads a past year from its class history) less what a replacing group
 *     takes off the row (audience.ts);
 *   - held teaching is statement E of the delivered time, and the vikarie's
 *     hours are the hour export's own (CoverReportsService.hours).
 *
 * WHO SEES WHAT. Every administrator reads the school's key figures; the
 * per-teacher rows leave out tjänstgöringsgrad for a reader without HR-läs
 * (hr-visibility.ts). The huvudman's reader is handed the school's figures and
 * the cost basis as aggregates and no teacher's row. The payroll is HR data
 * through and through (each person's time and tjänst) and goes to rektor, a
 * full administrator and those with HR-läs, as the SCB file does, and its
 * file keeps people with a protected identity and says how many (payroll pays
 * everyone: KEEPS_AND_SAYS). A teacher has none of it: the controller says so.
 *
 * LÄSLOGG. A reader of per-teacher figures reads teachers' tjänst: EMPLOYMENT
 * for each teacher in the answer, and PEOPLE beside it where the answer states
 * a person's tjänstgöringsgrad or the file names the person.
 */

export const ANALYSIS_RANGE = 'ANALYSIS_RANGE';
/** The cost basis is the school's economy: a refusal worded for whoever is not given it. */
export const ANALYSIS_COST_NOT_YOURS = 'ANALYSIS_COST_NOT_YOURS';

/** The huvudman's reader: the school's läsare with no row of their own. */
const isReader = (user: AuthenticatedUser): boolean => user.huvudman !== undefined && !user.userId;

const KIND_LABEL: Record<PayrollPersonKind, string> = { STAFF: 'Personal', POOL: 'Vikariepool' };
const NO_PART = 'Ej fördelat';

const asDay = (value: Date): string => value.toISOString().slice(0, 10);

@Injectable()
export class AnalysisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly staffing: StaffingLoadService,
    private readonly cover: CoverReportsService,
  ) {}

  /** The clock, overridable in a test. */
  now(): Date {
    return new Date();
  }

  // -------------------------------------------------------------------------
  // Nyckeltal
  // -------------------------------------------------------------------------

  /**
   * `schedule`: also each teacher's undervisning according to the grundschema. A second report over every master
   * lesson of the year, which is the larger part of what these figures cost (measured: about 60 % of the CPU of
   * the whole answer on a school of 120 teachers), so it is made when asked for.
   */
  async keyFigures(academicYearId: string, user: AuthenticatedUser, options: { schedule?: boolean } = {}): Promise<KeyFiguresResponse> {
    requireSchoolId(user);
    const aggregateOnly = isReader(user);
    const now = this.now();
    return this.prisma.withRls(user, async (tx) => {
      const { read, planned, scheduled } = await this.staffing.readReports(tx, user, academicYearId, { scheduled: options.schedule === true });
      const pupils = await readPlannedInput(tx, user, academicYearId, true);
      if (!pupils) throw new NotFoundException('Academic year not found.');
      const audiences = audiencesOf(pupils.groups, pupils.pupils);
      const hr = readsHr(user) && !aggregateOnly;
      const fullTime = read.input.policy?.fullTimeTeachingMinutesPerWeek ?? null;
      // A post that changes during the year is read on one day (postOn), not on its base row: the school's today,
      // held inside the läsår, so a past year is read on its last day and a coming one on its first.
      let employmentOn = read.year.startDate;
      if (hr) {
        const zone = await tx.academicYear.findUnique({
          where: { id: academicYearId },
          select: { school: { select: { timezone: true } } },
        });
        const today = asDay(todayInZone(zone?.school?.timezone ?? 'Europe/Stockholm', now));
        employmentOn = today < read.year.startDate ? read.year.startDate : today > read.year.endDate ? read.year.endDate : today;
      }
      const { school, teachers } = buildKeyFigures({
        planned,
        scheduled,
        audiences,
        fullTimeMinutesPerWeek: fullTime && fullTime > 0 ? fullTime : null,
        readsHr: hr,
        employmentOn,
      });
      if (!aggregateOnly) {
        // Each teacher's undervisning, load and, with HR-läs, tjänst: their post (EMPLOYMENT), and the person it is (PEOPLE).
        const ids = teachers.map((teacher) => teacher.userId);
        await recordRead(tx, 'EMPLOYMENT', ids, user.channel);
        if (hr) await recordRead(tx, 'PEOPLE', ids, user.channel);
      }
      const notices: AnalysisNotice[] = [];
      if (pupils.rostersFrom === 'ENROLLMENT') notices.push({ code: 'ANALYSIS_PUPILS_FROM_ENROLLMENT', params: {} });
      if (school.fullTimeTeachingMinutesPerWeek === null) notices.push({ code: 'ANALYSIS_NO_FULL_TIME', params: {} });
      if (!planned.qualificationsRecorded) notices.push({ code: 'ANALYSIS_QUALIFICATIONS_NOT_RECORDED', params: {} });
      return {
        academicYearId,
        year: read.year,
        loadModel: planned.loadModel,
        ...(pupils.rostersFrom ? { rostersFrom: pupils.rostersFrom } : {}),
        ...(!hr && !aggregateOnly ? { hrHidden: true as const } : {}),
        ...(hr ? { employmentOn } : {}),
        ...(aggregateOnly ? { aggregateOnly: true as const } : {}),
        school,
        teachers: aggregateOnly ? null : teachers,
        notices,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Kostnadsunderlag per elev
  // -------------------------------------------------------------------------

  async costBasis(query: CostBasisQueryDto, user: AuthenticatedUser): Promise<CostBasisResponse> {
    requireSchoolId(user);
    // The school's economy: rektor, a full administrator, those with HR-läs and the huvudman's reader (aggregates).
    if (!isReader(user) && !readsHr(user)) {
      throw new ForbiddenException({
        message: 'Kostnadsunderlaget är skolans ekonomi. Det hämtas av rektor, en fullständig administratör, den som har HR-läs och huvudmannens läsare.',
        code: ANALYSIS_COST_NOT_YOURS,
      });
    }
    if ((query.from === undefined) !== (query.to === undefined)) {
      throw new BadRequestException({ message: 'from, to: ange båda dagarna eller ingen.', code: ANALYSIS_RANGE });
    }
    if (query.from !== undefined && query.to !== undefined && query.from > query.to) {
      throw new BadRequestException({ message: 'from: periodens början ligger efter dess slut.', code: ANALYSIS_RANGE });
    }
    const now = this.now();
    return this.prisma.withRls(user, async (tx) => {
      const { read, planned } = await this.staffing.readReports(tx, user, query.academicYearId, { scheduled: false });
      const pupils = await readPlannedInput(tx, user, query.academicYearId, true);
      if (!pupils) throw new NotFoundException('Academic year not found.');
      const audiences = audiencesOf(pupils.groups, pupils.pupils);
      const parts = await this.partsIn(tx, user);
      const rates = await this.ratesIn(tx);
      const numbering: GradeNumbering = pupils.gradeNumbering ?? 'NIOARIG';

      // The vikarie's held lessons over the range: the year's start to the school's yesterday unless the page asks.
      const school = await tx.academicYear.findUnique({
        where: { id: query.academicYearId },
        select: { school: { select: { timezone: true } } },
      });
      const today = asDay(todayInZone(school?.school?.timezone ?? 'Europe/Stockholm', now));
      const yesterday = addDays(today, -1);
      const askedFrom = query.from ?? read.year.startDate;
      const askedTo = query.to ?? (yesterday < read.year.endDate ? yesterday : read.year.endDate);
      const from = askedFrom < read.year.startDate ? read.year.startDate : askedFrom;
      const to = askedTo > read.year.endDate ? read.year.endDate : askedTo;
      let substitutes: SubstituteRow[] = [];
      let range: { from: string; to: string } | null = null;
      if (from <= to) {
        range = { from, to };
        const rows = await tx.$queryRaw<SubstituteHoursRow[]>(
          substituteHoursStatement(
            { academicYearId: query.academicYearId, yearStart: read.year.startDate, yearEnd: read.year.endDate, asOf: now },
            range,
            null,
          ),
        );
        const byRow = new Map<string, SubstituteRow>();
        for (const row of rows ?? []) {
          const key = `${row.studentGroupId}|${row.subjectId}`;
          const entry = byRow.get(key) ?? { studentGroupId: row.studentGroupId, subjectId: row.subjectId, minutes: 0 };
          entry.minutes += Number(row.minutes);
          byRow.set(key, entry);
        }
        substitutes = [...byRow.values()];
      }

      const built = buildCostBasis({ planned, audiences, parts, numbering, rates, substitutes });
      const notices = [...built.notices];
      if (pupils.rostersFrom === 'ENROLLMENT') notices.push({ code: 'ANALYSIS_PUPILS_FROM_ENROLLMENT', params: {} });
      return {
        academicYearId: query.academicYearId,
        year: read.year,
        gradeNumbering: numbering,
        ...(pupils.rostersFrom ? { rostersFrom: pupils.rostersFrom } : {}),
        substitutes: range,
        rates: COST_CATEGORIES.filter((category) => rates.has(category)).map((category) => ({ category, hourlyCost: rates.get(category)! })),
        ...built,
        notices,
        ...(isReader(user) ? { aggregateOnly: true as const } : {}),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Löneunderlag
  // -------------------------------------------------------------------------

  async payrollBasis(query: PayrollQueryDto, user: AuthenticatedUser): Promise<PayrollBasisResponse> {
    return (await this.payroll(query, user, false)).response;
  }

  async payrollFile(query: PayrollExportDto, user: AuthenticatedUser): Promise<PayrollFileResponse> {
    const { response, rows } = await this.payroll(query, user, true);
    const table = payrollTable(rows, response.from, response.to);
    const notices = [...response.notices];
    let bytes: Buffer;
    if (query.format === 'CSV') {
      const csv = renderPayrollCsv(table);
      bytes = csv.bytes;
      if (csv.replaced > 0) notices.push({ code: 'ANALYSIS_CHARACTERS_REPLACED', params: { characters: csv.replaced } });
    } else {
      bytes = renderPayrollXlsx(table);
    }
    return {
      filename: payrollFileName(query.format, response.from, response.to),
      contentType: PAYROLL_CONTENT_TYPE[query.format],
      contentBase64: bytes.toString('base64'),
      notices,
      protectedInFile: response.protectedInAnswer,
    };
  }

  /**
   * The löneunderlag, and with `withNames` the rows of the file. HR data
   * through and through: refused to a reader who does not read HR data before
   * anything is read, not handed a file with holes (as the SCB file is).
   */
  private async payroll(
    query: PayrollQueryDto,
    user: AuthenticatedUser,
    withNames: boolean,
  ): Promise<{ response: PayrollBasisResponse; rows: PayrollFileRow[] }> {
    const schoolId = requireSchoolId(user);
    if (isReader(user) || !readsHr(user)) {
      throw new ForbiddenException({
        message:
          'Löneunderlaget innehåller varje persons tid och tjänstgöringsgrad. Det hämtas av rektor, en fullständig administratör eller den som har HR-läs.',
        code: HR_NOT_YOURS,
      });
    }
    checkWindow(query.from, query.to, 93);
    const now = this.now();

    // The year first, to clamp the period into it: the vikarie export is asked for the clamped days.
    const year = await this.prisma.withRls(user, (tx) =>
      tx.academicYear.findUnique({
        where: { id: query.academicYearId },
        select: { startDate: true, endDate: true, gradeNumbering: true },
      }),
    );
    if (!year) throw new NotFoundException('Academic year not found.');
    const yearStart = asDay(year.startDate);
    const yearEnd = asDay(year.endDate);
    const from = query.from < yearStart ? yearStart : query.from;
    const to = query.to > yearEnd ? yearEnd : query.to;
    if (from > to) {
      throw new BadRequestException({ message: `from, to: perioden ligger utanför läsåret (${yearStart} – ${yearEnd}).`, code: ANALYSIS_RANGE });
    }
    const clamped = from !== query.from || to !== query.to;
    // The vikarie export's own rows (its own transaction and its own läslogg entry).
    const hours = await this.cover.hours(from, to, undefined, user);

    return this.prisma.withRls(user, async (tx) => {
      // The rows the report is made of, not the report: the payroll needs the posts, the uppdrag and the lov.
      const read = await readLoadInput(tx, user, query.academicYearId, schoolId);
      if (!read) throw new NotFoundException('Academic year not found.');
      const pupils = await readPlannedInput(tx, user, query.academicYearId, true);
      if (!pupils) throw new NotFoundException('Academic year not found.');
      const audiences = audiencesOf(pupils.groups, pupils.pupils);
      const parts = await this.partsIn(tx, user);
      const numbering: GradeNumbering = pupils.gradeNumbering ?? 'NIOARIG';
      const partOfGroup = this.groupPartResolver(pupils.groups, audiences, parts, numbering);

      // Held teaching: statement E over the period, the lead and assistant rows of lessons that were held.
      const window = { academicYearId: query.academicYearId, yearStart, yearEnd, asOf: now };
      const spans = await readPublishedSpans(tx, window, null);
      const credits =
        spans.published === null ? [] : await tx.$queryRaw<StaffingCreditRow[]>(staffingCreditStatement(window, { from, to }, null, null));
      const teaching = new Map<string, { userId: string; studentGroupId: string; minutes: number }>();
      for (const row of credits) {
        if (row.kind !== 'T' || row.personId === null || row.bucket !== 'DELIVERED' || (row.role !== 'LEAD' && row.role !== 'ASSISTANT')) continue;
        const key = `${row.personId}|${row.studentGroupId}`;
        const entry = teaching.get(key) ?? { userId: row.personId, studentGroupId: row.studentGroupId, minutes: 0 };
        entry.minutes += Number(row.minutes);
        teaching.set(key, entry);
      }

      const employments = new Map(read.input.employments.map((post) => [post.userId, post]));
      const pool = new Set((await tx.substitutePoolMember.findMany({ select: { userId: true } })).map((row) => row.userId));
      const kindOf = (userId: string): PayrollPersonKind => (pool.has(userId) && !employments.has(userId) ? 'POOL' : 'STAFF');

      const built = buildPayroll({
        from,
        to,
        year: { startDate: yearStart, endDate: yearEnd },
        teaching: [...teaching.values()],
        substitutes: hours.rows.map((row) => ({ userId: row.userId, studentGroupId: row.studentGroupId, minutes: row.minutes })),
        duties: read.input.duties,
        closures: read.input.closures,
        parts,
        partOfGroup,
        kindOf,
        // The post in force on the period's last day, as the SCB underlag judges a post on its mätdatum: a post that
        // changes from 1 november is the new percentage in a payroll for november.
        employmentPercentOf: (userId) => {
          const post = employments.get(userId);
          return post ? postOn(post, to).employmentPercent : null;
        },
      });

      const people = built.people.map((person) => person.userId);
      const marked = await markedIds(tx, schoolId);
      const protectedInAnswer = people.filter((userId) => marked.has(userId)).length;
      // Who is in the answer: their tjänst (EMPLOYMENT) and the person (PEOPLE), recorded in the read's transaction.
      await recordRead(tx, 'EMPLOYMENT', people, user.channel);
      await recordRead(tx, 'PEOPLE', people, user.channel);

      const notices: AnalysisNotice[] = [];
      if (clamped) notices.push({ code: 'ANALYSIS_PERIOD_CLAMPED', params: { from, to } });
      if (spans.published === null) notices.push({ code: 'ANALYSIS_NOTHING_PUBLISHED', params: {} });
      if (hours.toCheck.length > 0) notices.push({ code: 'ANALYSIS_COVER_TO_CHECK', params: { lessons: hours.toCheck.length } });
      if (built.dutiesUnallocated > 0) notices.push({ code: 'ANALYSIS_DUTIES_UNALLOCATED', params: { people: built.dutiesUnallocated } });
      if (protectedInAnswer > 0) notices.push({ code: 'ANALYSIS_PROTECTED_IN_FILE', params: { people: protectedInAnswer } });

      const response: PayrollBasisResponse = {
        academicYearId: query.academicYearId,
        from,
        to,
        parts,
        people: built.people,
        lines: built.lines,
        protectedInAnswer,
        notices,
      };
      if (!withNames) return { response, rows: [] };

      const users = people.length === 0 ? [] : await tx.user.findMany({ where: { id: { in: people } }, select: { id: true, firstName: true, lastName: true, email: true } });
      const byId = new Map(users.map((person) => [person.id, person]));
      const partById = new Map(parts.map((part) => [part.id, part]));
      const collator = new Intl.Collator('sv');
      const rank = new Map<string | null, number>([...parts].sort(byGrade).map((part, index) => [part.id, index]));
      const personOf = new Map(built.people.map((person) => [person.userId, person]));
      const rows = built.lines
        .map((line): PayrollFileRow & { userId: string; partRank: number } => {
          const person = byId.get(line.userId);
          const part = line.schoolPartId === null ? undefined : partById.get(line.schoolPartId);
          return {
            userId: line.userId,
            partRank: rank.get(line.schoolPartId) ?? parts.length,
            signature: employments.get(line.userId)?.signature ?? '',
            lastName: person?.lastName ?? '',
            firstName: person?.firstName ?? '',
            email: person?.email ?? '',
            kindLabel: KIND_LABEL[line.kind],
            employmentPercent: personOf.get(line.userId)?.employmentPercent ?? null,
            partName: part?.name ?? NO_PART,
            account: part?.account ?? '',
            teachingMinutes: line.teachingMinutes,
            dutyMinutes: line.dutyMinutes,
            substituteMinutes: line.substituteMinutes,
          };
        })
        .sort(
          (a, b) =>
            collator.compare(a.lastName, b.lastName) || collator.compare(a.firstName, b.firstName) || a.userId.localeCompare(b.userId) || a.partRank - b.partRank,
        );
      return { response, rows };
    });
  }

  // -------------------------------------------------------------------------
  // Reads shared by the views
  // -------------------------------------------------------------------------

  private async partsIn(tx: PrismaClient, user: AuthenticatedUser): Promise<SchoolPartView[]> {
    const rows = await tx.schoolPart.findMany({
      where: { schoolId: requireSchoolId(user) },
      select: { id: true, name: true, account: true, gradeFrom: true, gradeTo: true },
    });
    return rows.sort(byGrade);
  }

  private async ratesIn(tx: PrismaClient): Promise<Map<CostCategory, number>> {
    const rows = await tx.staffCostRate.findMany({ select: { category: true, hourlyCost: true } });
    return new Map(rows.map((row) => [row.category, Number(row.hourlyCost)]));
  }

  /**
   * The skoldel a group falls in: a class by its årskurs, a teaching group by
   * the skoldel most of its pupils' classes fall in (the lower årskurs on a
   * tie), so that a group of eighth and ninth graders books on the skoldel that
   * holds more of them. A group whose pupils are in none, or that has no
   * pupils and no årskurs, falls in none.
   */
  private groupPartResolver(
    groups: readonly { id: string; kind: 'CLASS' | 'TEACHING_GROUP'; gradeLevel: number | null }[],
    audiences: Audiences,
    parts: readonly SchoolPartView[],
    numbering: GradeNumbering,
  ): (groupId: string) => SchoolPartView | null {
    const byId = new Map(groups.map((group) => [group.id, group]));
    const memo = new Map<string, SchoolPartView | null>();
    return (groupId) => {
      if (memo.has(groupId)) return memo.get(groupId)!;
      const group = byId.get(groupId);
      let found: SchoolPartView | null = null;
      if (group?.kind === 'CLASS') {
        found = partOfGrade(parts, group.gradeLevel, numbering);
      } else if (group) {
        const counts = new Map<string, { part: SchoolPartView; pupils: number }>();
        for (const pupil of audiences.membersOf(groupId)) {
          const part = partOfGrade(parts, audiences.gradeOf.get(pupil) ?? null, numbering);
          if (part) counts.set(part.id, { part, pupils: (counts.get(part.id)?.pupils ?? 0) + 1 });
        }
        found = [...counts.values()].sort((a, b) => b.pupils - a.pupils || a.part.gradeFrom - b.part.gradeFrom)[0]?.part ?? null;
      }
      memo.set(groupId, found);
      return found;
    };
  }
}
