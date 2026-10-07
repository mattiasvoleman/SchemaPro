import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import type { ReplaceYearTimplansDto } from './dto/year-timplans.dto';
import { readYearTimplans, type YearTimplanRow } from './year-timplans';

const yearNotFound = () => new NotFoundException('Läsåret finns inte.');

/**
 * Timplan per årskurs: which lokal timplan each årskurs of a läsår follows.
 *
 * The table's three RLS arms decide who reads; this service is the admin's
 * door for the year dialog. A new year gets its defaults from
 * AcademicYearsService.create (attachDefaultTimplans); existing years start
 * empty — the migration backfills nothing — and are filled here.
 *
 * WHAT IS NOT REFUSED. A draft plan (next year planned in the spring), two
 * school forms in one year (grundskola and anpassad grundskola side by side),
 * a grade the plan has no entries for: all legal, all marked by the readers —
 * the coverage report says TIMPLAN_ATTACHED_DRAFT, and a grade without entries
 * simply has no target. Nothing here judges the content of a plan.
 */
@Injectable()
export class AcademicYearTimplansService {
  constructor(private readonly prisma: PrismaService) {}

  async list(academicYearId: string, user: AuthenticatedUser): Promise<YearTimplanRow[]> {
    requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const year = await tx.academicYear.findUnique({
        where: { id: academicYearId },
        select: { id: true },
      });
      if (!year) throw yearNotFound();
      return readYearTimplans(tx, academicYearId);
    });
  }

  /**
   * Replace the year's mapping with exactly `dto.timplans`, rows with a null
   * plan and grades left out both meaning "none".
   *
   * THE YEAR ROW IS LOCKED FIRST, FOR NO KEY UPDATE, the lock the year PATCH
   * takes. Two admins saving the dialog at once then queue, and the second
   * writes over the first wholesale — what "replace" promises — instead of
   * both deleting what they read and one dying on the primary key as a 409
   * neither did anything to earn. NO KEY, so the FOR KEY SHARE every
   * year-scoped insert takes through its foreign key does not wait on it.
   * Under RLS only SCHOOL_ADMIN can take it (academic_years_admin_all is the
   * only UPDATE arm), which is the only role behind the route; a year RLS hides
   * reads no row and is the 404.
   *
   * Every named plan must be one the caller sees, or the request is a 400
   * naming the ids — never a silently shorter mapping. The composite key
   * refuses another school's plan as well, as the second line.
   *
   * Diffed, not deleted-and-reinserted: a grade whose plan did not change
   * keeps its row (and its createdAt), which is what the rollover will copy.
   */
  async replace(
    academicYearId: string,
    dto: ReplaceYearTimplansDto,
    user: AuthenticatedUser,
  ): Promise<YearTimplanRow[]> {
    const schoolId = requireSchoolId(user);
    assertOneRowPerGrade(dto);
    const wanted = new Map<number, string>();
    for (const row of dto.timplans) {
      if (row.localTimplanId !== null) wanted.set(row.gradeLevel, row.localTimplanId);
    }
    try {
      return await this.prisma.withRls(user, async (tx) => {
        if (!(await lockYear(tx, academicYearId))) throw yearNotFound();

        const planIds = [...new Set(wanted.values())];
        if (planIds.length > 0) {
          const known = await tx.localTimplan.findMany({
            where: { id: { in: planIds } },
            select: { id: true },
          });
          const seen = new Set(known.map((plan) => plan.id));
          const unknown = planIds.filter((id) => !seen.has(id));
          if (unknown.length > 0) {
            throw new BadRequestException(
              `timplans: den lokala timplanen finns inte i skolan: ${unknown.join(', ')}.`,
            );
          }
        }

        const existing = await tx.academicYearTimplan.findMany({
          where: { academicYearId },
          select: { gradeLevel: true, localTimplanId: true },
        });
        const dropped = existing
          .filter((row) => !wanted.has(row.gradeLevel))
          .map((row) => row.gradeLevel);
        if (dropped.length > 0) {
          await tx.academicYearTimplan.deleteMany({
            where: { academicYearId, gradeLevel: { in: dropped } },
          });
        }
        const current = new Map(existing.map((row) => [row.gradeLevel, row.localTimplanId]));
        for (const [gradeLevel, localTimplanId] of [...wanted].sort(([a], [b]) => a - b)) {
          const before = current.get(gradeLevel);
          if (before === localTimplanId) continue;
          if (before === undefined) {
            await tx.academicYearTimplan.create({
              data: { schoolId, academicYearId, gradeLevel, localTimplanId },
            });
          } else {
            await tx.academicYearTimplan.update({
              where: { academicYearId_gradeLevel: { academicYearId, gradeLevel } },
              data: { localTimplanId },
            });
          }
        }
        return readYearTimplans(tx, academicYearId);
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }
}

/** True when the year exists for the caller; the row stays locked till commit. */
async function lockYear(tx: Prisma.TransactionClient, academicYearId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id"
    FROM "AcademicYears"
    WHERE "id" = ${academicYearId}::uuid
    FOR NO KEY UPDATE
  `;
  return rows.length > 0;
}

/** One row per årskurs; the primary key would refuse the second as a bare 409. */
function assertOneRowPerGrade(dto: ReplaceYearTimplansDto): void {
  const seen = new Map<number, number>();
  for (const [index, row] of dto.timplans.entries()) {
    const first = seen.get(row.gradeLevel);
    if (first !== undefined) {
      throw new BadRequestException(
        `timplans: rad ${index + 1} gäller samma årskurs ${row.gradeLevel} som rad ${first + 1}. ` +
          'Varje årskurs följer en timplan.',
      );
    }
    seen.set(row.gradeLevel, index);
  }
}
