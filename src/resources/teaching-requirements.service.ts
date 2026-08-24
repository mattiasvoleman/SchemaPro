import { BadRequestException, Injectable } from '@nestjs/common';
import type { TeachingRequirement } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { parseDateString } from '../common/utils/time';
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
   * the caller's to name. That answer is still the database's alone.
   */
  async create(
    dto: CreateTeachingRequirementDto,
    user: AuthenticatedUser,
  ): Promise<TeachingRequirementResponse> {
    const schoolId = requireSchoolId(user);
    const startDate = dto.startDate ? parseDateString(dto.startDate) : null;
    const endDate = dto.endDate ? parseDateString(dto.endDate) : null;
    try {
      return await this.prisma.withRls(user, async (tx) => {
        // Only a stated period is worth a round trip. A requirement without one
        // runs the whole year by definition, so there is nothing the year's
        // bounds could contradict.
        if (startDate || endDate) {
          const year = await tx.academicYear.findUnique({
            where: { id: dto.academicYearId },
            select: { startDate: true, endDate: true },
          });
          this.assertPeriodFitsYear(year, startDate, endDate);
        }

        const created = await tx.teachingRequirement.create({
          data: {
            schoolId,
            academicYearId: dto.academicYearId,
            subjectId: dto.subjectId,
            studentGroupId: dto.studentGroupId,
            teacherId: dto.teacherId ?? null,
            coTeacherId: dto.coTeacherId ?? null,
            lessonsPerWeek: dto.lessonsPerWeek ?? 1,
            minutesPerLesson: dto.minutesPerLesson ?? 60,
            recurrence: dto.recurrence ?? 'ALL_WEEKS',
            startDate,
            endDate,
          },
        });
        return this.toResponse(created);
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  async update(
    id: string,
    dto: UpdateTeachingRequirementDto,
    user: AuthenticatedUser,
  ): Promise<TeachingRequirementResponse> {
    const startDate = dto.startDate ? parseDateString(dto.startDate) : null;
    const endDate = dto.endDate ? parseDateString(dto.endDate) : null;
    try {
      return await this.prisma.withRls(user, async (tx) => {
        // The period is checked as it will END UP, not as it arrived. A PATCH
        // carrying only `endDate` still has to be measured against the
        // `startDate` already on the row, or half a period escapes the year
        // simply by being moved one field at a time.
        if (dto.startDate !== undefined || dto.endDate !== undefined) {
          const existing = await tx.teachingRequirement.findUnique({
            where: { id },
            select: {
              startDate: true,
              endDate: true,
              academicYear: { select: { startDate: true, endDate: true } },
            },
          });
          // Nothing to measure against, and nothing to say about it: the
          // update below answers an unknown or foreign id with the 404 it has
          // always answered with.
          if (existing) {
            this.assertPeriodFitsYear(
              existing.academicYear,
              dto.startDate !== undefined ? startDate : existing.startDate,
              dto.endDate !== undefined ? endDate : existing.endDate,
            );
          }
        }

        const updated = await tx.teachingRequirement.update({
          where: { id },
          data: {
            ...(dto.teacherId !== undefined ? { teacherId: dto.teacherId } : {}),
            ...(dto.coTeacherId !== undefined
              ? { coTeacherId: dto.coTeacherId }
              : {}),
            ...(dto.lessonsPerWeek !== undefined
              ? { lessonsPerWeek: dto.lessonsPerWeek }
              : {}),
            ...(dto.minutesPerLesson !== undefined
              ? { minutesPerLesson: dto.minutesPerLesson }
              : {}),
            ...(dto.recurrence !== undefined
              ? { recurrence: dto.recurrence }
              : {}),
            ...(dto.startDate !== undefined ? { startDate } : {}),
            ...(dto.endDate !== undefined ? { endDate } : {}),
          },
        });
        return this.toResponse(updated);
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
