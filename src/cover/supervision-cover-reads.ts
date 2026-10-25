import { Prisma, type PrismaClient, type SupervisionCoverDecision } from '@prisma/client';
import { toNioarigSpan, type GradeNumbering } from '../common/grade-numbering';
import type { ClosedRange, YearBounds } from '../staffing/teaching-weeks';
import { passRunsOn, passSpan, spansMeet, type PassArea } from '../supervision/pass-days';
import { asDay, dayDate, localDateOf } from './cover-context';
import { passBoardItems, type BoardAbsence, type BoardCover, type BoardShift, type PassBoardItem } from './supervision-board';

/**
 * THE BOARD'S PASSES, READ (Rastvakt i vardagen, 20261210090000): the rows
 * supervision-board.ts derives the pairs from, and the one pass a write is
 * about. Plain functions over the caller's transaction, under its RLS, as
 * cover-decisions.ts' are: CoverService, the suggestions and the absences
 * all call them, and none is a Nest provider.
 *
 * Model calls, and one statement per table: a school whose absent teachers
 * have no pass and no decision sends two (the passes and the decisions)
 * beside the board's own. Nothing here selects a pass's note or an
 * absence's reason.
 */

const SHIFT_SELECT = {
  id: true,
  academicYearId: true,
  areaId: true,
  userId: true,
  dayOfWeek: true,
  startTime: true,
  endTime: true,
  validFrom: true,
  validTo: true,
} as const;

const COVER_SELECT = {
  id: true,
  shiftId: true,
  date: true,
  areaId: true,
  startsAt: true,
  endsAt: true,
  absenceId: true,
  absentTeacherId: true,
  decision: true,
  substituteId: true,
  decidedAt: true,
} as const;

const minutesOfTime = (value: Date) => value.getUTCHours() * 60 + value.getUTCMinutes();

/** One decision as the writers and the settling read it. */
export interface CoverRow {
  id: string;
  shiftId: string;
  date: string;
  areaId: string;
  startsAt: Date;
  endsAt: Date;
  absenceId: string;
  absentTeacherId: string;
  decision: SupervisionCoverDecision;
  substituteId: string | null;
  decidedAt: Date;
}

function toCoverRow(row: {
  id: string;
  shiftId: string;
  date: Date;
  areaId: string;
  startsAt: Date;
  endsAt: Date;
  absenceId: string;
  absentTeacherId: string;
  decision: SupervisionCoverDecision;
  substituteId: string | null;
  decidedAt: Date;
}): CoverRow {
  return { ...row, date: asDay(row.date) };
}

function toBoardShift(
  row: {
    id: string;
    academicYearId: string;
    areaId: string;
    userId: string;
    dayOfWeek: number;
    startTime: Date;
    endTime: Date;
    validFrom: Date | null;
    validTo: Date | null;
  },
  inactiveFrom: string | null,
): BoardShift {
  return {
    id: row.id,
    academicYearId: row.academicYearId,
    areaId: row.areaId,
    userId: row.userId,
    dayOfWeek: row.dayOfWeek,
    start: minutesOfTime(row.startTime),
    end: minutesOfTime(row.endTime),
    validFrom: row.validFrom ? asDay(row.validFrom) : null,
    validTo: row.validTo ? asDay(row.validTo) : null,
    inactiveFrom,
  };
}

/** The places, the läsår and their lov (in NIOARIG) and the teachers' deactivation days the passes need. */
export interface PassCalendar {
  areas: Map<string, PassArea & { name: string; siteId: string | null }>;
  years: Map<string, YearBounds & { gradeNumbering: GradeNumbering }>;
  closures: Map<string, ClosedRange[]>;
  inactiveFrom: Map<string, string>;
}

export async function readPassCalendar(
  tx: PrismaClient,
  args: { areaIds: readonly string[]; yearIds: readonly string[]; teacherIds: readonly string[]; timezone: string },
): Promise<PassCalendar> {
  const areaIds = [...new Set(args.areaIds)];
  const yearIds = [...new Set(args.yearIds)];
  const teacherIds = [...new Set(args.teacherIds)];
  const areas =
    areaIds.length > 0
      ? ((await tx.supervisionArea.findMany({
          where: { id: { in: areaIds } },
          select: { id: true, name: true, siteId: true, minGradeLevel: true, maxGradeLevel: true },
        })) ?? [])
      : [];
  const years =
    yearIds.length > 0
      ? ((await tx.academicYear.findMany({
          where: { id: { in: yearIds } },
          select: { id: true, startDate: true, endDate: true, gradeNumbering: true },
        })) ?? [])
      : [];
  const breaks =
    yearIds.length > 0
      ? ((await tx.schoolBreak.findMany({
          where: { academicYearId: { in: yearIds } },
          select: { academicYearId: true, startDate: true, endDate: true, minGradeLevel: true, maxGradeLevel: true },
        })) ?? [])
      : [];
  const inactive =
    teacherIds.length > 0
      ? ((await tx.user.findMany({
          where: { id: { in: teacherIds }, isActive: false },
          select: { id: true, deactivatedAt: true },
        })) ?? [])
      : [];
  const numberingOf = new Map(years.map((year) => [year.id, (year.gradeNumbering ?? 'NIOARIG') as GradeNumbering]));
  const closures = new Map<string, ClosedRange[]>();
  for (const row of breaks) {
    // A tioårig läsår's lov are stated in its own numbering; the area's span is NIOARIG.
    const numbering = numberingOf.get(row.academicYearId) ?? 'NIOARIG';
    const span =
      row.minGradeLevel === null || row.maxGradeLevel === null
        ? null
        : toNioarigSpan({ min: row.minGradeLevel, max: row.maxGradeLevel }, numbering);
    closures.set(row.academicYearId, [
      ...(closures.get(row.academicYearId) ?? []),
      {
        startDate: asDay(row.startDate),
        endDate: asDay(row.endDate),
        minGradeLevel: span?.min ?? row.minGradeLevel,
        maxGradeLevel: span?.max ?? row.maxGradeLevel,
      },
    ]);
  }
  return {
    areas: new Map(
      areas.map((area) => [
        area.id,
        { name: area.name, siteId: area.siteId ?? null, minGradeLevel: area.minGradeLevel, maxGradeLevel: area.maxGradeLevel },
      ]),
    ),
    years: new Map(
      years.map((year) => [
        year.id,
        { startDate: asDay(year.startDate), endDate: asDay(year.endDate), gradeNumbering: numberingOf.get(year.id)! },
      ]),
    ),
    closures,
    // A deactivated teacher's pass watches until the day before; a row
    // deactivated before the column was kept watches all year (the rota's rule).
    inactiveFrom: new Map(
      inactive.flatMap((row) => (row.deactivatedAt ? [[row.id, localDateOf(row.deactivatedAt, args.timezone)] as const] : [])),
    ),
  };
}

/** Of these vikarier, whether each is away or gone over a span: inactive, or an ACTIVE absence sharing a minute. */
async function readVikarieState(
  tx: PrismaClient,
  covers: readonly { substituteId: string | null; startsAt: Date; endsAt: Date }[],
): Promise<(substituteId: string, span: { startsAt: Date; endsAt: Date }) => boolean> {
  const ids = [...new Set(covers.flatMap((cover) => (cover.substituteId ? [cover.substituteId] : [])))];
  if (ids.length === 0) return () => false;
  const from = new Date(Math.min(...covers.map((cover) => cover.startsAt.getTime())));
  const to = new Date(Math.max(...covers.map((cover) => cover.endsAt.getTime())));
  const people = (await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, isActive: true } })) ?? [];
  const absences =
    (await tx.teacherAbsence.findMany({
      where: { userId: { in: ids }, status: 'ACTIVE', startsAt: { lt: to }, endsAt: { gt: from } },
      // The period only; never the reason.
      select: { userId: true, startsAt: true, endsAt: true },
    })) ?? [];
  const active = new Set(people.filter((person) => person.isActive).map((person) => person.id));
  return (substituteId, span) =>
    !active.has(substituteId) || absences.some((absence) => absence.userId === substituteId && spansMeet(span, absence));
}

export type PassScope =
  | { kind: 'window'; from: string; to: string; absences: readonly BoardAbsence[] }
  | { kind: 'absences'; absences: readonly BoardAbsence[] };

/**
 * The board's passes over a window, or over each of some absences' own days
 * (the register's counts) — from the ACTIVE absences the caller has read
 * already either way.
 */
export async function readPassBoard(
  tx: PrismaClient,
  scope: PassScope,
  timezone: string,
  now: Date,
): Promise<PassBoardItem[]> {
  if (scope.kind === 'absences' && scope.absences.length === 0) return [];
  const absences: BoardAbsence[] = [...scope.absences];
  const coverRows =
    (await tx.supervisionCover.findMany({
      where:
        scope.kind === 'window'
          ? { date: { gte: dayDate(scope.from), lte: dayDate(scope.to) } }
          : { absenceId: { in: absences.map((absence) => absence.id) } },
      select: COVER_SELECT,
    })) ?? [];
  // A decision is read only while its absence is ACTIVE; its period says
  // whether its pass still falls inside it.
  const known = new Map(absences.map((absence) => [absence.id, absence]));
  const others = [...new Set(coverRows.map((row) => row.absenceId))].filter((id) => !known.has(id));
  if (others.length > 0) {
    const rows =
      (await tx.teacherAbsence.findMany({
        where: { id: { in: others }, status: 'ACTIVE' },
        select: { id: true, userId: true, startsAt: true, endsAt: true },
      })) ?? [];
    for (const row of rows) known.set(row.id, row);
  }
  const covers: BoardCover[] = coverRows.flatMap((row) => {
    const absence = known.get(row.absenceId);
    return absence
      ? [{ ...toCoverRow(row), absenceStartsAt: absence.startsAt, absenceEndsAt: absence.endsAt }]
      : [];
  });
  const teacherIds = [...new Set(absences.map((absence) => absence.userId))];
  if (teacherIds.length === 0 && covers.length === 0) return [];
  const shiftRows =
    (await tx.supervisionShift.findMany({
      where: {
        OR: [
          ...(teacherIds.length > 0
            ? [
                {
                  userId: { in: teacherIds },
                  ...(scope.kind === 'window'
                    ? { academicYear: { startDate: { lte: dayDate(scope.to) }, endDate: { gte: dayDate(scope.from) } } }
                    : {}),
                },
              ]
            : []),
          ...(covers.length > 0 ? [{ id: { in: [...new Set(covers.map((cover) => cover.shiftId))] } }] : []),
        ],
      },
      select: SHIFT_SELECT,
    })) ?? [];
  if (shiftRows.length === 0 && covers.length === 0) return [];
  const calendar = await readPassCalendar(tx, {
    areaIds: shiftRows.map((row) => row.areaId),
    yearIds: shiftRows.map((row) => row.academicYearId),
    teacherIds: shiftRows.map((row) => row.userId),
    timezone,
  });
  const vikarieAway = await readVikarieState(tx, covers);
  return passBoardItems({
    window: scope.kind === 'window' ? { from: scope.from, to: scope.to } : null,
    timezone,
    absences,
    shifts: shiftRows.map((row) => toBoardShift(row, calendar.inactiveFrom.get(row.userId) ?? null)),
    areas: calendar.areas,
    years: calendar.years,
    closures: calendar.closures,
    covers,
    vikarieAway,
    now,
  });
}

/** One pass on one date, as a write reads it after its locks. */
export interface PassOccurrence {
  shift: BoardShift;
  area: PassArea & { name: string; siteId: string | null };
  year: YearBounds & { gradeNumbering: GradeNumbering };
  /** Whether the pass runs on the date (its weekday, dates, lov and teacher). */
  runs: boolean;
  span: { startsAt: Date; endsAt: Date };
}

export async function readPassOccurrence(
  tx: PrismaClient,
  shiftId: string,
  date: string,
  timezone: string,
): Promise<PassOccurrence | null> {
  const row = await tx.supervisionShift.findUnique({ where: { id: shiftId }, select: SHIFT_SELECT });
  if (!row) return null;
  const calendar = await readPassCalendar(tx, {
    areaIds: [row.areaId],
    yearIds: [row.academicYearId],
    teacherIds: [row.userId],
    timezone,
  });
  const area = calendar.areas.get(row.areaId);
  const year = calendar.years.get(row.academicYearId);
  if (!area || !year) return null;
  const shift = toBoardShift(row, calendar.inactiveFrom.get(row.userId) ?? null);
  return {
    shift,
    area,
    year,
    runs: passRunsOn(shift, area, year, calendar.closures.get(row.academicYearId) ?? [], date),
    span: passSpan(shift, date, timezone),
  };
}

/** The decision on a pass's date, if any. */
export async function readCover(tx: PrismaClient, shiftId: string, date: string): Promise<CoverRow | null> {
  const row = await tx.supervisionCover.findUnique({
    where: { shiftId_date: { shiftId, date: dayDate(date) } },
    select: COVER_SELECT,
  });
  return row ? toCoverRow(row) : null;
}

/** Every decision of an absence (settleDecisionsOutside). */
export async function coversOfAbsence(tx: PrismaClient, absenceId: string): Promise<CoverRow[]> {
  const rows =
    (await tx.supervisionCover.findMany({
      where: { absenceId },
      select: COVER_SELECT,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    })) ?? [];
  return rows.map(toCoverRow);
}

/** Whether a vikarie is away or gone over a span (the board's COVERED rule, for one decision). */
export async function vikarieAwayOver(
  tx: PrismaClient,
  substituteId: string,
  span: { startsAt: Date; endsAt: Date },
): Promise<boolean> {
  const away = await readVikarieState(tx, [{ substituteId, ...span }]);
  return away(substituteId, span);
}

/**
 * The pass row's share lock: a write about its date waits for an edit of the
 * pass (which takes it FOR UPDATE before it asks for decisions), and the
 * edit waits for the write. $executeRaw: nothing is read back.
 */
export async function lockShiftForShare(tx: PrismaClient, shiftId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT 1 FROM "SupervisionShifts" WHERE "id" = ${shiftId}::uuid FOR SHARE`);
}
