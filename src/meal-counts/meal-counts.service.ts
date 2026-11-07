import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { parseUtcDate, toDateString } from '../calendar/publish-days';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { requireSchoolId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';
import type { MealCountsQueryDto, MealSettingsDto } from './dto/meal-counts.dto';
import {
  buildMealView,
  MEAL_COUNTS_MAX_DAYS,
  MEAL_COUNTS_PAST,
  MEAL_COUNTS_RANGE,
  MEAL_LETTER_NEEDS_ADDRESS_AND_HOUR,
  mealCsv,
  mealCsvName,
  parseMealRows,
  type MealCountsView,
} from './meal-counts';

export interface MealSettingsView {
  /** HH:MM in the school's time; null is none, and then no absence is taken off. */
  cutoffTime: string | null;
  letterEnabled: boolean;
  kitchenEmail: string | null;
  /** The last day a letter went (yyyy-mm-dd), as far back as the job's trace goes (35 days); null if none. */
  lastLetterOn: string | null;
}

export interface MealCsvFile {
  filename: string;
  body: Buffer;
}

/** A @db.Time as "HH:MM". */
const clock = (time: Date | null): string | null => (time === null ? null : time.toISOString().slice(11, 16));
const DAY_MS = 86_400_000;
const days = (from: string, to: string): number => Math.round((parseUtcDate(to).getTime() - parseUtcDate(from).getTime()) / DAY_MS);
const addDays = (day: string, count: number): string => toDateString(new Date(parseUtcDate(day).getTime() + count * DAY_MS));

/** The day the school is on right now, in its own time. */
async function schoolToday(tx: Pick<PrismaClient, '$queryRaw'>): Promise<string> {
  const [row] = await tx.$queryRaw<Array<{ today: Date }>>(Prisma.sql`SELECT app.school_today() AS today`);
  return toDateString(row!.today);
}

/**
 * Måltidskollen: the counts the kitchen orders from, the file of them, and the school's settings for them.
 *
 * ONE COUNT. app.meal_counts_for_me (20270123090000) is the only place a portion is counted; the view, the
 * file and the letter (meal-letter.job.ts, through app.meal_letter) all read what it answers and build from
 * buildMealView, so the three cannot disagree.
 *
 * WHO. The reads are every administrator's (the database's function asks app.current_user_may('DRIFT', false),
 * which the läsare and the huvudman's reader hold), the settings are written by those who write Drift. The
 * counts carry numbers and the names of classes; no pupil is named, so nothing is recorded in the read log.
 *
 * FROM TODAY. The pupils of a class are today's (as a lesson's roster is), so a day before today is refused
 * rather than answered with a class list that may since have moved.
 */
@Injectable()
export class MealCountsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The days from `from` to `to`, with their sittings and totals. */
  async view(query: MealCountsQueryDto, user: AuthenticatedUser): Promise<MealCountsView> {
    requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const today = await schoolToday(tx);
      const from = query.from ?? today;
      if (query.to !== undefined && query.days !== undefined) {
        throw new BadRequestException({ code: MEAL_COUNTS_RANGE, message: 'Ange antingen ett till-datum eller ett antal dagar, inte båda.' });
      }
      const to = query.to ?? (query.days === undefined ? from : addDays(from, query.days - 1));
      if (to < from || days(from, to) + 1 > MEAL_COUNTS_MAX_DAYS) {
        throw new BadRequestException({
          code: MEAL_COUNTS_RANGE,
          message: `Antalen gäller högst ${MEAL_COUNTS_MAX_DAYS} dagar, och till-datumet får inte vara före från-datumet.`,
        });
      }
      if (from < today) {
        throw new BadRequestException({
          code: MEAL_COUNTS_PAST,
          message: 'Antalen gäller dagar från och med i dag: elevlistorna är dagens, och en klass kan ha flyttat sedan.',
        });
      }
      const [row] = await tx.$queryRaw<Array<{ doc: unknown }>>(
        Prisma.sql`SELECT app.meal_counts_for_me(${from}::date, ${to}::date) AS doc`,
      );
      return buildMealView(parseMealRows(row?.doc), from, to);
    });
  }

  /** The same days as a file for Excel: windows-1252, `;`. */
  async csv(query: MealCountsQueryDto, user: AuthenticatedUser): Promise<MealCsvFile> {
    const view = await this.view(query, user);
    return { filename: mealCsvName(view), body: mealCsv(view) };
  }

  async settings(user: AuthenticatedUser): Promise<MealSettingsView> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, (tx) => this.read(tx, schoolId));
  }

  /**
   * Changes what the save names. A letter that is on has an address and an hour: said here with a code, after the
   * merge with what is stored, and held by the table's CHECK behind it.
   */
  async updateSettings(dto: MealSettingsDto, user: AuthenticatedUser): Promise<MealSettingsView> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const existing = await tx.kitchenSetting.findUnique({ where: { schoolId } });
      const cutoff = dto.cutoffTime !== undefined ? dto.cutoffTime : clock(existing?.cutoffTime ?? null);
      const email = dto.kitchenEmail !== undefined ? dto.kitchenEmail : (existing?.kitchenEmail ?? null);
      const enabled = dto.letterEnabled ?? existing?.letterEnabled ?? false;
      if (enabled && (cutoff === null || email === null)) {
        throw new BadRequestException({
          code: MEAL_LETTER_NEEDS_ADDRESS_AND_HOUR,
          message: 'Brevet kan bara vara på när en brytpunkt och en köksadress är angivna.',
        });
      }
      const data = {
        cutoffTime: cutoff === null ? null : new Date(`1970-01-01T${cutoff}:00.000Z`),
        letterEnabled: enabled,
        kitchenEmail: email,
      };
      await tx.kitchenSetting.upsert({ where: { schoolId }, create: { schoolId, ...data }, update: data });
      return this.read(tx, schoolId);
    });
  }

  private async read(tx: PrismaClient, schoolId: string): Promise<MealSettingsView> {
    const row = await tx.kitchenSetting.findUnique({ where: { schoolId } });
    const [last] = await tx.$queryRaw<Array<{ day: Date | null }>>(Prisma.sql`SELECT app.meal_letter_last_for_me() AS day`);
    return {
      cutoffTime: clock(row?.cutoffTime ?? null),
      letterEnabled: row?.letterEnabled ?? false,
      kitchenEmail: row?.kitchenEmail ?? null,
      lastLetterOn: last?.day ? toDateString(last.day) : null,
    };
  }
}
