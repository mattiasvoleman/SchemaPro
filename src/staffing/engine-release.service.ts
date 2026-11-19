import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { requireSchoolId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';
import { lockApplyYearKey } from '../optimization/regeneration-lock';
import type { SetEngineReleaseDto } from './dto/engine-release.dto';

/** A post named in a release is not one of the year's. */
export const ENGINE_RELEASE_POST_NOT_IN_YEAR = 'ENGINE_RELEASE_POST_NOT_IN_YEAR';

/** One released post: when, and by whom (null when the person has been removed). */
export interface EngineRelease {
  requirementId: string;
  releasedAt: string;
  releasedById: string | null;
}

export interface EngineReleaseList {
  releases: EngineRelease[];
}

export interface EngineReleaseResult {
  /** Posts whose state changed. */
  changed: number;
  /** Posts that were in the state asked for already. */
  unchanged: number;
}

/**
 * Släppt för motorn: which timplansposter the school has released so that Föreslå bemanning may propose another teacher for them
 * (TeachingRequirementReleases, migration 20270226090000). A post that is staffed and not released is never moved by a proposal
 * (staffing-proposal.service.ts, planOf); a release is the school's own statement that it may be.
 *
 * ONE ROW A POST, AND ONE WRITE PATH. A release of a whole subject in a årskurs is the page expanding to the posts' ids; nothing
 * here knows a subject. A post already released keeps its first person and time (INSERT … ON CONFLICT DO NOTHING).
 *
 * THE YEAR'S STAFFING LOCK. A release is written under the lock a staffing apply of the same year takes, so a release and an
 * apply queue (at most 5 s, then 409 SCHEDULE_BUSY) rather than interleave: an apply that read the posts as released and is
 * overtaken by the release being taken back would otherwise write a change the school had withdrawn. The proposal's basis covers
 * the releases, so an apply after a release's change is refused as stale.
 *
 * Read and written by the school's administrators only; the table has no arm for anyone else (RLS sections 545–549). A release
 * is written as one row in ScheduleChangeLogs, ids only, so who took a release back is not lost with the row.
 */
@Injectable()
export class EngineReleaseService {
  private readonly logger = new Logger(EngineReleaseService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** The year's released posts. */
  async list(academicYearId: string, user: AuthenticatedUser): Promise<EngineReleaseList> {
    return this.prisma.withRls(user, async (tx) => {
      await this.requireYear(tx, academicYearId);
      const rows = await tx.teachingRequirementRelease.findMany({
        where: { requirement: { academicYearId } },
        select: { requirementId: true, releasedById: true, releasedAt: true },
        orderBy: { requirementId: 'asc' },
      });
      return {
        releases: rows.map((row) => ({
          requirementId: row.requirementId,
          releasedAt: row.releasedAt.toISOString(),
          releasedById: row.releasedById,
        })),
      };
    });
  }

  /** Sets, or takes back, the release of the posts. One transaction, all or nothing. */
  async set(dto: SetEngineReleaseDto, user: AuthenticatedUser): Promise<EngineReleaseResult> {
    const schoolId = requireSchoolId(user);
    const ids = [...new Set(dto.requirementIds)].sort();
    const result = await this.prisma.withRls(user, async (tx) => {
      await lockApplyYearKey(tx, 'staffing-proposal', dto.academicYearId);
      await this.requireYear(tx, dto.academicYearId);
      const posts = await tx.teachingRequirement.findMany({
        where: { id: { in: ids }, academicYearId: dto.academicYearId },
        select: { id: true },
      });
      if (posts.length !== ids.length) {
        throw new BadRequestException({
          message: 'En av posterna hör inte till läsåret. Läs om sidan och försök igen.',
          code: ENGINE_RELEASE_POST_NOT_IN_YEAR,
          params: { count: ids.length - posts.length },
        });
      }
      const already = new Set(
        (await tx.teachingRequirementRelease.findMany({ where: { requirementId: { in: ids } }, select: { requirementId: true } })).map(
          (row) => row.requirementId,
        ),
      );
      // The posts whose state this changes, in id order: what is released and not yet, or the reverse.
      const changing = ids.filter((id) => already.has(id) !== dto.released);
      if (changing.length === 0) return { changed: 0, unchanged: ids.length };
      if (dto.released) {
        await tx.teachingRequirementRelease.createMany({
          data: changing.map((requirementId) => ({ requirementId, schoolId, releasedById: user.userId ?? null })),
          skipDuplicates: true,
        });
      } else {
        await tx.teachingRequirementRelease.deleteMany({ where: { requirementId: { in: changing } } });
      }
      // The audit trail: ids only, as the staffing apply keeps it.
      await tx.scheduleChangeLog.create({
        data: {
          schoolId,
          academicYearId: dto.academicYearId,
          masterLessonId: null,
          actorId: user.userId ?? null,
          action: 'UPDATE',
          before: { kind: 'ENGINE_RELEASE', released: !dto.released, requirementIds: changing },
          after: { kind: 'ENGINE_RELEASE', released: dto.released, requirementIds: changing },
        },
        select: { id: true },
      });
      return { changed: changing.length, unchanged: ids.length - changing.length };
    })
      // A refusal the database makes that the checks above did not foresee (an area taken away since the guard, a deadlock) is
      // answered as every other write's, never a 500.
      .catch((error: unknown) => rethrowPrismaError(error));
    this.logger.log(
      `Engine release set [academicYearId=${dto.academicYearId}, released=${dto.released}, changed=${result.changed}, unchanged=${result.unchanged}]`,
    );
    return result;
  }

  private async requireYear(tx: PrismaClient, academicYearId: string): Promise<void> {
    const year = await tx.academicYear.findFirst({ where: { id: academicYearId }, select: { id: true } });
    if (!year) throw new NotFoundException('Academic year not found.');
  }
}
