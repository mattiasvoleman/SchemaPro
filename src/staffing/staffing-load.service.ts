import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Role } from '../auth/enums/role.enum';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId, requireUserId } from '../common/utils/request-context';
import { readLoadInput, type LoadRead } from './load-input';
import {
  buildTeacherLoadReport,
  type LoadInput,
  type TeacherLoadReport,
  type UnstaffedRequirement,
} from './teacher-load';
import type { YearBounds } from './teaching-weeks';
import { toScheduledRequirements, type ScheduledMaster } from './scheduled-load';
import { buildReconciliation, type StaffingReconciliation } from './staffing-reconciliation';
import { readPublishedSpans, staffingCreditStatement, type StaffingCreditRow } from '../timplan/timplan-delivered.sql';
import { readGrundschema } from '../publication/published-grundschema';
import { publishBreaksOf, readPublishClosures } from '../timplan/publish-context';
import { todayInZone } from '../common/utils/time';
import { addDays } from '../common/year-rollover';
import type { StaffingDeliveredQueryDto } from './dto/staffing-delivered.dto';
import { suggestTeachers, type TeacherSuggestions } from './suggest-teachers';
import { readLastYearTeachersOf } from './last-year-teachers';
import { readActiveStaffIds } from './staff-candidates';

/**
 * The horizons the weekly report can be asked for: the timplansposter
 * (planned) or the grundschema (scheduled, Fas 3). Delivered time is a range,
 * not a week, and has its own route (GET /staffing/delivered).
 */
export const LOAD_HORIZONS = ['planned', 'scheduled'] as const;
export type LoadHorizon = (typeof LOAD_HORIZONS)[number];

export interface TeacherLoadReportResponse extends TeacherLoadReport {
  academicYearId: string;
  horizon: LoadHorizon;
  year: YearBounds;
  /**
   * False under horizon=scheduled: the unstaffed, unqualified and bottleneck
   * lists are about timplansposter and belong to the planned horizon, so they
   * are empty there rather than computed over lessons.
   */
  listsComputed: boolean;
}

/** GET /staffing/delivered's answer. */
export interface StaffingReconciliationResponse extends StaffingReconciliation {
  academicYearId: string;
  year: YearBounds;
  /** The instant "held" is measured at, and the school's day it falls on. */
  asOf: string;
  asOfDate: string;
}

const asDay = (value: Date): string => value.toISOString().slice(0, 10);
const asDayOrNull = (value: Date | null): string | null => (value === null ? null : asDay(value));
/** A @db.Time back out as the wall clock it is, "HH:MM". */
const asClock = (value: Date): string => value.toISOString().slice(11, 16);

/**
 * Reads the rows the report is computed from, in ONE RLS transaction, and hands
 * them to the arithmetic in teacher-load.ts.
 *
 * One transaction so the figures agree with each other: a requirement read
 * before an admin's PATCH and an employment read after it would make a row
 * whose minutes and target come from two different moments. The reads are
 * plain — nothing is written, so no lock is needed.
 *
 * A TEACHER gets their own row. RLS already hands them only their own
 * employment, and the requirements and qualifications they may read are the
 * school's, so the arithmetic runs on the whole school and the response is cut
 * down afterwards: a teacher's share of Ma is a fact about their own rows, but
 * the list of unstaffed requirements is the admin's to act on, and the
 * unqualified list is filtered to the one person it is about.
 */
@Injectable()
export class StaffingLoadService {
  constructor(private readonly prisma: PrismaService) {}

  async load(
    academicYearId: string,
    horizon: string | undefined,
    user: AuthenticatedUser,
  ): Promise<TeacherLoadReportResponse> {
    requireSchoolId(user);
    const chosen = horizon ?? 'planned';
    if (!(LOAD_HORIZONS as readonly string[]).includes(chosen)) {
      throw new BadRequestException(
        `Horisonten "${chosen}" finns inte — välj "planned" (timplansposterna) eller "scheduled" (grundschemat). Genomförd tid över en period läses från /staffing/delivered.`,
      );
    }

    const scheduled = chosen === 'scheduled';
    const { year, input } = await this.prisma.withRls(user, (tx) =>
      scheduled ? this.readScheduledInput(tx, academicYearId, user) : this.readInput(tx, academicYearId, user),
    );
    const report = buildTeacherLoadReport(input);

    const response: TeacherLoadReportResponse = {
      academicYearId,
      horizon: chosen as LoadHorizon,
      year,
      ...report,
      listsComputed: !scheduled,
      ...(scheduled
        ? { unstaffedRequirements: [], unqualifiedAssignments: [], subjectBottlenecks: [], bottlenecksComputed: false }
        : {}),
    };
    if (user.role === Role.SCHOOL_ADMIN) return response;

    const own = requireUserId(user);
    return {
      ...response,
      teachers: report.teachers.filter((row) => row.userId === own),
      unstaffedRequirements: [],
      unqualifiedAssignments: report.unqualifiedAssignments.filter(
        (row) => row.userId === own,
      ),
      // Capacity per subject is a sum over colleagues' targets — and RLS has
      // handed this caller no colleague's post, so the figure would be wrong
      // as well as not theirs.
      subjectBottlenecks: [],
      bottlenecksComputed: false,
      totals: { teacherMinutesPerWeek: 0, lessonMinutesPerWeek: 0, dutyMinutesPerWeek: 0 },
    };
  }

  /**
   * Planerat, schemalagt och genomfört per lärare över [from, to]: the
   * reconciliation of src/staffing/staffing-reconciliation.ts, read in ONE
   * RLS transaction —
   *
   *   1. the year's master lessons (their groups are the spans' groups);
   *   2. readLoadInput, asked for those groups too: the timplansposter, the
   *      posts, the lov, the policy and the load weights — the planned load's
   *      own reader, so the planned column IS the report's arithmetic. It
   *      reaches the year's roster basis (projected-rosters.ts), so on a
   *      rolled year not yet activated this answers R6's 409 as /load does;
   *   3. the school's timezone: "held" is measured now, the range's default
   *      end is the school's today;
   *   4. the dated class and årskurs closures publish skips by
   *      (src/timplan/publish-context.ts, P3's reader);
   *   5. the published range and days (P3's statement C);
   *   6. statement E (src/timplan/timplan-delivered.sql.ts) over P3's one
   *      definition of held.
   *
   * SCHOOL_ADMIN gets every teacher, the bortfall per group and the totals. A
   * TEACHER gets their own row: statement E is asked for their id alone, and
   * the group losses and totals stay empty — the reconciliation never
   * computes a colleague's figure for them. Ids only; the web names people.
   */
  async delivered(
    query: StaffingDeliveredQueryDto,
    user: AuthenticatedUser,
  ): Promise<StaffingReconciliationResponse> {
    const schoolId = requireSchoolId(user);
    const own = user.role === Role.SCHOOL_ADMIN ? null : requireUserId(user);
    const now = new Date();
    if (query.from !== undefined && query.to !== undefined && query.from > query.to) {
      throw new BadRequestException('from: periodens början ligger efter dess slut.');
    }
    return this.prisma.withRls(user, async (tx) => {
      // A teacher in a DRAFT school reads the published grundschema, and the
      // calendar on its published key (published-grundschema.ts).
      const { rows: masters, source } = await readGrundschema(tx, { role: user.role, schoolId }, query.academicYearId, () =>
        readMasters(tx, query.academicYearId),
      );
      const key = source.kind === 'PUBLISHED' ? { publicationId: source.publicationId } : null;
      const read = await readLoadInput(tx, user, query.academicYearId, schoolId, {
        alsoGroupIds: masterGroupIds(masters),
      });
      if (!read) throw new NotFoundException('Academic year not found.');
      const school = await tx.academicYear.findUnique({
        where: { id: query.academicYearId },
        select: { school: { select: { timezone: true } } },
      });
      const timezone = school?.school?.timezone ?? 'Europe/Stockholm';
      const asOfDate = asDay(todayInZone(timezone, now));
      const { year } = read;

      // The range: the asked days, or the year's start to the school's
      // YESTERDAY, clamped into the year. Yesterday, not today: planned
      // counts today in full while today's lessons are held only as they
      // end, so a default through today would show every teacher behind by
      // the rest of the day on every load. A year that begins today (or
      // later) has no yesterday in it and keeps today.
      const askedFrom = query.from ?? year.startDate;
      const yesterday = addDays(asOfDate, -1);
      const lastClosed = yesterday >= year.startDate ? yesterday : asOfDate;
      const askedTo = query.to ?? (lastClosed < year.endDate ? lastClosed : year.endDate);
      if (askedTo < year.startDate || askedFrom > year.endDate) {
        throw new BadRequestException(
          `from/to: perioden ligger helt utanför läsåret (${year.startDate} – ${year.endDate}).`,
        );
      }
      const from = askedFrom < year.startDate ? year.startDate : askedFrom;
      const to = askedTo > year.endDate ? year.endDate : askedTo;
      if (from > to) {
        // The defaults themselves cross: a year that has not begun yet.
        throw new BadRequestException('from: periodens början ligger efter dess slut.');
      }
      const clamped = (query.from !== undefined && from !== query.from) || (query.to !== undefined && to !== query.to);

      const window = { academicYearId: query.academicYearId, yearStart: year.startDate, yearEnd: year.endDate, asOf: now };
      const closures = await readPublishClosures(tx, window);
      const spans = await readPublishedSpans(tx, window, key);
      const credits =
        spans.published === null
          ? []
          : await tx.$queryRaw<StaffingCreditRow[]>(staffingCreditStatement(window, { from, to }, own, key));
      const groups = await tx.studentGroup.findMany({
        where: { academicYearId: query.academicYearId },
        select: { id: true, gradeLevel: true, kind: true },
      });

      const reconciliation = buildReconciliation({
        year,
        from,
        to,
        clamped,
        asOfDate,
        loadModel: read.loadModel,
        published: spans.published,
        publishedDays: spans.publishedDays,
        requirements: read.input.requirements,
        employmentUserIds: read.input.employments.map((row) => row.userId),
        groups: groups.map((g) => ({ id: g.id, gradeLevel: g.gradeLevel, kind: String(g.kind) })),
        closures: read.input.closures,
        masters: masters.map((m) => toScheduledMaster(m, read)),
        publish: { breaks: publishBreaksOf(read.input.closures), closures, timezone },
        credits,
        weightOf: read.weightOf,
        own,
      });
      return {
        academicYearId: query.academicYearId,
        year,
        asOf: now.toISOString(),
        asOfDate,
        ...reconciliation,
      };
    });
  }

  /** The year's requirements with no lead teacher, with their minutes and span. */
  async unstaffed(
    academicYearId: string,
    user: AuthenticatedUser,
  ): Promise<UnstaffedRequirement[]> {
    requireSchoolId(user);
    const { input } = await this.prisma.withRls(user, (tx) =>
      this.readInput(tx, academicYearId, user),
    );
    return buildTeacherLoadReport(input).unstaffedRequirements;
  }

  /**
   * Who should take one timplanspost, ranked (suggest-teachers.ts), from the
   * same rows the report reads and in the same single transaction — so a
   * candidate's remainingMinutesPerWeek is the matrix's saldo for them minus
   * this row's charge: room left AFTER taking it, which the web words as
   * "kvar efter raden" to keep it apart from the dialog's "kvar" (today's).
   *
   * Candidates are the school's ACTIVE staff, TEACHER and SCHOOL_ADMIN alike:
   * a teaching rektor is assigned rows here, as the requirement's teacherId
   * already allows. The requirement is read first and answers 404 when RLS
   * hides it, as every other route names a foreign id.
   *
   * CONTINUITY. When the row's group has a predecessor (StudentGroup
   * .predecessorId, set by the year rollover), one more plain read names who
   * taught the subject for it (last-year-teachers.ts, the fold the staffing
   * proposal reads too). The read runs after the others, on its own, and only
   * then — a school that never rolls makes the same statements as before and
   * gets the same ranking.
   */
  async suggestTeachers(requirementId: string, user: AuthenticatedUser): Promise<TeacherSuggestions> {
    requireSchoolId(user);
    const { input, staffIds, lastYear } = await this.prisma.withRls(user, async (tx) => {
      const requirement = await tx.teachingRequirement.findUnique({
        where: { id: requirementId },
        select: {
          academicYearId: true,
          subjectId: true,
          studentGroup: { select: { predecessorId: true } },
        },
      });
      if (!requirement) {
        throw new NotFoundException('The requested record does not exist.');
      }
      const [{ input: yearInput }, staffIds] = await Promise.all([
        this.readInput(tx, requirement.academicYearId, user),
        readActiveStaffIds(tx, requirement.academicYearId),
      ]);
      const predecessorId = requirement.studentGroup.predecessorId;
      const lastYear = predecessorId
        ? await readLastYearTeachersOf(tx, predecessorId, requirement.subjectId)
        : null;
      return { input: yearInput, staffIds, lastYear };
    });
    return suggestTeachers(input, requirementId, staffIds, lastYear);
  }

  private async readInput(
    tx: PrismaClient,
    academicYearId: string,
    user: AuthenticatedUser,
  ): Promise<{ year: YearBounds; input: LoadInput }> {
    const read = await readLoadInput(tx, user, academicYearId, requireSchoolId(user));
    if (!read) {
      throw new NotFoundException('Academic year not found.');
    }
    return { year: read.year, input: read.input };
  }

  /**
   * The SCHEDULED horizon's input: the planned input with its requirements
   * replaced by one row per non-parked master lesson
   * (src/staffing/scheduled-load.ts), and no behörigheter — the
   * requirement-shaped lists are the planned horizon's, and asking them of
   * lessons would flag a lesson twice for a row. requirementCount counts
   * lessons here. One statement more than planned: the master lessons, read
   * first so their groups' spans are derived with the rest.
   */
  private async readScheduledInput(
    tx: PrismaClient,
    academicYearId: string,
    user: AuthenticatedUser,
  ): Promise<{ year: YearBounds; input: LoadInput }> {
    const { rows: masters } = await readGrundschema(tx, { role: user.role, schoolId: requireSchoolId(user) }, academicYearId, () =>
      readMasters(tx, academicYearId),
    );
    const read = await readLoadInput(tx, user, academicYearId, requireSchoolId(user), {
      alsoGroupIds: masterGroupIds(masters),
    });
    if (!read) {
      throw new NotFoundException('Academic year not found.');
    }
    return {
      year: read.year,
      input: {
        ...read.input,
        requirements: toScheduledRequirements(
          masters.map((m) => toScheduledMaster(m, read)),
          read.input.requirements,
          (groupIds) => read.spanOf(groupIds),
          read.loadModel === 'FACTOR' ? read.weightOf : null,
        ),
        qualifications: [],
      },
    };
  }
}

type MasterRow = Awaited<ReturnType<typeof readMasters>>[number];

/** The year's master lessons, parked ones included (the walk skips them), in id order. */
function readMasters(tx: PrismaClient, academicYearId: string) {
  return tx.masterLesson.findMany({
    where: { academicYearId },
    select: {
      id: true,
      subjectId: true,
      studentGroupId: true,
      teacherId: true,
      coTeacherId: true,
      dayOfWeek: true,
      startTime: true,
      endTime: true,
      recurrence: true,
      startDate: true,
      endDate: true,
      isParked: true,
      subject: { select: { name: true } },
      studentGroup: { select: { name: true } },
      extraGroups: { select: { studentGroupId: true } },
    },
    orderBy: { id: 'asc' },
  });
}

function masterGroupIds(masters: readonly MasterRow[]): string[] {
  return [...new Set(masters.flatMap((m) => [m.studentGroupId, ...m.extraGroups.map((g) => g.studentGroupId)]))];
}

function toScheduledMaster(m: MasterRow, read: LoadRead): ScheduledMaster {
  return {
    id: m.id,
    subjectId: m.subjectId,
    subjectName: m.subject.name,
    studentGroupId: m.studentGroupId,
    groupName: m.studentGroup.name ?? read.groupName(m.studentGroupId) ?? '',
    extraGroupIds: m.extraGroups.map((g) => g.studentGroupId),
    teacherId: m.teacherId,
    coTeacherId: m.coTeacherId,
    dayOfWeek: m.dayOfWeek,
    startTime: asClock(m.startTime),
    endTime: asClock(m.endTime),
    recurrence: m.recurrence,
    startDate: asDayOrNull(m.startDate),
    endDate: asDayOrNull(m.endDate),
    isParked: m.isParked,
  };
}
