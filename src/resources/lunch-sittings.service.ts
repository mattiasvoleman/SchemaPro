import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { LunchSitting, Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { assertWholeMinutes } from '../common/solver-grid';
import { requireSchoolId } from '../common/utils/request-context';
import { exclusionViolation, rethrowPrismaError, writeConflict } from '../common/utils/prisma-errors';
import { windowOf } from '../common/lunch-window';
import { parseTimeString, toWallClock } from '../common/utils/time';
import type { MoveLunchSittingDto, PlaceLunchSittingDto } from './dto/lunch-sitting.dto';
import {
  countHomePupils,
  rostersOfYear,
  type RosterBasis,
} from '../year-rollover/projected-rosters';

/** A sitting as the admin grid sees it: clock strings, and who placed it. */
export interface LunchSittingResponse {
  id: string;
  studentGroupId: string;
  dayOfWeek: number;
  /** HH:MM */
  startTime: string;
  /** HH:MM */
  endTime: string;
  headcount: number;
  /** False for a meal the school placed by hand, which a run keeps. */
  isGenerated: boolean;
  /**
   * The weeks the meal holds, 'YYYY-MM-DD': a Monday and a Sunday, null for the
   * läsår's own first and last day (20270209090000). Null and null is the whole
   * läsår, which is every meal placed here until a meal can be dated.
   */
  startDate: string | null;
  endDate: string | null;
}

/**
 * The meals a school places by hand in the Grundschema.
 *
 * WRITES ONLY. The grid already reads LunchSittings straight from PostgREST,
 * as the pupil's and the kitchen's screens do; what it could not do until now
 * was put a meal anywhere. The solver writes this table on every successful
 * run, and a row written here is marked as the school's so that run keeps it
 * and sends it back as a pin.
 *
 * Touching a meal makes it the school's. Placing one on a day the solver
 * already fed replaces the solver's row; moving the solver's row pins it where
 * it was dropped. Only a hand-placed row can be deleted, because deleting the
 * solver's would leave the day with no meal until the next run — a band that
 * vanishes for a reason the screen cannot show.
 *
 * A meal placed here holds the whole läsår. A class may have several rows for
 * one weekday, each holding other weeks (20270209090000), and the table now
 * says so with an exclusion constraint where it said "one row" with a unique
 * key; that is why a placing is a read and a write rather than an upsert, and
 * why a write that meets the constraint is a conflict to try again.
 */
@Injectable()
export class LunchSittingsService {
  constructor(private readonly prisma: PrismaService) {}

  async place(dto: PlaceLunchSittingDto, user: AuthenticatedUser): Promise<LunchSittingResponse> {
    const schoolId = requireSchoolId(user);
    try {
      const row = await this.prisma.withRls(user, async (tx) => {
        const minutes = await lunchMinutesOf(tx, schoolId);
        const year = await assertIsAClassOf(tx, dto.studentGroupId, dto.academicYearId);
        const endTime = endOf(dto.startTime, minutes);
        // The class's pupils as its year's activation would place them
        // (projected-rosters.ts): a meal placed by hand in a rolled year not
        // yet activated seats 8A's coming pupils, not the nobody in it today.
        const basis = await rostersOfYear(tx, user, dto.academicYearId, year);
        const headcount = await headcountOf(tx, basis, dto.studentGroupId);
        return putWholeYearMeal(
          tx,
          { schoolId, academicYearId: dto.academicYearId, studentGroupId: dto.studentGroupId, dayOfWeek: dto.dayOfWeek },
          {
            startTime: parseTimeString(dto.startTime),
            endTime: parseTimeString(endTime),
            headcount,
            isGenerated: false,
          },
        );
      });
      return toResponse(row);
    } catch (error) {
      rethrowLunchError(error);
    }
  }

  /**
   * Moved in one transaction with whatever sat on the target day.
   *
   * A class eats once a day — the table's unique key says so — so a meal
   * dragged onto a day that already has one takes that day's place. Deleting
   * the other row first rather than failing on the key: the school dragged a
   * meal to Wednesday, and "Wednesday already has a meal" is the thing it was
   * replacing, not an error to show it.
   */
  async move(
    id: string,
    dto: MoveLunchSittingDto,
    user: AuthenticatedUser,
  ): Promise<LunchSittingResponse> {
    const schoolId = requireSchoolId(user);
    try {
      const row = await this.prisma.withRls(user, async (tx) => {
        const current = await tx.lunchSitting.findUnique({ where: { id } });
        if (!current) {
          throw new NotFoundException(`Lunch sitting ${id} not found.`);
        }
        const minutes = await lunchMinutesOf(tx, schoolId);
        const dayOfWeek = dto.dayOfWeek ?? current.dayOfWeek;
        const startTime = dto.startTime ?? toWallClock(current.startTime);
        if (dayOfWeek !== current.dayOfWeek) {
          // The meals the class has that day in the weeks this one holds: the
          // moved meal takes their place. A meal of other weeks is not in its way.
          await tx.lunchSitting.deleteMany({
            where: {
              academicYearId: current.academicYearId,
              studentGroupId: current.studentGroupId,
              dayOfWeek,
              ...meetingWeeksOf(current),
            },
          });
        }
        return tx.lunchSitting.update({
          where: { id },
          data: {
            dayOfWeek,
            startTime: parseTimeString(startTime),
            endTime: parseTimeString(endOf(startTime, minutes)),
            isGenerated: false,
          },
        });
      });
      return toResponse(row);
    } catch (error) {
      rethrowLunchError(error);
    }
  }

  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    requireSchoolId(user);
    try {
      await this.prisma.withRls(user, async (tx) => {
        const current = await tx.lunchSitting.findUnique({ where: { id } });
        if (!current) {
          throw new NotFoundException(`Lunch sitting ${id} not found.`);
        }
        if (current.isGenerated) {
          throw new BadRequestException(
            'Only a meal placed by hand can be removed; the solver replaces its own on the next run.',
          );
        }
        await tx.lunchSitting.delete({ where: { id } });
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }
}

type Tx = Parameters<Parameters<PrismaService['withRls']>[1]>[0];

/**
 * A write the exclusion constraint refused (LunchSittings_one_meal_at_a_time) is
 * a race: two placements for one class and day, neither seeing the other's row.
 * Nothing was written and trying again finds it, so it is the 409 every other
 * aborted concurrent write is, not a 500.
 */
function rethrowLunchError(error: unknown): never {
  if (exclusionViolation(error)) throw writeConflict();
  return rethrowPrismaError(error);
}

/**
 * The rows of the same class and weekday that hold a day in the weeks of
 * `row`: the Prisma filter for "meets this meal's weeks". A meal of the whole
 * läsår meets every row and adds no condition.
 */
function meetingWeeksOf(row: { startDate?: Date | null; endDate?: Date | null }): Prisma.LunchSittingWhereInput {
  const conditions: Prisma.LunchSittingWhereInput[] = [];
  // No date (null, or a row read without the column) is the läsår's own bound, which meets everything.
  if (row.endDate) conditions.push({ OR: [{ startDate: null }, { startDate: { lte: row.endDate } }] });
  if (row.startDate) conditions.push({ OR: [{ endDate: null }, { endDate: { gte: row.startDate } }] });
  return conditions.length === 0 ? {} : { AND: conditions };
}

/**
 * Puts the class's meal on a weekday, for the whole läsår, in place of what it
 * had. The one row of the whole läsår it already has is updated where it
 * stands (its id is what the grid holds); anything else the class had that day
 * (the solver's meals of several parts of the year) goes, and the meal is
 * created. The table's constraint is what says a class has one meal on a date,
 * so a write that raced another is refused there.
 */
async function putWholeYearMeal(
  tx: Tx,
  key: { schoolId: string; academicYearId: string; studentGroupId: string; dayOfWeek: number },
  data: { startTime: Date; endTime: Date; headcount: number; isGenerated: boolean },
): Promise<LunchSitting> {
  const rows = await tx.lunchSitting.findMany({
    where: { academicYearId: key.academicYearId, studentGroupId: key.studentGroupId, dayOfWeek: key.dayOfWeek },
    select: { id: true, startDate: true, endDate: true },
  });
  const [only] = rows;
  if (rows.length === 1 && !only!.startDate && !only!.endDate) {
    return tx.lunchSitting.update({ where: { id: only!.id }, data });
  }
  if (rows.length > 0) {
    await tx.lunchSitting.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
  }
  return tx.lunchSitting.create({ data: { ...key, ...data } });
}

/**
 * The school's meal length, and the refusal when there is no meal at all.
 *
 * A school with lunch switched off has no lunch variable in the engine, so a
 * meal placed here would be sent as a pin with nothing to pin — and the lessons
 * would be placed straight across it. Refused instead, where it can be read.
 */
async function lunchMinutesOf(tx: Tx, schoolId: string): Promise<number> {
  const settings = await tx.lunchSetting.findUnique({ where: { schoolId } });
  if (!settings || !settings.lunchEnabled) {
    throw new BadRequestException('Lunch is not switched on for this school, so there is no meal to place.');
  }
  return settings.lunchMinutes;
}

/**
 * Only a home class eats: a teaching group's pupils eat with their class.
 * Returns the year's flags for the roster basis.
 *
 * Asked of the YEAR, with the class as a relation filter, so the check and the
 * flags are one statement: Prisma 7 loads a selected relation (the group's
 * `academicYear`) in a statement of its own, and that one more round-trip
 * for every meal placed in the active year is what this avoids. The class
 * condition becomes an EXISTS in the year's WHERE, so a group that is not a
 * class of this year still finds nothing and is the same 400.
 */
async function assertIsAClassOf(
  tx: Tx,
  studentGroupId: string,
  academicYearId: string,
): Promise<{ isActive: boolean; predecessorId: string | null }> {
  const year = await tx.academicYear.findFirst({
    where: { id: academicYearId, studentGroups: { some: { id: studentGroupId, kind: 'CLASS' } } },
    select: { isActive: true, predecessorId: true },
  });
  if (!year) {
    throw new BadRequestException('A meal can only be placed for a class of this academic year.');
  }
  return year;
}

/**
 * Children seated — counted exactly as the gateway counts them for a run:
 * active pupils whose HOME class this is, never the teaching groups they are
 * also in. A second rule here would put a different number on the kitchen's
 * list for a meal placed by hand than for one the solver chose.
 */
function headcountOf(tx: Tx, basis: RosterBasis, studentGroupId: string): Promise<number> {
  return countHomePupils(tx, basis, { role: 'STUDENT', isActive: true }, studentGroupId);
}

/**
 * The meal's end, from its start and the school's one length.
 *
 * The seconds go first, and this table is the one where dropping them is worse
 * than an off-grid boundary. The body carries only a start — the length is the
 * school's one `lunchMinutes` — and the arithmetic below reads two fields, so a
 * start of `11:00:30` produced an end of `11:30`. The start keeps its seconds
 * into the column and the end does not, and the row stored is a meal 1770
 * seconds long against the thirty minutes the school actually set: a lunch half
 * a minute short, with no CHECK on this table to notice. Only
 * `LunchSittings_window_is_ordered` guards it, and `11:30` is still after
 * `11:00:30`.
 */
function endOf(startTime: string, minutes: number): string {
  assertWholeMinutes('startTime', startTime);

  const [hours, mins] = startTime.split(':').map(Number);
  const total = hours * 60 + mins + minutes;
  if (total >= 24 * 60) {
    throw new BadRequestException('The meal would run past midnight.');
  }
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function toResponse(row: LunchSitting): LunchSittingResponse {
  return {
    id: row.id,
    studentGroupId: row.studentGroupId,
    dayOfWeek: row.dayOfWeek,
    startTime: toWallClock(row.startTime),
    endTime: toWallClock(row.endTime),
    headcount: row.headcount,
    isGenerated: row.isGenerated,
    ...windowOf(row),
  };
}
