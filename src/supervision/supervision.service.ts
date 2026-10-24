import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type PrismaClient, type SupervisionArea, type SupervisionShift } from '@prisma/client';
import { recordRead } from '../access-log/access-log';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
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
import { supervisionCoverage, type AreaBreak, type CoverageGap } from './supervision-coverage';
import { rastvaktRam, supervisionOfTeachers, type TeacherSupervision } from './supervision-load';

/**
 * Rastvaktsschema (migration 20261202090000): the school's rastvaktsområden,
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
  /** yyyy-mm-dd, null for the läsår's own bound. */
  validFrom: string | null;
  validTo: string | null;
  note: string | null;
}

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

export const SUPERVISION_AREA_NAME_TAKEN = 'SUPERVISION_AREA_NAME_TAKEN';
export const SUPERVISION_AREA_LIMIT = 'SUPERVISION_AREA_LIMIT';
export const SUPERVISION_AREA_NOT_FOUND = 'SUPERVISION_AREA_NOT_FOUND';
export const SUPERVISION_SITE_NOT_FOUND = 'SUPERVISION_SITE_NOT_FOUND';
export const SUPERVISION_SHIFT_NOT_FOUND = 'SUPERVISION_SHIFT_NOT_FOUND';
export const SUPERVISION_SHIFT_CLASH = 'SUPERVISION_SHIFT_CLASH';
export const SUPERVISION_SHIFT_LIMIT = 'SUPERVISION_SHIFT_LIMIT';
export const SUPERVISION_YEAR_NOT_FOUND = 'SUPERVISION_YEAR_NOT_FOUND';

/** More places than any school watches; the page lists them all at once. */
export const MAX_AREAS = 100;
/** Fifty teachers with twenty passes each, twice over; the read lays them all over the year. */
export const MAX_SHIFTS_PER_YEAR = 2000;

const WEEKDAY = ['', 'måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag', 'söndag'];
const asDay = (value: Date) => value.toISOString().slice(0, 10);
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

function shiftView(row: SupervisionShift): SupervisionShiftView {
  return {
    id: row.id,
    academicYearId: row.academicYearId,
    areaId: row.areaId,
    userId: row.userId,
    dayOfWeek: row.dayOfWeek,
    startTime: toWallClock(row.startTime),
    endTime: toWallClock(row.endTime),
    validFrom: dayOrNull(row.validFrom),
    validTo: dayOrNull(row.validTo),
    note: row.note,
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

/** Whole minutes, start before end: the pass's time as the table holds it. */
function assertWindow(startTime: string, endTime: string): void {
  for (const [field, value] of [
    ['startTime', startTime],
    ['endTime', endTime],
  ] as const) {
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
    const validFrom = dateOrNull(dto.validFrom);
    const validTo = dateOrNull(dto.validTo);
    assertDates(null, validFrom, validTo);
    const note = dto.note?.trim() || null;
    try {
      return await this.prisma.withRls(user, async (tx) => {
        await lockSchedule(tx, dto.academicYearId);
        // The person is staff, and stays staff until this commits.
        await lockStaffRow(tx, dto.userId, 'rastvaktspass');
        const year = await readYearBoundsForShare(tx, dto.academicYearId);
        if (!year) throw new NotFoundException({ message: 'Läsåret finns inte.', code: SUPERVISION_YEAR_NOT_FOUND });
        assertDates(year, validFrom, validTo);
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
        return shiftView(row);
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
        await lockSchedule(tx, current.academicYearId);
        // The row again, under the schedule's lock: a PATCH beside it may have moved it.
        const locked = await tx.supervisionShift.findUnique({ where: { id } });
        if (!locked) throw new NotFoundException({ message: 'Passet finns inte.', code: SUPERVISION_SHIFT_NOT_FOUND });
        // The window and the dates as they will END UP: a PATCH may carry one end.
        const startTime = dto.startTime ?? toWallClock(locked.startTime);
        const endTime = dto.endTime ?? toWallClock(locked.endTime);
        assertWindow(startTime, endTime);
        const validFrom = dto.validFrom !== undefined ? dateOrNull(dto.validFrom) : locked.validFrom;
        const validTo = dto.validTo !== undefined ? dateOrNull(dto.validTo) : locked.validTo;
        assertDates(null, validFrom, validTo);
        const userId = dto.userId ?? locked.userId;
        await lockStaffRow(tx, userId, 'rastvaktspass');
        if (dto.validFrom !== undefined || dto.validTo !== undefined) {
          assertDates(await readYearBoundsForShare(tx, locked.academicYearId), validFrom, validTo);
        }
        if (dto.areaId !== undefined && dto.areaId !== locked.areaId) await this.assertArea(tx, dto.areaId);
        const candidate = {
          academicYearId: locked.academicYearId,
          userId,
          dayOfWeek: dto.dayOfWeek ?? locked.dayOfWeek,
          startTime: parseTimeString(startTime),
          endTime: parseTimeString(endTime),
          validFrom,
          validTo,
        };
        await this.assertOnePlace(tx, id, candidate);
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
        return shiftView(row);
      });
    } catch (error) {
      rethrowShiftError(error);
    }
  }

  async removeShift(id: string, user: AuthenticatedUser): Promise<void> {
    requireSchoolId(user);
    try {
      await this.prisma.withRls(user, async (tx) => {
        const { count } = await tx.supervisionShift.deleteMany({ where: { id } });
        if (count === 0) throw new NotFoundException({ message: 'Passet finns inte.', code: SUPERVISION_SHIFT_NOT_FOUND });
      });
    } catch (error) {
      rethrowShiftError(error);
    }
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
  }

  // ---------------------------------------------------------------------------
  // The schedule
  // ---------------------------------------------------------------------------

  /**
   * The läsår's schedule over its breaks, in ONE RLS transaction so the gaps
   * and the minutes agree with the passes listed: the areas, the year's
   * passes, the rasts and the meal, the year's lov and classes, and the
   * RASTVAKT uppdrag that are each teacher's ram.
   */
  async rota(academicYearId: string, user: AuthenticatedUser): Promise<SupervisionRota> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const yearRow = await tx.academicYear.findUnique({
        where: { id: academicYearId },
        select: { startDate: true, endDate: true },
      });
      if (!yearRow) throw new NotFoundException({ message: 'Läsåret finns inte.', code: SUPERVISION_YEAR_NOT_FOUND });
      const year = { startDate: asDay(yearRow.startDate), endDate: asDay(yearRow.endDate) };
      const areas = await tx.supervisionArea.findMany({
        where: { schoolId },
        include: { _count: { select: { shifts: true } } },
      });
      const shifts = await tx.supervisionShift.findMany({
        where: { academicYearId },
        orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }, { id: 'asc' }],
      });
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
      const closures = (
        await tx.schoolBreak.findMany({
          where: { academicYearId },
          select: { startDate: true, endDate: true, minGradeLevel: true, maxGradeLevel: true },
        })
      ).map((row) => ({ ...row, startDate: asDay(row.startDate), endDate: asDay(row.endDate) }));
      const grades = await tx.studentGroup.findMany({
        where: { academicYearId, gradeLevel: { not: null } },
        select: { gradeLevel: true },
        distinct: ['gradeLevel'],
      });
      const duties = await tx.teacherDuty.findMany({
        where: { academicYearId, kind: 'RASTVAKT' },
        select: { userId: true, kind: true, minutesPerWeek: true, countsAsTeaching: true, validFrom: true, validTo: true },
      });

      const areaById = new Map(areas.map((area) => [area.id, area]));
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
        grades: grades.map((row) => row.gradeLevel).filter((grade): grade is number => grade !== null),
        shifts: shifts.map((row) => ({
          id: row.id,
          areaId: row.areaId,
          dayOfWeek: row.dayOfWeek,
          start: minutesOfTime(row.startTime),
          end: minutesOfTime(row.endTime),
          validFrom: dayOrNull(row.validFrom),
          validTo: dayOrNull(row.validTo),
        })),
      });
      const loadShifts = shifts.map((row) => ({
        userId: row.userId,
        start: minutesOfTime(row.startTime),
        end: minutesOfTime(row.endTime),
        validFrom: dayOrNull(row.validFrom),
        validTo: dayOrNull(row.validTo),
        countsAsTeaching: areaById.get(row.areaId)?.countsAsTeaching ?? false,
      }));
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
        areas: areas.map(areaView).sort((a, b) => a.name.localeCompare(b.name, 'sv')),
        shifts: shifts.map(shiftView),
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
