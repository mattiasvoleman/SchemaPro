import { BadRequestException, Injectable } from '@nestjs/common';
import type { TeachingRequirement } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { SLOT_MINUTES, fitsTheGrid } from '../common/solver-grid';
import { parseDateString } from '../common/utils/time';
import { readYearBoundsForShare } from './academic-year-bounds';
import { enforceRequirementWrite, touchesStaffing } from '../staffing/staffing-enforcement';
import type { StaffingWarning } from '../staffing/staffing-checks';
import type {
  CreateTeachingRequirementDto,
  UpdateTeachingRequirementDto,
} from './dto/teaching-requirement.dto';

/**
 * A requirement as the API states it: the two DATE columns as the plain
 * YYYY-MM-DD they are, not as the instant JSON.stringify makes of a `Date`.
 *
 * WHY THE SHAPE IS FIXED HERE AND NOT IN THE CLIENT. The same field reached
 * the web app in two formats. Reading the table through Supabase gives
 * "2027-01-11", because PostgREST renders a DATE as a date; the POST/PATCH
 * response from this service gave "2027-01-11T00:00:00.000Z", because Prisma
 * hands back a `Date` and Nest serializes it as an instant. Two formats for
 * one field, decided by which door the value came through.
 *
 * The midnight instant is not just longer, it is made up: a DATE column has no
 * time of day and no zone, so the Z is a fact nobody stored. Any client that
 * renders it locally reads the previous day west of Greenwich.
 *
 * Normalised on the server rather than in web/lib/queries.ts for two reasons.
 * The instant is invented HERE, so this is where it can stop existing — a
 * client-side normaliser leaves every other consumer (the mobile app, an
 * integration key holder, curl) with the divergence intact. And the web fix
 * would have been a no-op that looked like a fix: useCrudMutations discards
 * the response body and refetches from Supabase, so today's cache never holds
 * an instant at all. The bug is not that the client mishandles the instant; it
 * is that trusting the type (web/lib/types.ts: "YYYY-MM-DD") would break the
 * moment anyone read the response — lib/teaching-hours.ts compares these
 * strings against the year's bounds and parses them with `new Date(v +
 * "T00:00:00")`, which an instant turns into Invalid Date and a whole year of
 * hours into 0 h, and an `<input type="date">` refilled from one shows empty.
 */
export type TeachingRequirementResponse = Omit<
  TeachingRequirement,
  'startDate' | 'endDate'
> & {
  startDate: string | null;
  endDate: string | null;
};

/**
 * A create or PATCH answered back, with what the staffing policy's WARN mode
 * had to say about it: STAFF_TEACHER_NOT_QUALIFIED / STAFF_TEACHER_OVER_TARGET
 * with their params, empty when nothing was found or nothing was asked. A
 * REFUSE never reaches here — it is the 409 the write answered instead.
 */
export type StaffedRequirementResponse = TeachingRequirementResponse & {
  warnings: StaffingWarning[];
};

@Injectable()
export class TeachingRequirementsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The five referenced ids go in as they arrived, and no ownership check
   * happens here on purpose: the database refuses a reference to another
   * school. `TeachingRequirements` names its year, subject, group and both
   * teachers through composite (id, schoolId) foreign keys, so a row whose
   * `schoolId` is the caller's cannot name anything that is not
   * (20260822130000). RLS could not have done this — PostgreSQL runs
   * referential-integrity checks as the referenced table's owner with row
   * security off, so a foreign key to a row the caller cannot even SELECT
   * still validates.
   *
   * A refused reference surfaces as P2003, which `rethrowPrismaError` maps to
   * "references a record that does not exist" — the same answer the caller
   * would get for an id that never existed, which is what a foreign id is as
   * far as their tenant is concerned.
   *
   * A stated period does read the year first, but only to measure the dates
   * against it (`assertPeriodFitsYear`) — never to decide whether the id was
   * the caller's to name. That answer is still the database's alone. The read
   * takes FOR SHARE on the year, held until the period commits, so a year PATCH
   * cannot narrow the bounds past it in between — see readYearBoundsForShare.
   */
  async create(
    dto: CreateTeachingRequirementDto,
    user: AuthenticatedUser,
  ): Promise<StaffedRequirementResponse> {
    // Needs nothing from the database, so it answers before one is opened.
    this.assertLessonLengthFitsTheGrid(dto.minutesPerLesson);
    const schoolId = requireSchoolId(user);
    const startDate = dto.startDate ? parseDateString(dto.startDate) : null;
    const endDate = dto.endDate ? parseDateString(dto.endDate) : null;
    try {
      return await this.prisma.withRls(user, async (tx) => {
        // Only a stated period is worth a round trip. A requirement without one
        // runs the whole year by definition, so there is nothing the year's
        // bounds could contradict.
        if (startDate || endDate) {
          const year = await readYearBoundsForShare(tx, dto.academicYearId);
          this.assertPeriodFitsYear(year, startDate, endDate);
        }

        // The figures the row is written with, defaults filled in ONCE, so
        // the staffing check below judges exactly what the insert writes. It
        // used to be handed the raw DTO: a null that reached it read as 0
        // minutes while the insert wrote `?? 1` lessons or `?? 100` %, and a
        // REFUSE passed a row that put the teacher over.
        const charged = {
          teacherId: dto.teacherId ?? null,
          coTeacherId: dto.coTeacherId ?? null,
          // Stated, like the buffers below, so the row answered back is the
          // row the request described rather than what the default filled in.
          teacherLoadPercent: dto.teacherLoadPercent ?? 100,
          coTeacherLoadPercent: dto.coTeacherLoadPercent ?? 100,
          lessonsPerWeek: dto.lessonsPerWeek ?? 1,
          minutesPerLesson: dto.minutesPerLesson ?? 60,
          recurrence: dto.recurrence ?? 'ALL_WEEKS',
        } as const;

        // The staffing policy's two questions, asked of the row as it is about
        // to be written and before it is — see staffing-enforcement.ts. A
        // REFUSE throws here and nothing is written.
        const warnings = await enforceRequirementWrite(tx, {
          schoolId,
          academicYearId: dto.academicYearId,
          requirementId: null,
          subjectId: dto.subjectId,
          studentGroupId: dto.studentGroupId,
          before: null,
          patch: {
            ...charged,
            startDate: dto.startDate || null,
            endDate: dto.endDate || null,
          },
        });

        const created = await tx.teachingRequirement.create({
          data: {
            schoolId,
            academicYearId: dto.academicYearId,
            subjectId: dto.subjectId,
            studentGroupId: dto.studentGroupId,
            teacherId: charged.teacherId,
            coTeacherId: charged.coTeacherId,
            teacherLoadPercent: charged.teacherLoadPercent,
            coTeacherLoadPercent: charged.coTeacherLoadPercent,
            lessonsPerWeek: charged.lessonsPerWeek,
            minutesPerLesson: charged.minutesPerLesson,
            // The pupil buffers, stated here rather than left to the column
            // default for the same reason every other figure above is: the
            // created row is answered back to the caller, and a field the
            // insert omitted comes back from the database rather than from the
            // request. Zero is the school that has not asked for ombyte.
            minutesBefore: dto.minutesBefore ?? 0,
            minutesAfter: dto.minutesAfter ?? 0,
            recurrence: charged.recurrence,
            startDate,
            endDate,
          },
        });
        return { ...this.toResponse(created), warnings };
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  async update(
    id: string,
    dto: UpdateTeachingRequirementDto,
    user: AuthenticatedUser,
  ): Promise<StaffedRequirementResponse> {
    const startDate = dto.startDate ? parseDateString(dto.startDate) : null;
    const endDate = dto.endDate ? parseDateString(dto.endDate) : null;
    try {
      return await this.prisma.withRls(user, async (tx) => {
        // Needs nothing from the database, so it runs before anything is read
        // — and outside the period's condition, or a PATCH carrying only
        // `minutesPerLesson`, which is the ordinary edit, would skip it.
        this.assertLessonLengthFitsTheGrid(dto.minutesPerLesson);

        // The period is checked as it will END UP, not as it arrived. A PATCH
        // carrying only `endDate` still has to be measured against the
        // `startDate` already on the row, or half a period escapes the year
        // simply by being moved one field at a time.
        if (dto.startDate !== undefined || dto.endDate !== undefined) {
          const existing = await tx.teachingRequirement.findUnique({
            where: { id },
            select: { academicYearId: true, startDate: true, endDate: true },
          });
          // Nothing to measure against, and nothing to say about it: the
          // update below answers an unknown or foreign id with the 404 it has
          // always answered with.
          if (existing) {
            // The year in a read of its own, locked, for the reason create()
            // gives. The id needs no lock: no PATCH moves a requirement to
            // another year.
            this.assertPeriodFitsYear(
              await readYearBoundsForShare(tx, existing.academicYearId),
              dto.startDate !== undefined ? startDate : existing.startDate,
              dto.endDate !== undefined ? endDate : existing.endDate,
            );
          }
        }

        // The staffing policy's two questions, asked only of a PATCH that can
        // change who teaches the row or what it charges them, and of the row as
        // it will end up. The stored row is read for its year and its teachers;
        // a row RLS hides is left to the update below, which answers 404.
        let warnings: StaffingWarning[] = [];
        if (touchesStaffing(dto)) {
          const stored = await tx.teachingRequirement.findUnique({
            where: { id },
            select: {
              academicYearId: true,
              subjectId: true,
              studentGroupId: true,
              teacherId: true,
              coTeacherId: true,
            },
          });
          if (stored) {
            warnings = await enforceRequirementWrite(tx, {
              schoolId: requireSchoolId(user),
              academicYearId: stored.academicYearId,
              requirementId: id,
              subjectId: stored.subjectId,
              studentGroupId: stored.studentGroupId,
              before: { teacherId: stored.teacherId, coTeacherId: stored.coTeacherId },
              patch: {
                teacherId: dto.teacherId,
                coTeacherId: dto.coTeacherId,
                lessonsPerWeek: dto.lessonsPerWeek,
                minutesPerLesson: dto.minutesPerLesson,
                teacherLoadPercent: dto.teacherLoadPercent,
                coTeacherLoadPercent: dto.coTeacherLoadPercent,
                recurrence: dto.recurrence,
                ...(dto.startDate !== undefined ? { startDate: dto.startDate || null } : {}),
                ...(dto.endDate !== undefined ? { endDate: dto.endDate || null } : {}),
              },
            });
          }
        }

        const updated = await tx.teachingRequirement.update({
          where: { id },
          data: {
            ...(dto.teacherId !== undefined ? { teacherId: dto.teacherId } : {}),
            ...(dto.coTeacherId !== undefined
              ? { coTeacherId: dto.coTeacherId }
              : {}),
            ...(dto.teacherLoadPercent !== undefined
              ? { teacherLoadPercent: dto.teacherLoadPercent }
              : {}),
            ...(dto.coTeacherLoadPercent !== undefined
              ? { coTeacherLoadPercent: dto.coTeacherLoadPercent }
              : {}),
            ...(dto.lessonsPerWeek !== undefined
              ? { lessonsPerWeek: dto.lessonsPerWeek }
              : {}),
            ...(dto.minutesPerLesson !== undefined
              ? { minutesPerLesson: dto.minutesPerLesson }
              : {}),
            ...(dto.minutesBefore !== undefined
              ? { minutesBefore: dto.minutesBefore }
              : {}),
            ...(dto.minutesAfter !== undefined
              ? { minutesAfter: dto.minutesAfter }
              : {}),
            ...(dto.recurrence !== undefined
              ? { recurrence: dto.recurrence }
              : {}),
            ...(dto.startDate !== undefined ? { startDate } : {}),
            ...(dto.endDate !== undefined ? { endDate } : {}),
          },
        });
        return { ...this.toResponse(updated), warnings };
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    try {
      await this.prisma.withRls(user, (tx) =>
        tx.teachingRequirement.delete({ where: { id } }),
      );
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  /**
   * The row as the API states it — see TeachingRequirementResponse above for
   * why the two dates leave here as strings.
   *
   * `toISOString().slice(0, 10)` rather than a locale format: Prisma reads a
   * DATE column as midnight UTC, so the first ten characters are the stored
   * date itself, whatever the server's timezone. A local formatter would print
   * the previous day for any server west of Greenwich — the exact error this
   * whole change exists to remove, reintroduced one layer down.
   */
  private toResponse(row: TeachingRequirement): TeachingRequirementResponse {
    return {
      ...row,
      startDate: row.startDate ? row.startDate.toISOString().slice(0, 10) : null,
      endDate: row.endDate ? row.endDate.toISOString().slice(0, 10) : null,
    };
  }

  /**
   * The two things the columns cannot say for themselves.
   *
   * The ordering is a CHECK on the table already, but a CHECK violation
   * arrives as a raw constraint error and leaves as a 500 — true, useless, and
   * not the caller's fault. It is repeated here so the answer names the field.
   *
   * Containment could not have been a CHECK at all: the year's bounds live in
   * another table and a CHECK cannot follow a foreign key, which is why the
   * migration declines to try and points here instead. Without it "vårterminen"
   * can be entered as a window in the wrong year entirely — the row saves, the
   * requirement generates nothing, and the timplan looks complete while the
   * subject is never read.
   *
   * `year` is null when the lookup found nothing, which under RLS means the
   * year is not the caller's. That is deliberately silent: the insert behind
   * this is about to be refused by the same composite foreign key that refuses
   * every other id here (see create()), and answering "outside its year" about
   * a year the caller cannot see would confirm that it exists.
   */
  /**
   * A lesson length the solver can actually lay on its grid.
   *
   * `@Min(15) @Max(240)` on the DTO says the number is plausible; it does not
   * say the engine can express it. The engine turns minutes into whole slots
   * and refuses a remainder, so a 40-minute lesson on the old 15-minute grid
   * was accepted here, stored, and then blew up as an unhandled ValueError the
   * first time somebody pressed "generera" — one service away from the field
   * that caused it, and reported as a 500.
   *
   * The grid is five minutes now, which admits 40 and 50. This guard is for
   * what is left: 37, 41, anything typed by hand that lands between slots. It
   * belongs here rather than only in the DTO because the message should name
   * the nearest lengths that work, and a decorator cannot.
   */
  private assertLessonLengthFitsTheGrid(minutes: number | undefined): void {
    if (minutes === undefined || fitsTheGrid(minutes)) return;
    const below = Math.floor(minutes / SLOT_MINUTES) * SLOT_MINUTES;
    const above = below + SLOT_MINUTES;
    throw new BadRequestException(
      `${minutes} minuter går inte att lägga på schemat, som räknar i hela ` +
        `${SLOT_MINUTES}-minutersintervall. Närmast är ${below} eller ${above} minuter.`,
    );
  }

  private assertPeriodFitsYear(
    year: { startDate: Date; endDate: Date } | null,
    startDate: Date | null,
    endDate: Date | null,
  ): void {
    if (startDate && endDate && endDate < startDate) {
      throw new BadRequestException('endDate must not be before startDate.');
    }
    if (!year) return;

    const asDate = (value: Date): string => value.toISOString().slice(0, 10);
    for (const [field, value] of [
      ['startDate', startDate],
      ['endDate', endDate],
    ] as const) {
      if (value && (value < year.startDate || value > year.endDate)) {
        throw new BadRequestException(
          `${field} must fall inside the academic year ` +
            `(${asDate(year.startDate)} to ${asDate(year.endDate)}).`,
        );
      }
    }
  }
}
