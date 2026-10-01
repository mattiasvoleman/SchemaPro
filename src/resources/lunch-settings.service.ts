import { BadRequestException, Injectable } from '@nestjs/common';
import type { LunchSetting } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { toWallClock } from '../common/utils/time';
import {
  DAY_END_MINUTES,
  DAY_START_MINUTES,
  SLOT_MINUTES,
  minutesOf,
} from '../common/solver-grid';

/**
 * What the endpoint answers with, which is not the row.
 *
 * The two time columns come out of Prisma as `Date`s anchored at 1970-01-01,
 * and returning the row unchanged sent "1970-01-01T11:00:00.000Z" to a client
 * asking for a clock. `<input type="time">` refused it — "The specified value
 * '1970-' does not conform to the required format" — and the lunch form drew
 * its start and end empty on every load.
 */
export interface LunchSettingsResponse
  extends Omit<LunchSetting, 'lunchStartTime' | 'lunchEndTime'> {
  /** HH:MM, the wall clock the column actually holds. */
  lunchStartTime: string;
  lunchEndTime: string;
}

function toResponse(row: LunchSetting): LunchSettingsResponse {
  return {
    ...row,
    lunchStartTime: toWallClock(row.lunchStartTime),
    lunchEndTime: toWallClock(row.lunchEndTime),
  };
}
import { parseTimeString } from '../common/utils/time';
import type { UpsertLunchSettingsDto } from './dto/lunch-settings.dto';

/**
 * The solver's time grid, restated.
 *
 * These are the engine's own limits (SCHEDULE_DAY_START_MINUTES 480,
 * SCHEDULE_DAY_END_MINUTES 1080, SLOT_MINUTES 15). Duplicated here on purpose:
 * the engine does reject a window it cannot place, but the proxy discards its
 * error body and rethrows a generic message, so the school would be told only
 * that "the AI engine returned an error" — every time it generated, forever,
 * because a saved setting is replayed on every run. Catching it at the moment
 * the admin types it is the only place the message can still be useful.
 */

@Injectable()
export class LunchSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The school's row, or null when nobody has defined lunch yet.
   *
   * Null rather than a fabricated default: "not yet decided" and "decided to be
   * 11:00" are different facts, and the publish warning depends on telling them
   * apart.
   */
  async get(user: AuthenticatedUser): Promise<LunchSettingsResponse | null> {
    // async, so a principal with no school rejects rather than throwing before
    // the promise exists — a caller awaiting this should not have to also
    // wrap the call itself in a try.
    const schoolId = requireSchoolId(user);
    const row = await this.prisma.withRls(user, (tx) =>
      tx.lunchSetting.findUnique({ where: { schoolId } }),
    );
    return row === null ? null : toResponse(row);
  }

  async upsert(
    dto: UpsertLunchSettingsDto,
    user: AuthenticatedUser,
  ): Promise<LunchSettingsResponse> {
    const schoolId = requireSchoolId(user);
    this.assertFitsTheSolverGrid(dto);

    const data = {
      lunchEnabled: dto.lunchEnabled,
      lunchStartTime: parseTimeString(dto.lunchStartTime),
      lunchEndTime: parseTimeString(dto.lunchEndTime),
      lunchMinutes: dto.lunchMinutes,
      diningSeats: dto.diningSeats ?? null,
      maxLessonsPerDayPerGroup: dto.maxLessonsPerDayPerGroup ?? null,
    };

    try {
      return toResponse(
        await this.prisma.withRls(user, (tx) =>
          tx.lunchSetting.upsert({
            where: { schoolId },
            create: { schoolId, ...data },
            update: data,
          }),
        ),
      );
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  /**
   * Every rejection here is one the engine would otherwise raise mid-generation,
   * where nobody can read it. The messages are Swedish because an admin reads
   * them in the lunch form.
   *
   * THE SECONDS GO FIRST, BEFORE ANY OF THE ARITHMETIC BELOW. The DTO admits
   * HH:MM:SS on purpose — it is the shape PostgREST returns, so a row read out
   * of the database round-trips through this endpoint — and `parseTimeString`
   * carries the seconds into the TIME(0) columns. `minutesOf` does not see
   * them: it splits on ':' and reads two fields. So `11:00:30` measured here is
   * 11:00, and `11:00:30`-`11:30` passed as a window a whole thirty minutes
   * wide with both edges on the grid, while the table's
   * LunchSettings_window_fits_break measures the same window with
   * EXTRACT(EPOCH …) and sees 1770 seconds against the 1800 it needs. A CHECK
   * violation is none of the codes `rethrowPrismaError` maps, so the admin met
   * a bare 500 where every other refusal on this route is a 400 naming the
   * field — the same defect TeacherWorkRulesService.assertLunchFits closes, and
   * these are the only two tables in the schema whose CHECK counts seconds.
   *
   * Only the START can reach that CHECK: seconds on the end widen the window,
   * so they pass it and are merely stored off the solver's five-minute grid, to
   * be read back on every run. Both are refused anyway, because the grid is the
   * reason for both. Refusing is the fix rather than counting, because a
   * schedule laid in five-minute slots has nothing to do with a second.
   */
  private assertFitsTheSolverGrid(dto: UpsertLunchSettingsDto): void {
    for (const [label, value] of [
      ['Starttiden', dto.lunchStartTime],
      ['Sluttiden', dto.lunchEndTime],
    ] as const) {
      const [, , seconds = '0'] = value.split(':');
      if (Number(seconds) !== 0) {
        throw new BadRequestException(
          `${label} anges i hela minuter — schemaläggaren räknar i ${SLOT_MINUTES}-minuterssteg, och sekunder går inte att lägga på det rutnätet.`,
        );
      }
    }

    const start = minutesOf(dto.lunchStartTime);
    const end = minutesOf(dto.lunchEndTime);

    for (const [label, value] of [
      ['Starttiden', start],
      ['Sluttiden', end],
    ] as const) {
      if (value < DAY_START_MINUTES || value > DAY_END_MINUTES) {
        throw new BadRequestException(
          `${label} måste ligga mellan 08:00 och 18:00.`,
        );
      }
      if ((value - DAY_START_MINUTES) % SLOT_MINUTES !== 0) {
        throw new BadRequestException(
          `${label} måste vara ett jämnt intervall om ${SLOT_MINUTES} minuter, till exempel 11:00 eller 11:${String(SLOT_MINUTES).padStart(2, '0')}.`,
        );
      }
    }

    if (dto.lunchMinutes % SLOT_MINUTES !== 0) {
      throw new BadRequestException(
        `Lunchens längd måste vara ett helt antal ${SLOT_MINUTES}-minutersintervall.`,
      );
    }
    if (end - start < dto.lunchMinutes) {
      throw new BadRequestException(
        `Lunchfönstret är ${end - start} minuter långt och rymmer inte en lunch på ${dto.lunchMinutes} minuter.`,
      );
    }
  }
}
