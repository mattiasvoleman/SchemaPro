import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type PrismaClient, type SupervisionArea, type SupervisionShift } from '@prisma/client';
import { recordRead } from '../access-log/access-log';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { toNioarig, toNioarigSpan, type GradeNumbering } from '../common/grade-numbering';
import { carriesSeconds, minutesOf } from '../common/solver-grid';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { parseDateString, parseTimeString, toWallClock } from '../common/utils/time';
import { PrismaService } from '../database/prisma.service';
import { readYearBoundsForShare, type YearBounds } from '../resources/academic-year-bounds';
import { lockStaffRow } from '../staffing/staff-lock';
import type {
  CreateSupervisionAreaDto,
  CreateSupervisionShiftDto,
  UpdateSupervisionAreaDto,
  UpdateSupervisionShiftDto,
} from './dto/supervision.dto';
import { lessonClashesOf, type ClashLesson, type LessonClash } from './lesson-clashes';
import { supervisionCoverage, type AreaBreak, type CoverageGap } from './supervision-coverage';
import { chargedShift, rastvaktRam, supervisionOfTeachers, type LoadShift, type TeacherSupervision } from './supervision-load';
import { requireUserId } from '../common/utils/request-context';
import { readPassCalendar } from '../cover/supervision-cover-reads';
import { schoolTimezone } from '../cover/cover-context';
import { lockTeachers } from '../cover/cover-decisions';
import { passDates, passRunsOn, passSpan } from './pass-days';

/**
 * Rastvaktsschema (migration 20261207090000): the school's rastvaktsområden,
 * the passes of a läsår's schedule, and the read that lays them over the
 * breaks — which of them nobody watches, and what each teacher's passes
 * come to beside the ram their RASTVAKT uppdrag set.
 *
 * Written by the administrator who writes planering (the routes' @Area and
 * the tables' arms both say so), read by every administrator. A pass is part
 * of the tjänst: the schedule read records EMPLOYMENT in the läslogg for the
 * teachers it names, as the uppdrag list does. An area names nobody and is
 * recorded nowhere.
 */

export interface SupervisionAreaView {
  id: string;
  name: string;
  siteId: string | null;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  duringRasts: boolean;
  duringLunch: boolean;
  guardsNeeded: number;
  countsAsTeaching: boolean;
  /** Passes on the area, every läsår: what a delete takes with it. */
  shiftCount: number;
}

export interface SupervisionShiftView {
  id: string;
  academicYearId: string;
  areaId: string;
  userId: string;
  dayOfWeek: number;
  /** HH:MM */
  startTime: string;
  endTime: string;
  /** yyyy-mm-dd, null for the läsår's own bound; on the pass's weekday when set. */
  validFrom: string | null;
  validTo: string | null;
  note: string | null;
  /**
   * The day the teacher was deactivated (the school's date), null while they
   * are active: the pass watches until the day before.
   */
  inactiveFrom: string | null;
  /**
   * The teacher's lessons of the grundschema the pass runs during. A warning,
   * not a refusal: the pass is saved, and the generator does not read passes
   * yet (lesson-clashes.ts).
   */
  lessonClashes: LessonClash[];
}

/**
 * One of the signed-in person's own passes on a date (Rastvakt i vardagen,
 * 20261210090000): their own pass (OWN), or one they take as vikarie
 * (COVER). Never another person's name, a reason or a note.
 */
export interface WeekPass {
  kind: 'OWN' | 'COVER';
  /** The pass and the date, as the key of the entry. */
  shiftId: string;
  date: string;
  startsAt: string;
  endsAt: string;
  areaName: string;
  siteName: string | null;
  /**
   * OWN: what the vikarietavla decided about the pass that day, when its
   * teacher is relieved of it — a vikarie takes it, or it is left without
   * one. Null when it is theirs to take. Always null for COVER.
   *
   * As the board reads it, so far as the teacher's own rows let it: a
   * decision on an absence no longer ACTIVE (left by an older API) relieves
   * nobody, and neither does a vikarie who is no longer an active teacher.
   * A vikarie who is away themself is the board's to see (another person's
   * absence is not the teacher's to read): until it books a new one, the
   * week still says a vikarie takes the pass, which stays true of the plan.
   */
  handover: 'SUBSTITUTE' | 'NO_COVER' | null;
}

/** The most days the week read answers at once: two weeks, the app's eight days and the web's seven. */
export const MAX_WEEK_DAYS = 14;
export const SUPERVISION_WEEK_RANGE = 'SUPERVISION_WEEK_RANGE';

/** A break or a gap as the page reads it: clocks, not minutes. */
type Clocked<T> = Omit<T, 'start' | 'end' | 'shortFrom' | 'shortTo'> & {
  startTime: string;
  endTime: string;
};
export type SupervisionBreakView = Clocked<AreaBreak>;
export type SupervisionGapView = Clocked<CoverageGap> & { shortFrom: string; shortTo: string };

export interface SupervisionRota {
  academicYearId: string;
  year: { startDate: string; endDate: string };
  areas: SupervisionAreaView[];
  shifts: SupervisionShiftView[];
  breaks: SupervisionBreakView[];
  gaps: SupervisionGapView[];
  /** Each teacher with a pass this year, or a RASTVAKT uppdrag (their ram). */
  teachers: TeacherSupervision[];
}

/** One row of the rota's statement: an area, and one of its passes this year or none. */
interface RotaRow {
  areaId: string;
  name: string;
  siteId: string | null;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  duringRasts: boolean;
  duringLunch: boolean;
  guardsNeeded: number;
  countsAsTeaching: boolean;
  shiftCount: number;
  shiftId: string | null;
  userId: string | null;
  dayOfWeek: number | null;
  startTime: Date | null;
  endTime: Date | null;
  validFrom: Date | null;
  validTo: Date | null;
  note: string | null;
  inactiveFrom: Date | null;
}

export const SUPERVISION_AREA_NAME_TAKEN = 'SUPERVISION_AREA_NAME_TAKEN';
export const SUPERVISION_AREA_LIMIT = 'SUPERVISION_AREA_LIMIT';
export const SUPERVISION_AREA_NOT_FOUND = 'SUPERVISION_AREA_NOT_FOUND';
export const SUPERVISION_SITE_NOT_FOUND = 'SUPERVISION_SITE_NOT_FOUND';
export const SUPERVISION_SHIFT_NOT_FOUND = 'SUPERVISION_SHIFT_NOT_FOUND';
export const SUPERVISION_SHIFT_CLASH = 'SUPERVISION_SHIFT_CLASH';
/** The teacher takes another teacher's pass as vikarie at that time on a date ahead (Rastvakt i vardagen). */
export const SUPERVISION_SHIFT_COVER_CLASH = 'SUPERVISION_SHIFT_COVER_CLASH';
export const SUPERVISION_SHIFT_LIMIT = 'SUPERVISION_SHIFT_LIMIT';
export const SUPERVISION_YEAR_NOT_FOUND = 'SUPERVISION_YEAR_NOT_FOUND';
export const SUPERVISION_TEACHER_INACTIVE = 'SUPERVISION_TEACHER_INACTIVE';
export const SUPERVISION_SHIFT_HAS_COVERS = 'SUPERVISION_SHIFT_HAS_COVERS';
/** The pass was handed to another teacher between this request's read and its locks: read it again. */
export const SUPERVISION_SHIFT_MOVED = 'SUPERVISION_SHIFT_MOVED';

/** More places than any school watches; the page lists them all at once. */
export const MAX_AREAS = 100;
/** Fifty teachers with twenty passes each, twice over; the read lays them all over the year. */
export const MAX_SHIFTS_PER_YEAR = 2000;

const WEEKDAY = ['', 'måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag', 'söndag'];
const asDay = (value: Date) => value.toISOString().slice(0, 10);
const asDayOrNull = (value: Date | null) => (value ? asDay(value) : null);
const dayOrNull = (value: Date | null) => (value === null ? null : asDay(value));
const clock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const minutesOfTime = (value: Date) => value.getUTCHours() * 60 + value.getUTCMinutes();
const dateOrNull = (value: string | null | undefined): Date | null => (value ? parseDateString(value) : null);

function areaView(row: SupervisionArea & { _count?: { shifts: number } }): SupervisionAreaView {
  return {
    id: row.id,
    name: row.name,
    siteId: row.siteId,
    minGradeLevel: row.minGradeLevel,
    maxGradeLevel: row.maxGradeLevel,
    duringRasts: row.duringRasts,
    duringLunch: row.duringLunch,
    guardsNeeded: row.guardsNeeded,
    countsAsTeaching: row.countsAsTeaching,
    shiftCount: row._count?.shifts ?? 0,
  };
}

type ShiftRow = Pick<
  SupervisionShift,
  'id' | 'academicYearId' | 'areaId' | 'userId' | 'dayOfWeek' | 'startTime' | 'endTime' | 'validFrom' | 'validTo' | 'note'
>;

function shiftView(
  row: ShiftRow,
  inactiveFrom: string | null,
  lessons: readonly ClashLesson[],
): SupervisionShiftView {
  const validFrom = dayOrNull(row.validFrom);
  const validTo = dayOrNull(row.validTo);
  return {
    id: row.id,
    academicYearId: row.academicYearId,
    areaId: row.areaId,
    userId: row.userId,
    dayOfWeek: row.dayOfWeek,
    startTime: toWallClock(row.startTime),
    endTime: toWallClock(row.endTime),
    validFrom,
    validTo,
    note: row.note,
    inactiveFrom,
    lessonClashes: lessonClashesOf(
      {
        userId: row.userId,
        dayOfWeek: row.dayOfWeek,
        start: minutesOfTime(row.startTime),
        end: minutesOfTime(row.endTime),
        validFrom,
        validTo,
      },
      lessons,
    ),
  };
}

function normaliseName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') throw new BadRequestException('name: området behöver ett namn.');
  return trimmed;
}

/** Both ends of a span or neither, in order. */
function assertSpan(min: number | null, max: number | null): void {
  if ((min === null) !== (max === null)) {
    throw new BadRequestException(
      'minGradeLevel och maxGradeLevel: ange båda årskurserna, eller ingen för alla stadier.',
    );
  }
  if (min !== null && max !== null && min > max) {
    throw new BadRequestException(`minGradeLevel: årskurs ${min} ligger efter maxGradeLevel, årskurs ${max}.`);
  }
}

/** Whole minutes of one day, start before end: the pass's time as the table holds it. */
function assertWindow(startTime: string, endTime: string): void {
  for (const [field, value] of [
    ['startTime', startTime],
    ['endTime', endTime],
  ] as const) {
    // The DTO's pattern admits 24:00 and 99:99, which parseTimeString would
    // carry past midnight; a pass is inside one day, 00:00 to 23:59.
    if (!/^([01]\d|2[0-3]):[0-5]\d(:\d{2})?$/.test(value)) {
      throw new BadRequestException(`${field}: anges som ett klockslag mellan 00:00 och 23:59.`);
    }
    if (carriesSeconds(value)) throw new BadRequestException(`${field}: anges i hela minuter.`);
  }
  if (minutesOf(endTime) <= minutesOf(startTime)) {
    throw new BadRequestException(
      `endTime: passet slutar (${endTime.slice(0, 5)}) innan eller när det börjar (${startTime.slice(0, 5)}).`,
    );
  }
}

/** Från not after Till, and both inside the läsår (null bounds are the year's). */
function assertDates(year: YearBounds | null, validFrom: Date | null, validTo: Date | null): void {
  if (validFrom && validTo && validTo < validFrom) {
    throw new BadRequestException(`validTo: Till (${asDay(validTo)}) ligger före Från (${asDay(validFrom)}).`);
  }
  if (!year) return;
  for (const [field, value] of [
    ['validFrom', validFrom],
    ['validTo', validTo],
  ] as const) {
    if (value && (value < year.startDate || value > year.endDate)) {
      throw new BadRequestException(
        `${field}: ${asDay(value)} ligger utanför läsåret (${asDay(year.startDate)} – ${asDay(year.endDate)}). ` +
          'Ett pass gäller inom sitt läsår; lämna fältet tomt för läsårets egen gräns.',
      );
    }
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const isoWeekday = (value: Date) => (value.getUTCDay() === 0 ? 7 : value.getUTCDay());

/**
 * Från and Till on the pass's weekday, as the table holds them
 * (SupervisionShifts_dates_on_the_weekday): Från forward to the first such
 * day, Till back to the last. A null date stays null, the läsår's own bound,
 * and is read as that bound when asking whether the pass runs at all: a
 * Monday pass from Tuesday 8 June in a year that ends Friday 11 June never
 * runs, and is refused rather than charged a week.
 */
function datesOnTheWeekday(
  year: YearBounds,
  validFrom: Date | null,
  validTo: Date | null,
  dayOfWeek: number,
): { validFrom: Date | null; validTo: Date | null } {
  const from = validFrom ?? year.startDate;
  const to = validTo ?? year.endDate;
  const first = new Date(from.getTime() + ((dayOfWeek - isoWeekday(from) + 7) % 7) * DAY_MS);
  const last = new Date(to.getTime() - ((isoWeekday(to) - dayOfWeek + 7) % 7) * DAY_MS);
  if (first > last) {
    // Said at the date the admin wrote: Från when Till is the year's own.
    const field = validFrom && !validTo ? 'validFrom' : 'validTo';
    throw new BadRequestException(
      `${field}: ingen ${WEEKDAY[dayOfWeek]} ligger mellan ${asDay(from)} och ${asDay(to)}, så passet skulle aldrig gå.`,
    );
  }
  return { validFrom: validFrom ? first : null, validTo: validTo ? last : null };
}

/**
 * A stored date of a pass moved to its new weekday: the same ISO week, so a
 * pass from Monday 11 January to Monday 1 March moved to Wednesdays runs from
 * the 13th to Wednesday 3 March and loses no week at either end. Kept inside
 * the läsår; datesOnTheWeekday then moves a date the bound pushed off the
 * weekday inward.
 */
function sameWeek(stored: Date | null, from: number, to: number, year: YearBounds): Date | null {
  if (stored === null) return null;
  const moved = new Date(stored.getTime() + (to - from) * DAY_MS);
  return moved < year.startDate ? year.startDate : moved > year.endDate ? year.endDate : moved;
}

/** A pass write's errors: the EXCLUDE constraint as the clash the check answers, the rest as every write maps it. */
function rethrowShiftError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const cause = (error.meta as { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } | undefined)
      ?.driverAdapterError?.cause;
    const text = typeof cause?.originalMessage === 'string' ? cause.originalMessage : error.message;
    if (cause?.originalCode === '23P01' || text.includes('SupervisionShifts_one_place_at_a_time')) {
      throw new ConflictException({
        message: 'Läraren har redan ett pass som delar en minut med det här samma dag. En rastvakt är på ett ställe i taget.',
        code: SUPERVISION_SHIFT_CLASH,
      });
    }
  }
  rethrowPrismaError(error);
}

/** One writer of a school's areas at a time: the count against MAX_AREAS and the name are then exact. */
async function lockAreas(tx: PrismaClient, schoolId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`SupervisionAreas:${schoolId}`}, 0))`);
}

/**
 * The rows of the passes an edit is about, FOR UPDATE, before it asks for the
 * board's decisions: a decision being written holds its pass FOR SHARE
 * (src/cover/supervision-cover-reads.ts lockShiftForShare), so the two wait
 * for each other and the question below sees every decision there is. Id
 * order, so two editors never deadlock on each other. $executeRaw: nothing
 * is read back.
 */
async function lockShiftsForUpdate(tx: PrismaClient, where: { id: string } | { areaId: string }): Promise<void> {
  if ('id' in where) {
    await tx.$executeRaw(Prisma.sql`SELECT 1 FROM "SupervisionShifts" WHERE "id" = ${where.id}::uuid FOR UPDATE`);
  } else {
    await tx.$executeRaw(
      Prisma.sql`SELECT 1 FROM "SupervisionShifts" WHERE "areaId" = ${where.areaId}::uuid ORDER BY "id" FOR UPDATE`,
    );
  }
}

/**
 * Rastvakt i vardagen (20261210090000): a pass or an area with a decision of
 * the vikarietavla on a date not yet passed is not moved, handed on or
 * deleted under it. The decision holds the time and the place the vikarie
 * was told; changing the pass would leave them watching a pass that is no
 * longer there, or the yard empty. `left` says which of the decisions the
 * edit would leave behind; the 409 names how many and the first date, and
 * the board is where they are undone (and the vikarie told).
 */
async function refuseCoversLeftBehind(
  tx: PrismaClient,
  where: { shiftId: string } | { areaId: string },
  left: (date: string) => boolean = () => true,
): Promise<void> {
  const rows = await tx.supervisionCover.findMany({
    where: { ...where, endsAt: { gt: new Date() } },
    select: { date: true },
    orderBy: [{ date: 'asc' }],
  });
  const behind = rows.map((row) => asDay(row.date)).filter(left);
  if (behind.length > 0) {
    throw new ConflictException({
      message:
        `Vikarietavlan har ${behind.length === 1 ? 'ett beslut' : `${behind.length} beslut`} om passet från ${behind[0]}. ` +
        'Ångra dem på vikarietavlan först, så får vikarien veta det.',
      code: SUPERVISION_SHIFT_HAS_COVERS,
      params: { count: behind.length, date: behind[0]! },
    });
  }
}

/** One writer of a läsår's schedule at a time, for the count against MAX_SHIFTS_PER_YEAR. */
async function lockSchedule(tx: PrismaClient, academicYearId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`SupervisionShifts:${academicYearId}`}, 0))`);
}

const nameTaken = () =>
  new ConflictException({ message: 'Skolan har redan ett rastvaktsområde med det namnet.', code: SUPERVISION_AREA_NAME_TAKEN });

@Injectable()
export class SupervisionService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Areas
  // ---------------------------------------------------------------------------

  async listAreas(user: AuthenticatedUser): Promise<SupervisionAreaView[]> {
    const schoolId = requireSchoolId(user);
    const rows = await this.prisma.withRls(user, (tx) =>
      tx.supervisionArea.findMany({
        where: { schoolId },
        include: { _count: { select: { shifts: true } } },
      }),
    );
    return rows.map(areaView).sort((a, b) => a.name.localeCompare(b.name, 'sv'));
  }

  async createArea(dto: CreateSupervisionAreaDto, user: AuthenticatedUser): Promise<SupervisionAreaView> {
    const schoolId = requireSchoolId(user);
    const name = normaliseName(dto.name);
    const minGradeLevel = dto.minGradeLevel ?? null;
    const maxGradeLevel = dto.maxGradeLevel ?? null;
    assertSpan(minGradeLevel, maxGradeLevel);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        await lockAreas(tx, schoolId);
        if ((await tx.supervisionArea.count({ where: { schoolId } })) >= MAX_AREAS) {
          throw new ConflictException({ message: `En skola har högst ${MAX_AREAS} rastvaktsområden.`, code: SUPERVISION_AREA_LIMIT });
        }
        await this.assertSite(tx, schoolId, dto.siteId ?? null);
        const row = await tx.supervisionArea.create({
          data: {
            schoolId,
            name,
            siteId: dto.siteId ?? null,
            minGradeLevel,
            maxGradeLevel,
            duringRasts: dto.duringRasts ?? true,
            duringLunch: dto.duringLunch ?? false,
            guardsNeeded: dto.guardsNeeded ?? 1,
            countsAsTeaching: dto.countsAsTeaching ?? false,
          },
        });
        return areaView(row);
      });
    } catch (error) {
      this.rethrowArea(error);
    }
  }

  async updateArea(id: string, dto: UpdateSupervisionAreaDto, user: AuthenticatedUser): Promise<SupervisionAreaView> {
    const schoolId = requireSchoolId(user);
    const name = dto.name === undefined ? undefined : normaliseName(dto.name);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        await lockAreas(tx, schoolId);
        const current = await tx.supervisionArea.findFirst({ where: { id, schoolId } });
        if (!current) throw new NotFoundException({ message: 'Rastvaktsområdet finns inte.', code: SUPERVISION_AREA_NOT_FOUND });
        // The span as it will END UP: a PATCH may carry one end.
        const minGradeLevel = dto.minGradeLevel !== undefined ? dto.minGradeLevel : current.minGradeLevel;
        const maxGradeLevel = dto.maxGradeLevel !== undefined ? dto.maxGradeLevel : current.maxGradeLevel;
        assertSpan(minGradeLevel, maxGradeLevel);
        if (dto.siteId !== undefined) await this.assertSite(tx, schoolId, dto.siteId);
        const row = await tx.supervisionArea.update({
          where: { id },
          data: {
            ...(name !== undefined ? { name } : {}),
            ...(dto.siteId !== undefined ? { siteId: dto.siteId } : {}),
            minGradeLevel,
            maxGradeLevel,
            ...(dto.duringRasts !== undefined ? { duringRasts: dto.duringRasts } : {}),
            ...(dto.duringLunch !== undefined ? { duringLunch: dto.duringLunch } : {}),
            ...(dto.guardsNeeded !== undefined ? { guardsNeeded: dto.guardsNeeded } : {}),
            ...(dto.countsAsTeaching !== undefined ? { countsAsTeaching: dto.countsAsTeaching } : {}),
          },
          include: { _count: { select: { shifts: true } } },
        });
        return areaView(row);
      });
    } catch (error) {
      this.rethrowArea(error);
    }
  }

  /** Its passes go with it (ON DELETE CASCADE); the page has said how many. */
  async removeArea(id: string, user: AuthenticatedUser): Promise<void> {
    const schoolId = requireSchoolId(user);
    try {
      await this.prisma.withRls(user, async (tx) => {
        await lockAreas(tx, schoolId);
        // Its passes go with it, and with them the board's decisions on them.
        await lockShiftsForUpdate(tx, { areaId: id });
        await refuseCoversLeftBehind(tx, { areaId: id });
        const { count } = await tx.supervisionArea.deleteMany({ where: { id, schoolId } });
        if (count === 0) throw new NotFoundException({ message: 'Rastvaktsområdet finns inte.', code: SUPERVISION_AREA_NOT_FOUND });
      });
    } catch (error) {
      this.rethrowArea(error);
    }
  }

  /** A site the body names is the school's (the composite key says so too; this names it). */
  private async assertSite(tx: PrismaClient, schoolId: string, siteId: string | null): Promise<void> {
    if (siteId === null) return;
    const site = await tx.site.findFirst({ where: { id: siteId, schoolId }, select: { id: true } });
    if (!site) {
      throw new ConflictException({ message: 'Skolområdet finns inte längre.', code: SUPERVISION_SITE_NOT_FOUND });
    }
  }

  private rethrowArea(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw nameTaken();
    rethrowPrismaError(error);
  }

  // ---------------------------------------------------------------------------
  // Passes
  // ---------------------------------------------------------------------------

  async createShift(dto: CreateSupervisionShiftDto, user: AuthenticatedUser): Promise<SupervisionShiftView> {
    const schoolId = requireSchoolId(user);
    assertWindow(dto.startTime, dto.endTime);
    const typedFrom = dateOrNull(dto.validFrom);
    const typedTo = dateOrNull(dto.validTo);
    assertDates(null, typedFrom, typedTo);
    const note = dto.note?.trim() || null;
    try {
      return await this.prisma.withRls(user, async (tx) => {
        // The vikarietavla's per-teacher lock FIRST (Rastvakt i vardagen): a
        // decision booking this teacher as vikarie at the same time takes it
        // too, so one of the two sees the other's row (assertOnePlace here,
        // BUSY_SUPERVISION there). Before every row lock, as every holder of
        // it takes it: the teacher, then the pass, never the other way round.
        await lockTeachers(tx, [dto.userId]);
        await lockSchedule(tx, dto.academicYearId);
        // The person is staff, and stays staff (and active) until this commits.
        await lockStaffRow(tx, dto.userId, 'rastvaktspass');
        await this.assertActive(tx, dto.userId);
        const year = await readYearBoundsForShare(tx, dto.academicYearId);
        if (!year) throw new NotFoundException({ message: 'Läsåret finns inte.', code: SUPERVISION_YEAR_NOT_FOUND });
        assertDates(year, typedFrom, typedTo);
        const { validFrom, validTo } = datesOnTheWeekday(year, typedFrom, typedTo, dto.dayOfWeek);
        await this.assertArea(tx, dto.areaId);
        if ((await tx.supervisionShift.count({ where: { academicYearId: dto.academicYearId } })) >= MAX_SHIFTS_PER_YEAR) {
          throw new ConflictException({
            message: `Ett läsår har högst ${MAX_SHIFTS_PER_YEAR} rastvaktspass.`,
            code: SUPERVISION_SHIFT_LIMIT,
          });
        }
        const candidate = {
          academicYearId: dto.academicYearId,
          userId: dto.userId,
          dayOfWeek: dto.dayOfWeek,
          startTime: parseTimeString(dto.startTime),
          endTime: parseTimeString(dto.endTime),
          validFrom,
          validTo,
        };
        await this.assertOnePlace(tx, null, candidate);
        const row = await tx.supervisionShift.create({
          data: { schoolId, areaId: dto.areaId, note, ...candidate },
        });
        return this.viewOf(tx, row);
      });
    } catch (error) {
      rethrowShiftError(error);
    }
  }

  async updateShift(id: string, dto: UpdateSupervisionShiftDto, user: AuthenticatedUser): Promise<SupervisionShiftView> {
    requireSchoolId(user);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        const current = await tx.supervisionShift.findUnique({ where: { id } });
        if (!current) throw new NotFoundException({ message: 'Passet finns inte.', code: SUPERVISION_SHIFT_NOT_FOUND });
        // The vikarietavla's per-teacher locks first, for the teacher it has
        // and the one it is given (see createShift): before the schedule and
        // the pass row, which a decision holding them takes after them.
        await lockTeachers(tx, [current.userId, ...(dto.userId ? [dto.userId] : [])]);
        await lockSchedule(tx, current.academicYearId);
        await lockShiftsForUpdate(tx, { id });
        // The row again, under the schedule's lock: a PATCH beside it may have moved it.
        const locked = await tx.supervisionShift.findUnique({ where: { id } });
        if (!locked) throw new NotFoundException({ message: 'Passet finns inte.', code: SUPERVISION_SHIFT_NOT_FOUND });
        // Handed on between the read and the locks: the locks are the wrong teacher's.
        if (locked.userId !== current.userId) {
          throw new ConflictException({ message: 'Passet har ändrats sedan det lästes. Läs om sidan.', code: SUPERVISION_SHIFT_MOVED });
        }
        // The window and the dates as they will END UP: a PATCH may carry one end.
        const startTime = dto.startTime ?? toWallClock(locked.startTime);
        const endTime = dto.endTime ?? toWallClock(locked.endTime);
        assertWindow(startTime, endTime);
        let validFrom = dto.validFrom !== undefined ? dateOrNull(dto.validFrom) : locked.validFrom;
        let validTo = dto.validTo !== undefined ? dateOrNull(dto.validTo) : locked.validTo;
        const dayOfWeek = dto.dayOfWeek ?? locked.dayOfWeek;
        assertDates(null, validFrom, validTo);
        const userId = dto.userId ?? locked.userId;
        await lockStaffRow(tx, userId, 'rastvaktspass');
        // A pass given to someone else goes to an active teacher. A
        // deactivated teacher's own pass can still be dated or moved: the
        // page ends it there before the break is handed on.
        if (userId !== locked.userId) await this.assertActive(tx, userId);
        // New dates, or a new weekday the stored dates must move onto.
        let bounds: YearBounds | null = null;
        if (dto.validFrom !== undefined || dto.validTo !== undefined || dayOfWeek !== locked.dayOfWeek) {
          const year = await readYearBoundsForShare(tx, locked.academicYearId);
          bounds = year;
          if (!year) throw new NotFoundException({ message: 'Läsåret finns inte.', code: SUPERVISION_YEAR_NOT_FOUND });
          // A stored date the PATCH does not retype follows the pass to its
          // new weekday within its week; a retyped one is the admin's.
          if (dayOfWeek !== locked.dayOfWeek) {
            if (dto.validFrom === undefined) validFrom = sameWeek(locked.validFrom, locked.dayOfWeek, dayOfWeek, year);
            if (dto.validTo === undefined) validTo = sameWeek(locked.validTo, locked.dayOfWeek, dayOfWeek, year);
          }
          assertDates(year, validFrom, validTo);
          ({ validFrom, validTo } = datesOnTheWeekday(year, validFrom, validTo, dayOfWeek));
        }
        if (dto.areaId !== undefined && dto.areaId !== locked.areaId) await this.assertArea(tx, dto.areaId);
        const candidate = {
          academicYearId: locked.academicYearId,
          userId,
          dayOfWeek,
          startTime: parseTimeString(startTime),
          endTime: parseTimeString(endTime),
          validFrom,
          validTo,
        };
        // The passes taken as vikarie are asked only when the teacher, the
        // weekday, the time or the dates change: the board never books a
        // teacher over their own pass (BUSY_SUPERVISION), so a note cannot clash.
        const placed =
          candidate.userId !== locked.userId ||
          candidate.dayOfWeek !== locked.dayOfWeek ||
          toWallClock(candidate.startTime) !== toWallClock(locked.startTime) ||
          toWallClock(candidate.endTime) !== toWallClock(locked.endTime) ||
          asDayOrNull(candidate.validFrom) !== asDayOrNull(locked.validFrom) ||
          asDayOrNull(candidate.validTo) !== asDayOrNull(locked.validTo);
        await this.assertOnePlace(tx, id, candidate, placed);
        // The board's decisions ahead hold this pass's teacher, place and
        // time; new dates may leave some of them outside. The note is free.
        const moved =
          candidate.userId !== locked.userId ||
          (dto.areaId !== undefined && dto.areaId !== locked.areaId) ||
          candidate.dayOfWeek !== locked.dayOfWeek ||
          toWallClock(candidate.startTime) !== toWallClock(locked.startTime) ||
          toWallClock(candidate.endTime) !== toWallClock(locked.endTime);
        if (moved) {
          await refuseCoversLeftBehind(tx, { shiftId: id });
        } else if (bounds) {
          const first = asDay(validFrom ?? bounds.startDate);
          const last = asDay(validTo ?? bounds.endDate);
          await refuseCoversLeftBehind(tx, { shiftId: id }, (date) => date < first || date > last);
        }
        const row = await tx.supervisionShift.update({
          where: { id },
          data: {
            ...(dto.areaId !== undefined ? { areaId: dto.areaId } : {}),
            userId: candidate.userId,
            dayOfWeek: candidate.dayOfWeek,
            startTime: candidate.startTime,
            endTime: candidate.endTime,
            validFrom,
            validTo,
            ...(dto.note !== undefined ? { note: dto.note?.trim() || null } : {}),
          },
        });
        return this.viewOf(tx, row);
      });
    } catch (error) {
      rethrowShiftError(error);
    }
  }

  async removeShift(id: string, user: AuthenticatedUser): Promise<void> {
    requireSchoolId(user);
    try {
      await this.prisma.withRls(user, async (tx) => {
        await lockShiftsForUpdate(tx, { id });
        await refuseCoversLeftBehind(tx, { shiftId: id });
        const { count } = await tx.supervisionShift.deleteMany({ where: { id } });
        if (count === 0) throw new NotFoundException({ message: 'Passet finns inte.', code: SUPERVISION_SHIFT_NOT_FOUND });
      });
    } catch (error) {
      rethrowShiftError(error);
    }
  }

  /** A new pass, or a pass handed on, goes to a teacher who is active; the row is locked (lockStaffRow), so they stay so. */
  private async assertActive(tx: PrismaClient, userId: string): Promise<void> {
    const person = await tx.user.findUnique({ where: { id: userId }, select: { isActive: true } });
    if (person && !person.isActive) {
      throw new ConflictException({
        message: 'Läraren är avaktiverad och kan inte få ett rastvaktspass.',
        code: SUPERVISION_TEACHER_INACTIVE,
      });
    }
  }

  /** The day the teacher was deactivated, in the school's time zone; null while active. */
  private async inactiveFromOf(tx: PrismaClient, userId: string): Promise<string | null> {
    const [row] = await tx.$queryRaw<{ inactiveFrom: Date }[]>`
      SELECT (u."deactivatedAt" AT TIME ZONE s."timezone")::date AS "inactiveFrom"
      FROM "Users" u
      JOIN "Schools" s ON s."id" = u."schoolId"
      WHERE u."id" = ${userId}::uuid AND NOT u."isActive"
    `;
    return row ? asDay(row.inactiveFrom) : null;
  }

  /** The year's lessons the passes' teachers teach or co-teach on the passes' weekdays: what a pass may clash with. */
  private async lessonsOf(
    tx: PrismaClient,
    academicYearId: string,
    shifts: readonly Pick<SupervisionShift, 'userId' | 'dayOfWeek'>[],
  ): Promise<ClashLesson[]> {
    const userIds = [...new Set(shifts.map((row) => row.userId))];
    if (userIds.length === 0) return [];
    const rows = await tx.masterLesson.findMany({
      where: {
        academicYearId,
        isParked: false,
        dayOfWeek: { in: [...new Set(shifts.map((row) => row.dayOfWeek))] },
        OR: [{ teacherId: { in: userIds } }, { coTeacherId: { in: userIds } }],
      },
      select: {
        teacherId: true,
        coTeacherId: true,
        dayOfWeek: true,
        startTime: true,
        endTime: true,
        startDate: true,
        endDate: true,
        subject: { select: { name: true } },
        studentGroup: { select: { name: true } },
      },
    });
    return rows.map((row) => ({
      teacherIds: [row.teacherId, row.coTeacherId],
      dayOfWeek: row.dayOfWeek,
      start: minutesOfTime(row.startTime),
      end: minutesOfTime(row.endTime),
      startDate: dayOrNull(row.startDate),
      endDate: dayOrNull(row.endDate),
      subject: row.subject.name,
      group: row.studentGroup.name,
    }));
  }

  /** A pass as a write answers it: with its teacher's state and the lessons it runs during. */
  private async viewOf(tx: PrismaClient, row: ShiftRow): Promise<SupervisionShiftView> {
    return shiftView(row, await this.inactiveFromOf(tx, row.userId), await this.lessonsOf(tx, row.academicYearId, [row]));
  }

  private async assertArea(tx: PrismaClient, areaId: string): Promise<void> {
    const area = await tx.supervisionArea.findUnique({ where: { id: areaId }, select: { id: true } });
    if (!area) {
      throw new ConflictException({ message: 'Rastvaktsområdet finns inte längre.', code: SUPERVISION_AREA_NOT_FOUND });
    }
  }

  /**
   * One place at a time: no other pass of the teacher in the year, on the
   * weekday, shares a minute with this one on a date both run. The EXCLUDE
   * constraint holds the same rule when two saves race; this names the pass.
   */
  private async assertOnePlace(
    tx: PrismaClient,
    selfId: string | null,
    candidate: {
      academicYearId: string;
      userId: string;
      dayOfWeek: number;
      startTime: Date;
      endTime: Date;
      validFrom: Date | null;
      validTo: Date | null;
    },
    asksCovers = true,
  ): Promise<void> {
    const other = await tx.supervisionShift.findFirst({
      where: {
        academicYearId: candidate.academicYearId,
        userId: candidate.userId,
        dayOfWeek: candidate.dayOfWeek,
        ...(selfId ? { id: { not: selfId } } : {}),
        startTime: { lt: candidate.endTime },
        endTime: { gt: candidate.startTime },
        AND: [
          ...(candidate.validTo ? [{ OR: [{ validFrom: null }, { validFrom: { lte: candidate.validTo } }] }] : []),
          ...(candidate.validFrom ? [{ OR: [{ validTo: null }, { validTo: { gte: candidate.validFrom } }] }] : []),
        ],
      },
      include: { area: { select: { name: true } } },
    });
    if (other) {
      throw new ConflictException({
        message:
          `Läraren har redan rastvakt i ${other.area.name} ${WEEKDAY[other.dayOfWeek]} ` +
          `${toWallClock(other.startTime)}–${toWallClock(other.endTime)}. En rastvakt är på ett ställe i taget.`,
        code: SUPERVISION_SHIFT_CLASH,
      });
    }
    // The passes they take as vikarie on the vikarietavla, on a date ahead
    // (Rastvakt i vardagen, 20261210090000): the same one place at a time.
    // Asked only of the decisions that exist, which most schools have none of.
    if (!asksCovers) return;
    const taken = await tx.supervisionCover.findMany({
      where: { substituteId: candidate.userId, decision: 'SUBSTITUTE', endsAt: { gt: new Date() } },
      select: { date: true, startsAt: true, endsAt: true, areaId: true },
      orderBy: { date: 'asc' },
    });
    if (taken.length === 0) return;
    const year = await tx.academicYear.findUnique({
      where: { id: candidate.academicYearId },
      select: { startDate: true, endDate: true, schoolId: true },
    });
    if (!year) return;
    const timezone = await schoolTimezone(tx, year.schoolId);
    const first = asDay(candidate.validFrom ?? year.startDate);
    const last = asDay(candidate.validTo ?? year.endDate);
    const rule = {
      dayOfWeek: candidate.dayOfWeek,
      start: minutesOfTime(candidate.startTime),
      end: minutesOfTime(candidate.endTime),
      validFrom: null,
      validTo: null,
    };
    const clash = taken.find((row) => {
      const date = asDay(row.date);
      if (date < first || date > last || (parseDateString(date).getUTCDay() || 7) !== candidate.dayOfWeek) return false;
      const span = passSpan(rule, date, timezone);
      return span.startsAt < row.endsAt && span.endsAt > row.startsAt;
    });
    if (clash) {
      const area = await tx.supervisionArea.findUnique({ where: { id: clash.areaId }, select: { name: true } });
      const date = asDay(clash.date);
      throw new ConflictException({
        message:
          `Läraren tar rastvakten i ${area?.name ?? 'ett annat område'} som vikarie ${date}, samtidigt som passet. ` +
          'En rastvakt är på ett ställe i taget: ångra beslutet på vikarietavlan först.',
        code: SUPERVISION_SHIFT_COVER_CLASH,
        params: { date, area: area?.name ?? '' },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // The schedule
  // ---------------------------------------------------------------------------

  /**
   * THE SIGNED-IN PERSON'S OWN PASSES over a few days (Rastvakt i vardagen,
   * 20261210090000), for their week on the web and in the app: each date
   * their own passes run (pass-days.ts: weekday, dates, no lov closing the
   * area, until a deactivation), with what the vikarietavla decided when they
   * are away, and the passes they take as vikarie for somebody else.
   *
   * Read as themself, under their own arms (their passes, the decisions that
   * name them as the vikarie or the absent, the areas and the sites every
   * member of staff reads), and always for themself whatever their role: no
   * query parameter names anybody, so there is nothing to log in the
   * läslogg. A vikarie's entry names the place and the time and never whose
   * pass it is; the absent teacher's says that a vikarie takes it and never
   * who.
   */
  async week(from: string, to: string, user: AuthenticatedUser): Promise<{ from: string; to: string; passes: WeekPass[] }> {
    const schoolId = requireSchoolId(user);
    if (to < from) {
      throw new BadRequestException({ message: 'to: tidigast samma dag som from.', code: SUPERVISION_WEEK_RANGE });
    }
    if (parseDateString(to).getTime() - parseDateString(from).getTime() > (MAX_WEEK_DAYS - 1) * DAY_MS) {
      throw new BadRequestException({ message: `Högst ${MAX_WEEK_DAYS} dagar åt gången.`, code: SUPERVISION_WEEK_RANGE });
    }
    // Huvudman (20261212090000): the huvudman's reader has no row at the
    // school, so no pass of their own: the week of a läsare who has none.
    if (user.huvudman && !user.userId) return { from, to, passes: [] };
    const me = requireUserId(user);
    return this.prisma.withRls(user, async (tx) => {
      const timezone = await schoolTimezone(tx, schoolId);
      const shifts = await tx.supervisionShift.findMany({
        where: {
          userId: me,
          academicYear: { startDate: { lte: parseDateString(to) }, endDate: { gte: parseDateString(from) } },
        },
        select: {
          id: true,
          academicYearId: true,
          areaId: true,
          userId: true,
          dayOfWeek: true,
          startTime: true,
          endTime: true,
          validFrom: true,
          validTo: true,
        },
      });
      const covers = await tx.supervisionCover.findMany({
        where: {
          date: { gte: parseDateString(from), lte: parseDateString(to) },
          OR: [
            { substituteId: me, decision: 'SUBSTITUTE' },
            ...(shifts.length > 0 ? [{ shiftId: { in: shifts.map((row) => row.id) } }] : []),
          ],
        },
        select: {
          shiftId: true,
          date: true,
          areaId: true,
          startsAt: true,
          endsAt: true,
          decision: true,
          substituteId: true,
          absenceId: true,
          absentTeacherId: true,
        },
      });
      if (shifts.length === 0 && covers.length === 0) return { from, to, passes: [] };
      const taken = covers.filter((row) => row.decision === 'SUBSTITUTE' && row.substituteId === me);
      // The years a pass taken as vikarie falls in: whether it still runs that
      // day is the area's, the year's and its teacher's, never the pass row
      // (another teacher's, which is not the vikarie's to read). Its weekday
      // and dates cannot move while the decision stands (SUPERVISION_SHIFT_HAS_COVERS).
      const takenYears =
        taken.length > 0
          ? await tx.academicYear.findMany({
              where: { startDate: { lte: parseDateString(to) }, endDate: { gte: parseDateString(from) } },
              select: { id: true, startDate: true, endDate: true },
            })
          : [];
      const calendar = await readPassCalendar(tx, {
        areaIds: [...shifts.map((row) => row.areaId), ...covers.map((row) => row.areaId)],
        yearIds: [...shifts.map((row) => row.academicYearId), ...takenYears.map((row) => row.id)],
        teacherIds: [...shifts.map((row) => row.userId), ...taken.map((row) => row.absentTeacherId)],
        timezone,
      });
      // What relieves the teacher of their own pass, as the board reads it.
      const own = covers.filter((row) => row.absentTeacherId === me);
      const leftBehind =
        own.length > 0
          ? new Set(
              (
                await tx.teacherAbsence.findMany({
                  where: { id: { in: [...new Set(own.map((row) => row.absenceId))] }, status: { not: 'ACTIVE' } },
                  select: { id: true },
                })
              ).map((row) => row.id),
            )
          : new Set<string>();
      const vikarier = [...new Set(own.flatMap((row) => (row.decision === 'SUBSTITUTE' && row.substituteId ? [row.substituteId] : [])))];
      const gone =
        vikarier.length > 0
          ? new Set(
              (
                await tx.user.findMany({
                  where: { id: { in: vikarier }, OR: [{ isActive: false }, { role: { not: 'TEACHER' } }] },
                  select: { id: true },
                })
              ).map((row) => row.id),
            )
          : new Set<string>();
      const relieves = (row: (typeof covers)[number]) =>
        !leftBehind.has(row.absenceId) && !(row.decision === 'SUBSTITUTE' && row.substituteId !== null && gone.has(row.substituteId));
      const siteIds = [...new Set([...calendar.areas.values()].flatMap((area) => (area.siteId ? [area.siteId] : [])))];
      const sites =
        siteIds.length > 0 ? await tx.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, name: true } }) : [];
      const siteName = new Map(sites.map((site) => [site.id, site.name]));
      const placeOf = (areaId: string) => {
        const area = calendar.areas.get(areaId);
        return { areaName: area?.name ?? '', siteName: area?.siteId ? (siteName.get(area.siteId) ?? null) : null };
      };
      const decided = new Map(own.filter(relieves).map((row) => [`${row.shiftId}:${asDay(row.date)}`, row]));
      const passes: WeekPass[] = [];
      for (const row of shifts) {
        const year = calendar.years.get(row.academicYearId);
        const area = calendar.areas.get(row.areaId);
        if (!year || !area) continue;
        const rule = {
          dayOfWeek: row.dayOfWeek,
          start: minutesOfTime(row.startTime),
          end: minutesOfTime(row.endTime),
          validFrom: dayOrNull(row.validFrom),
          validTo: dayOrNull(row.validTo),
          inactiveFrom: calendar.inactiveFrom.get(row.userId) ?? null,
        };
        for (const date of passDates(rule, area, year, calendar.closures.get(row.academicYearId) ?? [], from, to)) {
          const span = passSpan(rule, date, timezone);
          const decision = decided.get(`${row.id}:${date}`);
          passes.push({
            kind: 'OWN',
            shiftId: row.id,
            date,
            startsAt: span.startsAt.toISOString(),
            endsAt: span.endsAt.toISOString(),
            ...placeOf(row.areaId),
            handover: decision ? decision.decision : null,
          });
        }
      }
      for (const row of taken) {
        const date = asDay(row.date);
        const area = calendar.areas.get(row.areaId);
        const year = takenYears.find((candidate) => asDay(candidate.startDate) <= date && asDay(candidate.endDate) >= date);
        const weekday = parseDateString(date).getUTCDay() || 7;
        // A lov added since, the area's årskurser changed, its teacher
        // deactivated or the läsår shortened: nobody is needed there, and the
        // board offers Ångra, which tells the vikarie. Until then, not in their week.
        const runs =
          area !== undefined &&
          year !== undefined &&
          passRunsOn(
            { dayOfWeek: weekday, start: 0, end: 1, validFrom: null, validTo: null, inactiveFrom: calendar.inactiveFrom.get(row.absentTeacherId) ?? null },
            area,
            { startDate: asDay(year.startDate), endDate: asDay(year.endDate) },
            calendar.closures.get(year.id) ?? [],
            date,
          );
        if (!runs) continue;
        passes.push({
          kind: 'COVER',
          shiftId: row.shiftId,
          date: asDay(row.date),
          startsAt: row.startsAt.toISOString(),
          endsAt: row.endsAt.toISOString(),
          ...placeOf(row.areaId),
          handover: null,
        });
      }
      passes.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.kind.localeCompare(b.kind) || a.shiftId.localeCompare(b.shiftId));
      return { from, to, passes };
    });
  }

  /**
   * The läsår's schedule over its breaks: the areas, the year's passes, the
   * rasts and the meal, the year's lov and classes, and the RASTVAKT uppdrag
   * that are each teacher's ram. The areas, the passes and whether each
   * pass's teacher is active are ONE statement, so a pass is never read
   * without its area or beside an area list from before it (read committed
   * gives each statement its own snapshot). The rest is the school's
   * calendar, read in the same transaction.
   */
  async rota(academicYearId: string, user: AuthenticatedUser): Promise<SupervisionRota> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const yearRow = await tx.academicYear.findUnique({
        where: { id: academicYearId },
        select: { startDate: true, endDate: true, gradeNumbering: true },
      });
      if (!yearRow) throw new NotFoundException({ message: 'Läsåret finns inte.', code: SUPERVISION_YEAR_NOT_FOUND });
      const year = { startDate: asDay(yearRow.startDate), endDate: asDay(yearRow.endDate) };
      const rows = await tx.$queryRaw<RotaRow[]>`
        SELECT a."id" AS "areaId", a."name", a."siteId", a."minGradeLevel", a."maxGradeLevel",
               a."duringRasts", a."duringLunch", a."guardsNeeded", a."countsAsTeaching",
               coalesce(c."shiftCount", 0) AS "shiftCount",
               s."id" AS "shiftId", s."userId", s."dayOfWeek", s."startTime", s."endTime",
               s."validFrom", s."validTo", s."note",
               CASE WHEN u."isActive" THEN NULL
                    ELSE (u."deactivatedAt" AT TIME ZONE sc."timezone")::date END AS "inactiveFrom"
        FROM "SupervisionAreas" a
        JOIN "Schools" sc ON sc."id" = a."schoolId"
        -- Every läsår's passes per area, counted once: what a delete takes with it.
        LEFT JOIN (
          SELECT "areaId", count(*)::int AS "shiftCount"
          FROM "SupervisionShifts"
          WHERE "schoolId" = ${schoolId}::uuid
          GROUP BY "areaId"
        ) c ON c."areaId" = a."id"
        LEFT JOIN "SupervisionShifts" s
          ON s."areaId" = a."id" AND s."schoolId" = a."schoolId" AND s."academicYearId" = ${academicYearId}::uuid
        LEFT JOIN "Users" u ON u."id" = s."userId" AND u."schoolId" = s."schoolId"
        WHERE a."schoolId" = ${schoolId}::uuid
        ORDER BY s."dayOfWeek", s."startTime", s."id"
      `;
      const areaById = new Map<string, SupervisionAreaView>();
      const shifts: (ShiftRow & { inactiveFrom: string | null })[] = [];
      for (const row of rows) {
        if (!areaById.has(row.areaId)) {
          areaById.set(row.areaId, {
            id: row.areaId,
            name: row.name,
            siteId: row.siteId,
            minGradeLevel: row.minGradeLevel,
            maxGradeLevel: row.maxGradeLevel,
            duringRasts: row.duringRasts,
            duringLunch: row.duringLunch,
            guardsNeeded: row.guardsNeeded,
            countsAsTeaching: row.countsAsTeaching,
            shiftCount: Number(row.shiftCount),
          });
        }
        if (row.shiftId !== null) {
          shifts.push({
            id: row.shiftId,
            academicYearId,
            areaId: row.areaId,
            userId: row.userId!,
            dayOfWeek: row.dayOfWeek!,
            startTime: row.startTime!,
            endTime: row.endTime!,
            validFrom: row.validFrom,
            validTo: row.validTo,
            note: row.note,
            inactiveFrom: row.inactiveFrom ? asDay(row.inactiveFrom) : null,
          });
        }
      }
      const areas = [...areaById.values()];
      const rasts = await tx.rast.findMany({
        where: { schoolId },
        select: { name: true, minGradeLevel: true, maxGradeLevel: true, dayOfWeek: true, startTime: true, endTime: true },
      });
      const lunch = await tx.lunchSetting.findUnique({
        where: { schoolId },
        select: { lunchEnabled: true, lunchStartTime: true, lunchEndTime: true },
      });
      // Sittings matter only where the school eats at all.
      const servings = lunch?.lunchEnabled
        ? await tx.lunchServing.findMany({
            where: { schoolId },
            select: { minGradeLevel: true, maxGradeLevel: true, dayOfWeek: true, startTime: true, endTime: true },
          })
        : [];
      // Areas, rasts and sittings are school-wide spans in NIOARIG
      // (grade-numbering.ts); a tioårig läsår's classes and lov, stated in the
      // year's own numbering, are read in it before they meet them.
      const numbering: GradeNumbering = yearRow.gradeNumbering ?? 'NIOARIG';
      const closures = (
        await tx.schoolBreak.findMany({
          where: { academicYearId },
          select: { startDate: true, endDate: true, minGradeLevel: true, maxGradeLevel: true },
        })
      ).map((row) => {
        const span =
          row.minGradeLevel === null || row.maxGradeLevel === null
            ? null
            : toNioarigSpan({ min: row.minGradeLevel, max: row.maxGradeLevel }, numbering);
        return {
          startDate: asDay(row.startDate),
          endDate: asDay(row.endDate),
          minGradeLevel: span?.min ?? row.minGradeLevel,
          maxGradeLevel: span?.max ?? row.maxGradeLevel,
        };
      });
      const grades = await tx.studentGroup.findMany({
        where: { academicYearId, gradeLevel: { not: null } },
        select: { gradeLevel: true },
        distinct: ['gradeLevel'],
      });
      const lessons = await this.lessonsOf(tx, academicYearId, shifts);
      const duties = await tx.teacherDuty.findMany({
        where: { academicYearId, kind: 'RASTVAKT' },
        select: { userId: true, kind: true, minutesPerWeek: true, countsAsTeaching: true, validFrom: true, validTo: true },
      });

      const coverage = supervisionCoverage({
        year,
        closures,
        areas: areas.map((area) => ({
          id: area.id,
          minGradeLevel: area.minGradeLevel,
          maxGradeLevel: area.maxGradeLevel,
          duringRasts: area.duringRasts,
          duringLunch: area.duringLunch,
          guardsNeeded: area.guardsNeeded,
        })),
        rasts,
        servings: servings.map((row) => ({
          minGradeLevel: row.minGradeLevel,
          maxGradeLevel: row.maxGradeLevel,
          dayOfWeek: row.dayOfWeek,
          start: minutesOfTime(row.startTime),
          end: minutesOfTime(row.endTime),
        })),
        lunch: lunch?.lunchEnabled ? { start: minutesOfTime(lunch.lunchStartTime), end: minutesOfTime(lunch.lunchEndTime) } : null,
        grades: [
          ...new Set(
            grades.map((row) => toNioarig(row.gradeLevel, numbering)).filter((grade): grade is number => grade !== null),
          ),
        ],
        shifts: shifts.map((row) => ({
          id: row.id,
          areaId: row.areaId,
          dayOfWeek: row.dayOfWeek,
          start: minutesOfTime(row.startTime),
          end: minutesOfTime(row.endTime),
          validFrom: dayOrNull(row.validFrom),
          validTo: dayOrNull(row.validTo),
          // A deactivated teacher's pass stays on the schedule and watches
          // until the day before they were deactivated.
          ...(row.inactiveFrom ? { inactiveFrom: row.inactiveFrom } : {}),
        })),
      });
      // Charged as the load charges them: a deactivated teacher's until the day before.
      const loadShifts = shifts
        .map((row) =>
          chargedShift(
            {
              userId: row.userId,
              start: minutesOfTime(row.startTime),
              end: minutesOfTime(row.endTime),
              validFrom: dayOrNull(row.validFrom),
              validTo: dayOrNull(row.validTo),
              countsAsTeaching: areaById.get(row.areaId)?.countsAsTeaching ?? false,
            },
            row.inactiveFrom,
            year,
          ),
        )
        .filter((row): row is LoadShift => row !== null);
      const kinded = duties.map((row) => ({
        userId: row.userId,
        kind: row.kind,
        minutesPerWeek: row.minutesPerWeek,
        countsAsTeaching: row.countsAsTeaching,
        ...(row.validFrom ? { validFrom: asDay(row.validFrom) } : {}),
        ...(row.validTo ? { validTo: asDay(row.validTo) } : {}),
      }));
      const withPasses = supervisionOfTeachers(kinded, loadShifts, year, closures);
      // A teacher with a ram and no pass yet is the schedule's to plan too.
      const planned = new Set(withPasses.map((row) => row.userId));
      const ramOnly = [...new Set(kinded.map((row) => row.userId))]
        .filter((userId) => !planned.has(userId))
        .sort()
        .map((userId) => ({
          userId,
          shiftCount: 0,
          minutesPerWeek: 0,
          countedMinutesPerWeek: 0,
          peakMinutesPerWeek: 0,
          hoursPerYear: 0,
          ramMinutesPerWeek: rastvaktRam(kinded, userId, year, closures),
          ramCountedMinutesPerWeek: rastvaktRam(kinded, userId, year, closures) ?? 0,
        }));
      const teachers = [...withPasses, ...ramOnly];
      // Who watches what, and each teacher's ram from their uppdrag: their
      // tjänst, EMPLOYMENT in the läslogg as the uppdrag list records it.
      await recordRead(tx, 'EMPLOYMENT', teachers.map((row) => row.userId), user.channel);

      return {
        academicYearId,
        year,
        areas: areas.sort((a, b) => a.name.localeCompare(b.name, 'sv')),
        shifts: shifts.map((row) => shiftView(row, row.inactiveFrom, lessons)),
        breaks: coverage.breaks.map(({ start, end, ...row }) => ({ ...row, startTime: clock(start), endTime: clock(end) })),
        gaps: coverage.gaps.map(({ start, end, shortFrom, shortTo, ...row }) => ({
          ...row,
          startTime: clock(start),
          endTime: clock(end),
          shortFrom: clock(shortFrom),
          shortTo: clock(shortTo),
        })),
        teachers,
      };
    });
  }
}
