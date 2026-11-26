import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma, type SchoolBreak } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { tellNewMentors } from '../family/leave-notices';
import { NotificationsService } from '../notifications/notifications.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { parseDateString } from '../common/utils/time';
import { readYearBoundsForShare } from './academic-year-bounds';
import type {
  ApplySchoolCalendarDto,
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

/** What one row of an applied calendar came to. */
export interface SchoolCalendarItemResult {
  /** The row's place in the list that was sent. */
  index: number;
  /** The lov it made or changed or already was; null for a made one in a dry run. */
  id: string | null;
  action: 'CREATED' | 'UPDATED' | 'UNCHANGED';
  /** Lessons it took (or, in a dry run, would take) out of the published calendar, the other rows not counted. */
  removedCalendarLessons: number;
}

/**
 * What applying a calendar answers with: the rows, and the lessons it took
 * out of the published calendar in all, a lesson on two overlapping rows
 * counted once. With `dryRun` nothing was written, and the numbers are what
 * would have been.
 */
export interface SchoolCalendarResult {
  dryRun: boolean;
  created: number;
  updated: number;
  unchanged: number;
  removedCalendarLessons: number;
  items: SchoolCalendarItemResult[];
}

/**
 * A lov closes the pupils' days it covers, so a lov written may bring a
 * pending leave request within the delegation, and its mentor then decides
 * it (app.leave_school_days, Mentorns ledighetsbeslut). A create, and an
 * update of the dates or the årskurser, therefore tell the mentors they give
 * a request, once each, in their own transaction. A delete only opens days
 * again: a request it lengthens goes from a mentor to rektor and gives
 * nobody one.
 */
@Injectable()
export class SchoolBreaksService {
  /**
   * NotificationsService is optional for the scripts and specs that build
   * this one by hand; without it a lov tells no mentor of the leave requests
   * it gives them (Nest always injects it).
   */
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

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
   *
   * The read takes FOR SHARE on the year, held until this lov commits, so a
   * year PATCH cannot narrow the bounds past it in between — see
   * readYearBoundsForShare.
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
        const year = await readYearBoundsForShare(tx, dto.academicYearId);
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

        const removedCalendarLessons = await this.removeLessonsInside(tx, created);
        if (this.notifications) await tellNewMentors(this.notifications, tx, schoolId);
        return { ...this.toResponse(created), removedCalendarLessons };
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  /**
   * A whole calendar in one write (Skolans kalender): the red days the year
   * has, a proposal for its lov, a municipality's file, each row a lov to make
   * or, with an `id`, one to move.
   *
   * ONE TRANSACTION, ALL OR NOTHING. A list that stopped at its seventh row
   * would leave a year with half a calendar and an admin who has to find which
   * half; one row outside the läsår refuses all of them, and says which. The
   * year is read FOR SHARE once (readYearBoundsForShare), as create does.
   *
   * A ROW THAT IS ALREADY THERE IS NOT WRITTEN AGAIN. The same name, kind, days
   * and årskurser as a lov of the year (a file read twice, a double click) is
   * `UNCHANGED`, writes nothing and takes no lesson: its lessons went when it
   * was made. Two equal rows in one list are one.
   *
   * THE LESSONS ARE COUNTED THE WAY A SINGLE WRITE COUNTS THEM
   * (removeLessonsInside, the same protection rule), after every row is
   * written, so a lesson on two overlapping rows is taken once and counted
   * once. `dryRun` counts the same lessons with a `count` and writes nothing:
   * the number the admin reads before the rows are saved is the one the save
   * then answers with, to the lesson, which the page that saves a lov one at a
   * time cannot say (its count comes after the write).
   *
   * The mentors are told once, as a create tells them (leave-notices.ts).
   */
  async applyCalendar(
    dto: ApplySchoolCalendarDto,
    user: AuthenticatedUser,
  ): Promise<SchoolCalendarResult> {
    const schoolId = requireSchoolId(user);
    const dryRun = dto.dryRun === true;
    const wanted = dto.breaks.map((row) => ({
      id: row.id ?? null,
      name: row.name,
      kind: row.kind ?? ('HOLIDAY' as const),
      startDate: parseDateString(row.startDate),
      endDate: parseDateString(row.endDate),
      minGradeLevel: row.minGradeLevel ?? null,
      maxGradeLevel: row.maxGradeLevel ?? null,
    }));
    for (const row of wanted) {
      this.assertGradeSpanIsWhole(row.minGradeLevel, row.maxGradeLevel);
    }

    try {
      return await this.prisma.withRls(user, async (tx) => {
        const year = await readYearBoundsForShare(tx, dto.academicYearId);
        wanted.forEach((row, index) => {
          try {
            this.assertRangeFitsYear(year, row.startDate, row.endDate);
          } catch (error) {
            // Which row, because a list of sixty with one outside the year is
            // otherwise a refusal to find by eye.
            if (error instanceof BadRequestException) {
              throw new BadRequestException(`breaks[${index}]: ${error.message}`);
            }
            throw error;
          }
        });

        const stored = await tx.schoolBreak.findMany({
          where: { academicYearId: dto.academicYearId },
        });
        const storedById = new Map(stored.map((row) => [row.id, row]));
        const keyOf = (row: {
          name: string;
          kind: string;
          startDate: Date;
          endDate: Date;
          minGradeLevel: number | null;
          maxGradeLevel: number | null;
        }): string =>
          [
            row.name.trim().toLowerCase(),
            row.kind,
            row.startDate.getTime(),
            row.endDate.getTime(),
            row.minGradeLevel,
            row.maxGradeLevel,
          ].join('|');
        const alreadyThere = new Map(stored.map((row) => [keyOf(row), row]));

        const items: SchoolCalendarItemResult[] = [];
        const touched: SchoolBreak[] = [];
        const touchedIndex: number[] = [];
        const madeInThisList = new Map<string, number>();
        let datesMoved = false;

        for (const [index, row] of wanted.entries()) {
          if (row.id !== null) {
            const current = storedById.get(row.id);
            // Another school's lov and a missing one answer alike, as update does.
            if (!current) throw new NotFoundException('The requested record does not exist.');
            if (keyOf(current) === keyOf(row)) {
              items.push({ index, id: current.id, action: 'UNCHANGED', removedCalendarLessons: 0 });
              continue;
            }
            const next = dryRun
              ? { ...current, ...row, id: current.id }
              : await tx.schoolBreak.update({
                  where: { id: current.id },
                  data: {
                    name: row.name,
                    kind: row.kind,
                    startDate: row.startDate,
                    endDate: row.endDate,
                    minGradeLevel: row.minGradeLevel,
                    maxGradeLevel: row.maxGradeLevel,
                  },
                });
            datesMoved ||=
              current.startDate.getTime() !== row.startDate.getTime() ||
              current.endDate.getTime() !== row.endDate.getTime() ||
              current.minGradeLevel !== row.minGradeLevel ||
              current.maxGradeLevel !== row.maxGradeLevel;
            touched.push(next as SchoolBreak);
            touchedIndex.push(items.length);
            items.push({ index, id: current.id, action: 'UPDATED', removedCalendarLessons: 0 });
            continue;
          }

          const key = keyOf(row);
          const there = alreadyThere.get(key);
          if (there) {
            items.push({ index, id: there.id, action: 'UNCHANGED', removedCalendarLessons: 0 });
            continue;
          }
          const twin = madeInThisList.get(key);
          if (twin !== undefined) {
            items.push({ index, id: items[twin]!.id, action: 'UNCHANGED', removedCalendarLessons: 0 });
            continue;
          }
          madeInThisList.set(key, items.length);
          datesMoved = true;
          if (dryRun) {
            touched.push({ ...row, id: '', schoolId, academicYearId: dto.academicYearId } as unknown as SchoolBreak);
            touchedIndex.push(items.length);
            items.push({ index, id: null, action: 'CREATED', removedCalendarLessons: 0 });
            continue;
          }
          const created = await tx.schoolBreak.create({
            data: {
              schoolId,
              academicYearId: dto.academicYearId,
              name: row.name,
              kind: row.kind,
              startDate: row.startDate,
              endDate: row.endDate,
              minGradeLevel: row.minGradeLevel,
              maxGradeLevel: row.maxGradeLevel,
            },
          });
          touched.push(created);
          touchedIndex.push(items.length);
          items.push({ index, id: created.id, action: 'CREATED', removedCalendarLessons: 0 });
        }

        let removedCalendarLessons = 0;
        if (dryRun) {
          // Each row alone, for the line under it; all of them together, once each, for the sum.
          for (const [place, row] of touched.entries()) {
            items[touchedIndex[place]!]!.removedCalendarLessons = await tx.calendarLesson.count({
              where: this.lessonsInside(row),
            });
          }
          removedCalendarLessons =
            touched.length === 0
              ? 0
              : await tx.calendarLesson.count({
                  where: { OR: touched.map((row) => this.lessonsInside(row)) },
                });
        } else {
          for (const [place, row] of touched.entries()) {
            const count = await this.removeLessonsInside(tx, row);
            items[touchedIndex[place]!]!.removedCalendarLessons = count;
            removedCalendarLessons += count;
          }
          if (this.notifications && datesMoved) await tellNewMentors(this.notifications, tx, schoolId);
        }

        const count = (action: SchoolCalendarItemResult['action']) =>
          items.filter((item) => item.action === action).length;
        return {
          dryRun,
          created: count('CREATED'),
          updated: count('UPDATED'),
          unchanged: count('UNCHANGED'),
          removedCalendarLessons,
          items,
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
            academicYearId: true,
            startDate: true,
            endDate: true,
            minGradeLevel: true,
            maxGradeLevel: true,
          },
        });
        // Nothing to measure against, and nothing to say about it: the update
        // below answers an unknown or cross-tenant id with its own 404.
        if (existing) {
          // The year in a read of its own rather than joined to the break, so
          // the lock falls on the year's row, which is what a year PATCH waits
          // on (readYearBoundsForShare). The id needs no lock: no PATCH moves a
          // lov to another year.
          this.assertRangeFitsYear(
            await readYearBoundsForShare(tx, existing.academicYearId),
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
        const removedCalendarLessons = await this.removeLessonsInside(tx, updated);
        const daysMove =
          startDate !== undefined ||
          endDate !== undefined ||
          dto.minGradeLevel !== undefined ||
          dto.maxGradeLevel !== undefined;
        if (this.notifications && daysMove) await tellNewMentors(this.notifications, tx, updated.schoolId);
        return { ...this.toResponse(updated), removedCalendarLessons };
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
   * THE PROTECTION RULE IS COPIED, NOT INVENTED. Not yet begun, still
   * `SCHEDULED`, no attendance recorded — reconcilableLessons
   * (propagate-template.ts), which master-lessons.service.ts asks when a
   * template is deleted. A lesson that has begun, been cancelled or
   * rescheduled by hand, or had a register taken against it is a record of
   * what happened, and a lov entered in March must not rewrite February.
   * Diverging here would mean a lesson that survives one path and not
   * another, which is the kind of difference nobody finds until a
   * frånvarorapport comes out empty.
   *
   * "Has begun" is an instant, `startsAt > now`, for reconcilableLessons'
   * reason: a day is the wrong grain. Asked by the school's today, a
   * studiedag entered at 14:00 for today took the 08:00 lesson the class had
   * already had — its lektionslogg with it (ON DELETE CASCADE) and its
   * minutes out of the timplan's genomförd tid, which counts a lesson once
   * it has ended. The lov does not unhold it. A lesson under way is being
   * held and stays with the rest.
   *
   * The regeneration's calendar sweep (optimization-proxy.service.ts) asks by
   * day on purpose, and the difference is not one this path should copy: the
   * publish that follows a regeneration writes whole days back from the
   * school's today, so a sweep that spared this morning would double it. A
   * lov writes nothing back — publish skips its days (publishSkips answers
   * BREAK, publish-days.ts) — so the lesson spared here is the only copy, and
   * nothing comes to double it.
   *
   * `date` bounds the purge to the lov's own days and nothing else. It is
   * compared against midnight UTC, which is what a DATE column holds, and is
   * the school's local day, which is what a lov's range is stated in. The
   * past needs no bound of its own: `startsAt` already leaves it, and a lov
   * that lies entirely behind us matches nothing, which is the right answer
   * and not an edge case to special-case.
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
  ): Promise<number> {
    const { count } = await tx.calendarLesson.deleteMany({
      where: this.lessonsInside(breakRow),
    });
    return count;
  }

  /**
   * The lessons a break takes, as a filter: removeLessonsInside deletes them
   * and a dry run counts them, by one rule written once.
   */
  private lessonsInside(
    breakRow: Pick<
      SchoolBreak,
      'startDate' | 'endDate' | 'minGradeLevel' | 'maxGradeLevel'
    >,
  ): Prisma.CalendarLessonWhereInput {
    return {
      date: { gte: breakRow.startDate, lte: breakRow.endDate },
      status: 'SCHEDULED',
      startsAt: { gt: new Date() },
      attendanceRecords: { none: {} },
      ...this.gradeLevelFilter(breakRow),
    };
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
