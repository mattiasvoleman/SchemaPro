import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { requireSchoolId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';
import type { PrintTimetablesQueryDto, TimetableValidityQueryDto } from './dto/print.dto';
import { isViewerDate } from './public-timetable.controller';

export const PRINT_BAD_DATE = 'PRINT_BAD_DATE';
export const PRINT_TEACHERS_UNNAMED = 'PRINT_TEACHERS_UNNAMED';
export const PRINT_WEEK_OUTSIDE_YEARS = 'PRINT_WEEK_OUTSIDE_YEARS';

export type PrintKind = 'GROUP' | 'TEACHER' | 'ROOM';
export type TeacherDisplay = 'NONE' | 'SIGNATURE' | 'NAME';

/** A lesson as Schemavisaren's whitelist has it (app.timetable_week_days). */
export interface PrintedLesson {
  start: string;
  end: string;
  subject?: string | null;
  groups?: (string | null)[];
  room?: string | null;
  teachers?: string[];
  cancelled?: boolean;
  busy?: true;
}

export interface PrintedDay {
  date: string;
  lessons: PrintedLesson[];
  meals?: { start: string; end: string }[];
}

export interface PrintSheet {
  id: string;
  title: string;
  days: PrintedDay[];
}

/** A run of dates one publication is valid for ("Giltig fr.o.m./t.o.m."). */
export interface ValidityPeriod {
  from: string;
  to: string;
}

export interface PrintWeek {
  from: string;
  to: string;
  isoWeek: string;
}

export interface PrintSet {
  kind: PrintKind;
  school: string;
  academicYearId: string;
  week: PrintWeek;
  /** The periods the week's days are valid for, earliest first; empty when nothing published covers it. */
  validity: ValidityPeriod[];
  /** As the sheets name teachers, and whether a class's sheets show its meals. */
  teachers: TeacherDisplay;
  meals: boolean;
  sheets: PrintSheet[];
}

export interface WeekValidity {
  week: { from: string; to: string };
  validity: ValidityPeriod[];
}

const DAY_MS = 86_400_000;
const mondayOf = (date: string): string => {
  const at = Date.parse(`${date}T00:00:00Z`);
  return new Date(at - ((new Date(at).getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
};
const plusDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/**
 * How a set names teachers when the admin does not say: the school's own
 * choice for Schemavisaren — a set for the doors should not name more than
 * the school's public pages do — save a teachers' set, whose sheets are
 * titled by their teacher and need a name of some kind: the signature when
 * the school names nobody.
 */
export function defaultTeacherDisplay(schoolDisplay: TeacherDisplay, kind: PrintTimetablesQueryDto['kind']): TeacherDisplay {
  return kind === 'TEACHER' && schoolDisplay === 'NONE' ? 'SIGNATURE' : schoolDisplay;
}

/**
 * Utskrift: the admin's set of printed weeks, and the validity of any week
 * for whoever prints one (migration 20261102090000).
 *
 * WHAT A SHEET SHOWS is Schemavisaren's, decided in the database by
 * app.timetable_week_days — the function the viewer's own pages are built
 * by — and nothing here widens it. The admin chooses only how teachers are
 * named and whether a class's meals are drawn.
 *
 * THE READ LOG. A set is the published timetable layer of a class, a
 * teacher or a room, which staff read directly through PostgREST; it is not
 * recorded, for the reason src/access-log/access-log.ts gives for the
 * timetable layer (NOT RECORDED). The validity is dates only.
 */
@Injectable()
export class PrintTimetablesService {
  constructor(private readonly prisma: PrismaService) {}

  async timetables(query: PrintTimetablesQueryDto, user: AuthenticatedUser): Promise<PrintSet> {
    const schoolId = requireSchoolId(user);
    if (!isViewerDate(query.date)) {
      throw new BadRequestException({ message: 'date: en riktig dag, YYYY-MM-DD.', code: PRINT_BAD_DATE });
    }
    return this.prisma.withRls(user, async (tx) => {
      const settings = await tx.publicationSettings.findUnique({
        where: { schoolId },
        select: { publicTeacherDisplay: true, publicShowMeals: true },
      });
      const teachers = query.teachers ?? defaultTeacherDisplay(settings?.publicTeacherDisplay ?? 'NONE', query.kind);
      if (query.kind === 'TEACHER' && teachers === 'NONE') {
        throw new BadRequestException({
          message: 'teachers: lärarnas scheman visar läraren som signatur eller namn; välj ett av dem.',
          code: PRINT_TEACHERS_UNNAMED,
        });
      }
      const meals = query.meals ?? settings?.publicShowMeals ?? true;
      const [row] = await tx.$queryRaw<{ doc: Omit<PrintSet, 'validity' | 'teachers' | 'meals'> | null }[]>`
        SELECT app.print_timetables(${query.kind}::"PublicScopeKind", ${query.date}::date,
                                    ${teachers}::"TeacherDisplay", ${meals}) AS "doc"`;
      if (!row?.doc) {
        throw new NotFoundException({ message: 'Veckan ligger inte i något av skolans läsår.', code: PRINT_WEEK_OUTSIDE_YEARS });
      }
      // The set's own läsår: a week two läsår share is valid by the one printed.
      const validity = await readValidity(tx, row.doc.week.from, row.doc.week.to, row.doc.academicYearId);
      return { ...row.doc, validity, teachers, meals };
    });
  }

  /** The week of a date and the periods its days are valid for. Any member of the school. */
  async validity(query: TimetableValidityQueryDto, user: AuthenticatedUser): Promise<WeekValidity> {
    requireSchoolId(user);
    if (!isViewerDate(query.week)) {
      throw new BadRequestException({ message: 'week: en riktig dag, YYYY-MM-DD.', code: PRINT_BAD_DATE });
    }
    const from = mondayOf(query.week);
    const to = plusDays(from, 6);
    return this.prisma.withRls(user, async (tx) => ({ week: { from, to }, validity: await readValidity(tx, from, to, null) }));
  }
}

/** `year` null: the läsår the week reaches into, as the database chooses it. */
async function readValidity(tx: PrismaClient, from: string, to: string, year: string | null): Promise<ValidityPeriod[]> {
  const rows = await tx.$queryRaw<ValidityPeriod[]>`
    SELECT "from"::text AS "from", "to"::text AS "to" FROM app.timetable_validity(${from}::date, ${to}::date, ${year}::uuid)`;
  return rows.map((row) => ({ from: row.from, to: row.to }));
}
