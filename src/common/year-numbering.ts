import type { Prisma } from '@prisma/client';
import type { GradeNumbering } from './grade-numbering';

/**
 * A läsår's numbering (AcademicYears.gradeNumbering, 20261126091000), for a
 * reader that compares its classes' årskurser with a school-wide span and
 * holds no year row of its own (grade-numbering.ts). NIOARIG for a year the
 * caller cannot see, which is every year before 2028-07-01 anyway: such a
 * reader answers for nothing of it.
 *
 * Gateway only: web/lib reads the column with the year (useAcademicYears).
 */
export async function yearNumberingOf(
  tx: Pick<Prisma.TransactionClient, 'academicYear'>,
  academicYearId: string,
): Promise<GradeNumbering> {
  const year = await tx.academicYear.findUnique({ where: { id: academicYearId }, select: { gradeNumbering: true } });
  return year?.gradeNumbering ?? 'NIOARIG';
}

/**
 * The numbering a dated årskursregel is stated in: that of the läsår its day
 * falls in (grade-numbering.ts), which need not be the one being read — a
 * school's dated rows are not scoped to a year. The scheduled läsår first when
 * it holds the day (läsår may overlap, and a row inside the year being read is
 * that year's), then any of the school's läsår that does, else NIOARIG: no
 * läsår is TIOARIG before 2028-07-01, and a day outside every läsår is.
 */
export async function dayNumberingOf(
  tx: Pick<Prisma.TransactionClient, 'academicYear'>,
  academicYearId: string,
): Promise<(day: string) => GradeNumbering> {
  const years = await tx.academicYear.findMany({
    where: { school: { academicYears: { some: { id: academicYearId } } } },
    select: { id: true, startDate: true, endDate: true, gradeNumbering: true },
  });
  const spans = years.map((year) => ({
    scheduled: year.id === academicYearId,
    from: year.startDate.toISOString().slice(0, 10),
    to: year.endDate.toISOString().slice(0, 10),
    numbering: year.gradeNumbering ?? 'NIOARIG',
  }));
  return (day) => {
    const holding = spans.filter((span) => span.from <= day && day <= span.to);
    return (holding.find((span) => span.scheduled) ?? holding[0])?.numbering ?? 'NIOARIG';
  };
}
