import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, type AcademicYear } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { parseDateString } from '../common/utils/time';
import type {
  CreateAcademicYearDto,
  UpdateAcademicYearDto,
} from './dto/academic-year.dto';

@Injectable()
export class AcademicYearsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    dto: CreateAcademicYearDto,
    user: AuthenticatedUser,
  ): Promise<AcademicYear> {
    const schoolId = requireSchoolId(user);
    if (dto.startDate >= dto.endDate) {
      throw new BadRequestException('startDate must be before endDate.');
    }
    try {
      return await this.prisma.withRls(user, async (tx) => {
        // Only one academic year may be active per school.
        if (dto.isActive) {
          await tx.academicYear.updateMany({
            where: { schoolId, isActive: true },
            data: { isActive: false },
          });
        }
        return tx.academicYear.create({
          data: {
            schoolId,
            name: dto.name,
            startDate: parseDateString(dto.startDate),
            endDate: parseDateString(dto.endDate),
            isActive: dto.isActive ?? false,
          },
        });
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  async update(
    id: string,
    dto: UpdateAcademicYearDto,
    user: AuthenticatedUser,
  ): Promise<AcademicYear> {
    const schoolId = requireSchoolId(user);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        // Moving the year is the other half of the containment rule that
        // TeachingRequirementsService.assertPeriodFitsYear enforces when a
        // period is written. Without this the invariant held only in one
        // direction: every period was measured against the year it was saved
        // into, and then the year could walk out from under all of them.
        //
        // Checked before the sibling deactivation below, not merely before the
        // update: the transaction would roll that write back anyway, but a
        // refusal that has already written something is one refactor away from
        // being a refusal that stole another year's active flag.
        if (dto.startDate !== undefined || dto.endDate !== undefined) {
          await this.assertYearStillHoldsItsPeriods(tx, id, dto);
        }

        if (dto.isActive) {
          await tx.academicYear.updateMany({
            where: { schoolId, isActive: true, id: { not: id } },
            data: { isActive: false },
          });
        }

        return tx.academicYear.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.startDate !== undefined
              ? { startDate: parseDateString(dto.startDate) }
              : {}),
            ...(dto.endDate !== undefined
              ? { endDate: parseDateString(dto.endDate) }
              : {}),
            ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          },
        });
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    try {
      await this.prisma.withRls(user, (tx) =>
        tx.academicYear.delete({ where: { id } }),
      );
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  /**
   * Refuses to move the year's own dates past a period that already depends on
   * them, and says how many periods are in the way.
   *
   * WHY REFUSE RATHER THAN FIX. Three ways out were on the table:
   *
   *  (a) refuse, naming the count — this one;
   *  (b) clip the offending periods to the new year;
   *  (c) drop the claim that a period lies inside its year.
   *
   * (b) rewrites data nobody asked to change. "Vårterminen 11 jan - 11 jun"
   * quietly becomes "18 jan - 11 jun" because the year's start moved a week,
   * and the admin who moved the year is told nothing about the course whose
   * length they just changed. The edit that caused it is one field on another
   * page, so there is nothing for anyone to connect the wrong hours to later.
   *
   * (c) is what we had. A period stranded outside its year generates no
   * lessons at all: the timplan still lists the subject, the row still says
   * "3 lektioner/vecka", and the subject is simply never read. That surfaces
   * in November, from a parent, and there is no error anywhere to search for.
   *
   * (a) fails at the moment of the change, in the same click that caused it,
   * and names the number of rows standing in the way so the admin knows the
   * size of the job. It costs them a detour through the timplan; the other two
   * cost a term of a subject. The error is also the recoverable direction: a
   * refused year change loses nothing, while a clipped period cannot be
   * restored from anything the app still holds.
   *
   * Widening the year always passes — nothing that fit inside the old bounds
   * can fall outside a superset — so the common corrections (extend the term,
   * fix a typo in June) are unaffected. It is the narrowing and the shift that
   * are stopped, which is exactly the pair that strands periods.
   *
   * `year` is missing when the lookup found nothing, which under RLS means the
   * year is not the caller's. Silent on purpose: the update below answers that
   * with the 404 it has always answered with, and counting somebody else's
   * requirements at them would confirm the year exists.
   *
   * THE BOUNDS ARE READ UNDER A ROW LOCK, in the transaction that writes them.
   * `withRls` runs READ COMMITTED, where a plain read holds nothing still, and
   * nothing on AcademicYears orders the two dates. Against a year with no dated
   * period yet, a PATCH moving the start to 2027-06-01 and one moving the end
   * to 2026-09-01 would each pass against the row the other has not changed,
   * and together store a year that ends before it starts. With the lock the
   * second PATCH waits for the first to commit and is measured against what it
   * wrote. The periods the counts see needed no lock of their own: each of the
   * four comparisons is made against a bound one of the two PATCHes moved, so
   * a period both counts let through lies inside the year they build together,
   * and a dated period is itself what keeps that year from inverting.
   *
   * What the lock does not hold still is a period written at the same moment.
   * SchoolBreaksService and TeachingRequirementsService read the year without
   * a lock, so a lov saved while these counts run can land outside bounds they
   * have already cleared.
   *
   * FOR NO KEY UPDATE rather than FOR UPDATE: see the Isolation section of
   * PrismaService — every year-scoped insert takes FOR KEY SHARE on this row. A
   * raw `date` column comes back as the same midnight-UTC Date the model API
   * returns.
   */
  private async assertYearStillHoldsItsPeriods(
    tx: Prisma.TransactionClient,
    id: string,
    dto: UpdateAcademicYearDto,
  ): Promise<void> {
    const [year] = await tx.$queryRaw<Pick<AcademicYear, 'startDate' | 'endDate'>[]>`
      SELECT "startDate", "endDate"
      FROM "AcademicYears"
      WHERE "id" = ${id}::uuid
      FOR NO KEY UPDATE
    `;
    if (!year) return;

    // The bounds as they will END UP, not as they arrived: a PATCH carrying
    // only `startDate` still has to be measured together with the endDate
    // already on the row. Same reasoning as the one-field-at-a-time case in
    // TeachingRequirementsService.update.
    const startDate =
      dto.startDate !== undefined ? parseDateString(dto.startDate) : year.startDate;
    const endDate =
      dto.endDate !== undefined ? parseDateString(dto.endDate) : year.endDate;

    // create() rejects this before the transaction opens; update() never did,
    // so a one-sided move could invert the year. Checked here rather than
    // early because only the merged pair can be inverted, and because an
    // inverted year would otherwise be reported below as "every period is
    // outside", which is true and says nothing about the actual mistake.
    if (startDate >= endDate) {
      throw new BadRequestException('startDate must be before endDate.');
    }

    // Only a stated period can fall outside: null means "the year's own
    // boundary", which follows the year wherever it goes. Prisma's comparison
    // filters skip NULLs, so those rows are excluded without saying so twice.
    const stranded = await tx.teachingRequirement.count({
      where: {
        academicYearId: id,
        OR: [
          { startDate: { lt: startDate } },
          { startDate: { gt: endDate } },
          { endDate: { lt: startDate } },
          { endDate: { gt: endDate } },
        ],
      },
    });
    /*
     * Lov are dated against the same year and strand the same way, and worse.
     *
     * A stranded requirement period simply generates nothing. A stranded lov
     * stops suppressing publish — lessons reappear across a week the school is
     * shut — and it can never be edited back, because every write path measures
     * the range against the year it no longer fits inside. The only way out is
     * to delete it, which is not what an administrator moving a year by three
     * days is trying to do.
     *
     * Counted separately rather than folded into one number: "4 rader" tells
     * nobody where to look, and the two live on different pages.
     */
    const strandedBreaks = await tx.schoolBreak.count({
      where: {
        academicYearId: id,
        OR: [
          { startDate: { lt: startDate } },
          { startDate: { gt: endDate } },
          { endDate: { lt: startDate } },
          { endDate: { gt: endDate } },
        ],
      },
    });

    if (stranded === 0 && strandedBreaks === 0) return;

    const asDate = (value: Date): string => value.toISOString().slice(0, 10);
    const parts: string[] = [];
    if (stranded > 0) {
      parts.push(
        `${stranded} teaching requirement${stranded === 1 ? '' : 's'}`,
      );
    }
    if (strandedBreaks > 0) {
      parts.push(`${strandedBreaks} break${strandedBreaks === 1 ? '' : 's'}`);
    }
    throw new BadRequestException(
      `${parts.join(' and ')} would fall outside the new academic year ` +
        `(${asDate(startDate)} to ${asDate(endDate)}). ` +
        'Move or clear them first.',
    );
  }
}
