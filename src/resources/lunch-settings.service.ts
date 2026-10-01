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
  carriesSeconds,
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
   * THE SECONDS GO FIRST, BEFORE ANY OF THE ARITHMETIC BELOW — see
   * `assertWholeMinutes` for why every clock DTO admits them at all. This is
   * one of the only two routes in the app where they reach a CHECK rather than
   * merely landing off the grid: `11:00:30`-`11:30` measured here is a window a
   * whole thirty minutes wide with both edges on the grid, while
   * LunchSettings_window_fits_break counts 1770 seconds against the 1800 it
   * needs and answers with a bare 500.
   *
   * Only the START can reach that CHECK — seconds on the end widen the window,
   * so they pass it and are stored off the grid instead. Both are refused, but
   * they are not the same claim, and the spec rows say which is which.
   */
  private assertFitsTheSolverGrid(dto: UpsertLunchSettingsDto): void {
    for (const [label, value] of [
      ['Starttiden', dto.lunchStartTime],
      ['Sluttiden', dto.lunchEndTime],
    ] as const) {
      // Swedish, and its own sentence rather than the shared English one, for
      // the reason the rest of this function's messages are Swedish: an admin
      // reads them in the lunch form. `carriesSeconds` carries the argument.
      if (carriesSeconds(value)) {
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
