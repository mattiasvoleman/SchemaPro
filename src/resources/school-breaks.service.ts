import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, type SchoolBreak } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { parseDateString, todayInZone } from '../common/utils/time';
import type {
  CreateSchoolBreakDto,
  UpdateSchoolBreakDto,
} from './dto/school-break.dto';

/**
 * A break as the API states it: the two DATE columns as the plain YYYY-MM-DD
 * they are.
 *
 * The reasoning is teaching-requirements.service.ts's, unchanged — Prisma
 * hands back a `Date` and Nest serializes it as `2027-02-15T00:00:00.000Z`,
 * an instant with a Z nobody stored, which any client rendering it locally
 * reads as the previous day west of Greenwich. Reading the same row through
 * Supabase gives "2027-02-15", so leaving it would mean one field with two
 * formats decided by which door the value came through.
 */
export type SchoolBreakResponse = Omit<SchoolBreak, 'startDate' | 'endDate'> & {
  startDate: string;
  endDate: string;
};

/**
 * What a create or a move answers with.
 *
 * `removedCalendarLessons` is the whole reason this endpoint is not a plain
 * CRUD write. Entering a sportlov silently throws away a week of published
 * lessons, and an admin who is not told that has no way to discover it except
 * by scrolling the calendar. The count travels back so the UI can say it
 * outright — "Sportlov sparat. 42 lektioner togs bort ur kalendern." —
 * rather than leaving the deletion to be found later and read as data loss.
 */
export type SchoolBreakWriteResult = SchoolBreakResponse & {
  removedCalendarLessons: number;
};

@Injectable()
export class SchoolBreaksService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The year's breaks, earliest first.
   *
   * Ordered by date rather than by `createdAt` like its neighbours: a lov list
   * is read as a calendar, and the order they were typed in is meaningless to
   * anyone but the person who typed them. `academicYearId` is a filter, not a
   * tenancy check — RLS confines the read to the caller's school, so a year id
   * from another school simply matches nothing.
   */
  list(
    academicYearId: string,
    user: AuthenticatedUser,
  ): Promise<SchoolBreakResponse[]> {
    return this.prisma.withRls(user, async (tx) => {
      const rows = await tx.schoolBreak.findMany({
        where: { academicYearId },
        orderBy: [{ startDate: 'asc' }, { name: 'asc' }],
      });
      return rows.map((row) => this.toResponse(row));
    });
  }

  /**
   * The year is read inside the same transaction only to measure the range
   * against it — never to decide whether the id was the caller's to name. That
   * answer stays the database's: `SchoolBreaks` reaches its year through a
   * composite (id, schoolId) foreign key, which is the one check RLS could not
   * have made, because PostgreSQL runs referential integrity as the referenced
   * table's owner with row security off.
   */
  async create(
    dto: CreateSchoolBreakDto,
    user: AuthenticatedUser,
  ): Promise<SchoolBreakWriteResult> {
    const schoolId = requireSchoolId(user);
    const startDate = parseDateString(dto.startDate);
    const endDate = parseDateString(dto.endDate);
    const minGradeLevel = dto.minGradeLevel ?? null;
    const maxGradeLevel = dto.maxGradeLevel ?? null;
    this.assertGradeSpanIsWhole(minGradeLevel, maxGradeLevel);

    try {
      return await this.prisma.withRls(user, async (tx) => {
        const year = await tx.academicYear.findUnique({
          where: { id: dto.academicYearId },
          select: { startDate: true, endDate: true },
        });
        this.assertRangeFitsYear(year, startDate, endDate);

        const created = await tx.schoolBreak.create({
          data: {
            schoolId,
            academicYearId: dto.academicYearId,
            name: dto.name,
            ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
            startDate,
            endDate,
            minGradeLevel,
            maxGradeLevel,
          },
        });

        return {
          ...this.toResponse(created),
          removedCalendarLessons: await this.removeLessonsInside(tx, created, schoolId),
        };
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  /**
   * A move is a create all over again as far as the calendar is concerned, so
   * the purge runs on every update rather than only when a date changed.
   *
   * Considered and rejected: comparing the incoming range against the stored
   * one and skipping the delete when they match. It saves one indexed
   * `deleteMany` on a rename, and buys a class of bug in exchange — a lesson
   * that was materialized into the range AFTER the break was saved (a publish
   * of a template the break never covered, a hand-made lesson) would then
   * survive every subsequent edit of the very row that says it must not exist.
   * The purge is idempotent, so running it always simply means the row's claim
   * holds whenever anyone touches it.
   *
   * What an update cannot do is put lessons BACK. Narrowing a lov from a week
   * to a day, or from the whole school to åk 9, does not restore the lessons
   * the wider version deleted — they were rows, not a view, and nothing
   * remembers what they were. The UI has to say so before it saves a
   * narrowing; the service cannot help it there.
   */
  async update(
    id: string,
    dto: UpdateSchoolBreakDto,
    user: AuthenticatedUser,
  ): Promise<SchoolBreakWriteResult> {
    const startDate =
      dto.startDate !== undefined ? parseDateString(dto.startDate) : undefined;
    const endDate =
      dto.endDate !== undefined ? parseDateString(dto.endDate) : undefined;

    try {
      return await this.prisma.withRls(user, async (tx) => {
        // The range is checked as it will END UP, not as it arrived: a PATCH
        // carrying only `endDate` still has to be measured against the
        // `startDate` already on the row, or half a lov escapes its läsår
        // simply by being moved one field at a time.
        const existing = await tx.schoolBreak.findUnique({
          where: { id },
          select: {
            startDate: true,
            endDate: true,
            minGradeLevel: true,
            maxGradeLevel: true,
            academicYear: { select: { startDate: true, endDate: true } },
          },
        });
        // Nothing to measure against, and nothing to say about it: the update
        // below answers an unknown or cross-tenant id with its own 404.
        if (existing) {
          this.assertRangeFitsYear(
            existing.academicYear,
            startDate ?? existing.startDate,
            endDate ?? existing.endDate,
          );
          this.assertGradeSpanIsWhole(
            dto.minGradeLevel !== undefined
              ? (dto.minGradeLevel ?? null)
              : existing.minGradeLevel,
            dto.maxGradeLevel !== undefined
              ? (dto.maxGradeLevel ?? null)
              : existing.maxGradeLevel,
          );
        }

        const updated = await tx.schoolBreak.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
            ...(startDate !== undefined ? { startDate } : {}),
            ...(endDate !== undefined ? { endDate } : {}),
            ...(dto.minGradeLevel !== undefined
              ? { minGradeLevel: dto.minGradeLevel }
              : {}),
            ...(dto.maxGradeLevel !== undefined
              ? { maxGradeLevel: dto.maxGradeLevel }
              : {}),
          },
        });

        // The row Prisma hands back, not a merge of dto and `existing`: the
        // purge must run against what the table now holds, and one of those
        // two is a reconstruction that can drift from it.
        return {
          ...this.toResponse(updated),
          removedCalendarLessons: await this.removeLessonsInside(
            tx,
            updated,
            // The row's own school, not the caller's: the same value under RLS,
            // and taking it from the row keeps the purge measured against what
            // the table holds rather than against the request.
            updated.schoolId,
          ),
        };
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  /**
   * Deleting the lov does not bring the lessons back — see update(). It only
   * stops the range from being a reason not to publish new ones.
   */
  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    try {
      await this.prisma.withRls(user, (tx) =>
        tx.schoolBreak.delete({ where: { id } }),
      );
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  /**
   * The published lessons the break now says should not exist, thrown away.
   *
   * THE PROTECTION RULE IS COPIED, NOT INVENTED. Future, still `SCHEDULED`, no
   * attendance recorded — the same three conditions master-lessons.service.ts
   * uses when a template is deleted and optimization-proxy.service.ts uses
   * when a regeneration replaces one. A lesson that has already happened, been
   * cancelled or rescheduled by hand, or had a register taken against it is a
   * record of what happened, and a lov entered in March must not rewrite
   * February. Diverging here would mean a lesson that survives one path and
   * not another, which is the kind of difference nobody finds until a
   * frånvarorapport comes out empty.
   *
   * `date` is compared against midnight UTC, which is what a DATE column holds
   * — the same arithmetic both of those callers do, for the same reason.
   *
   * No `academicYearId` filter, and it is not an omission — but the reason is
   * not the one it first looks like.
   *
   * The tempting justification is that the range was proven to lie inside its
   * own läsår, so nothing outside that year can be in it. That rests on a
   * school never holding two overlapping AcademicYear rows, which nothing
   * enforces: a summer course or a re-taken year can overlap the ordinary one,
   * and then the argument is simply false.
   *
   * The real reason is that a lov is a statement about the SCHOOL and not about
   * a year. When the building is shut for sportlov it is shut for every year
   * row at once, so deleting across them is the correct behaviour rather than
   * an accident the argument above happens to permit. Filtering by year would
   * also have to join through `studentGroup`, whose year is the group's and not
   * the lesson's — which is a second reason, and a weaker one.
   */
  private async removeLessonsInside(
    tx: Prisma.TransactionClient,
    breakRow: Pick<
      SchoolBreak,
      'startDate' | 'endDate' | 'minGradeLevel' | 'maxGradeLevel'
    >,
    schoolId: string,
  ): Promise<number> {
    const school = await tx.school.findUnique({
      where: { id: schoolId },
      select: { timezone: true },
    });
    // Unreachable in practice — a caller's own school is always readable to
    // them — and if it ever happens, purging NOTHING is the recoverable half.
    // A lesson wrongly left standing sits visibly on a lov day in the calendar
    // the admin is already looking at; a lesson wrongly deleted looks exactly
    // like one that was never scheduled.
    if (!school) return 0;

    // The SCHOOL's today, not the server's. `new Date()` rounded down in UTC is
    // yesterday in Stockholm for the hour or two after local midnight, and this
    // number decides what may be deleted — so for that window the trim below
    // would have handed back a day the school had already taught and let the
    // purge take its lessons, which is the one thing the next comment promises
    // it does not do.
    const today = todayInZone(school.timezone);
    // A lov that starts in the past is trimmed to today rather than skipped:
    // the days that have already been taught stay, the remaining ones go. When
    // the whole range is behind us `gte` exceeds `lte` and nothing matches,
    // which is the right answer, not an edge case to special-case.
    const from = breakRow.startDate > today ? breakRow.startDate : today;

    const { count } = await tx.calendarLesson.deleteMany({
      where: {
        date: { gte: from, lte: breakRow.endDate },
        status: 'SCHEDULED',
        attendanceRecords: { none: {} },
        ...this.gradeLevelFilter(breakRow),
      },
    });
    return count;
  }

  /**
   * Narrows the purge to groups inside the break's year span, or to nothing at
   * all when the break is school-wide.
   *
   * A GROUP WITHOUT A YEAR IS NOT COVERED. `StudentGroup.gradeLevel` is null
   * for a teaching group — a nivågrupp or a språkval whose members are drawn
   * from several classes — and Prisma's `gte`/`lte` do not match NULL, so
   * those lessons survive a grade-narrowed lov. That is the intended
   * behaviour and not a leak in the filter.
   *
   * The choice is about which direction of error a human can find. Deleting a
   * språkval lesson that should have stayed leaves nothing behind: an absent
   * lesson looks exactly like a lesson that was never scheduled, and the
   * teacher discovers it by standing in an empty classroom. Leaving one that
   * should have gone puts a visible lesson on a lov day in a calendar the
   * admin is already looking at, next to the count this endpoint just
   * returned — wrong, but wrong out loud, and one click from fixed.
   *
   * The same argument covers `extraGroups`, which this filter deliberately
   * ignores: a joint lesson is matched on its owning group alone, so a lesson
   * owned by åk 8 and joined by åk 9 survives a prao for åk 9. Deleting it
   * would cancel the lesson for the åk 8 class that is still in school.
   */
  private gradeLevelFilter(
    breakRow: Pick<SchoolBreak, 'minGradeLevel' | 'maxGradeLevel'>,
  ): Prisma.CalendarLessonWhereInput {
    // Both or neither — the table CHECKs it and assertGradeSpanIsWhole refuses
    // the half-stated pair before it can get here. Tested for as a pair anyway
    // so a row written by some future path cannot turn "min only" into an
    // unbounded upper edge that quietly covers the whole school.
    if (breakRow.minGradeLevel === null || breakRow.maxGradeLevel === null) {
      return {};
    }
    return {
      studentGroup: {
        is: {
          gradeLevel: {
            gte: breakRow.minGradeLevel,
            lte: breakRow.maxGradeLevel,
          },
        },
      },
    };
  }

  /**
   * The two things about the range the columns cannot say for themselves.
   *
   * Ordering is a CHECK on the table already, but a CHECK violation arrives as
   * a raw constraint error and leaves as a 500 — true, useless, and not the
   * caller's fault. Repeated here so the answer names the field.
   *
   * Containment could not have been a CHECK at all: the year's bounds live in
   * another table and a CHECK cannot follow a foreign key. Without it a lov
   * can be entered in the wrong läsår entirely — and unlike a mis-dated
   * teaching requirement, which merely generates nothing, this one DELETES.
   * "Sportlov v.9" typed with the previous year still in the date picker would
   * take out a week of lessons in a year the admin was not even looking at.
   *
   * `year` is null when the lookup found nothing, which under RLS means the
   * year is not the caller's. Deliberately silent, exactly as
   * `assertPeriodFitsYear` is: the insert behind this is about to be refused
   * by the composite foreign key anyway, and answering "outside its year"
   * about a year the caller cannot see would confirm that it exists.
   */
  private assertRangeFitsYear(
    year: { startDate: Date; endDate: Date } | null,
    startDate: Date,
    endDate: Date,
  ): void {
    if (endDate < startDate) {
      throw new BadRequestException('endDate must not be before startDate.');
    }
    if (!year) return;

    const asDate = (value: Date): string => value.toISOString().slice(0, 10);
    for (const [field, value] of [
      ['startDate', startDate],
      ['endDate', endDate],
    ] as const) {
      if (value < year.startDate || value > year.endDate) {
        throw new BadRequestException(
          `${field} must fall inside the academic year ` +
            `(${asDate(year.startDate)} to ${asDate(year.endDate)}).`,
        );
      }
    }
  }

  /**
   * Both year bounds or neither, and in order.
   *
   * Same two CHECKs as the table, restated for the same reason the ordering
   * above is: a constraint violation is a 500 that names a constraint. Half a
   * span is worth refusing rather than coercing — "from åk 4" with no upper
   * bound could mean 4-9 or it could be a form the admin has not finished, and
   * the two differ by however many classes lose a week of lessons.
   */
  private assertGradeSpanIsWhole(
    minGradeLevel: number | null,
    maxGradeLevel: number | null,
  ): void {
    if ((minGradeLevel === null) !== (maxGradeLevel === null)) {
      throw new BadRequestException(
        'State both minGradeLevel and maxGradeLevel, or neither.',
      );
    }
    if (
      minGradeLevel !== null &&
      maxGradeLevel !== null &&
      minGradeLevel > maxGradeLevel
    ) {
      throw new BadRequestException(
        'minGradeLevel must not be greater than maxGradeLevel.',
      );
    }
  }

  /**
   * `toISOString().slice(0, 10)` rather than a locale format: Prisma reads a
   * DATE column as midnight UTC, so the first ten characters are the stored
   * date itself whatever the server's timezone. A local formatter would print
   * the previous day for any server west of Greenwich — the exact error this
   * shape exists to remove, reintroduced one layer down.
   */
  private toResponse(row: SchoolBreak): SchoolBreakResponse {
    return {
      ...row,
      startDate: row.startDate.toISOString().slice(0, 10),
      endDate: row.endDate.toISOString().slice(0, 10),
    };
  }
}
