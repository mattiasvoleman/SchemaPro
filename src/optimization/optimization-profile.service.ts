import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { requireSchoolId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';
import type { SaveOptimizationProfileDto } from './dto/optimization-profile.dto';
import { profileView, type OptimizationProfileView } from './optimization-profile';

/**
 * The school's Generera profile (OptimizationProfiles, 20270314090000): read by every administrator, written by Schemaläggning (the
 * table's arm says so, and the route's @Area before it). One row a school; the first save makes it, a later one replaces the five weights.
 */
@Injectable()
export class OptimizationProfileService {
  constructor(private readonly prisma: PrismaService) {}

  read(user: AuthenticatedUser): Promise<OptimizationProfileView> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => profileView(await tx.optimizationProfile.findUnique({ where: { schoolId } })));
  }

  save(dto: SaveOptimizationProfileDto, user: AuthenticatedUser): Promise<OptimizationProfileView> {
    const schoolId = requireSchoolId(user);
    const weights = {
      preferredFree: dto.preferredFree,
      preferredBusy: dto.preferredBusy,
      disruption: dto.disruption,
      spread: dto.spread,
      teacherGap: dto.teacherGap,
    };
    return this.prisma.withRls(user, async (tx) =>
      profileView(await tx.optimizationProfile.upsert({ where: { schoolId }, create: { schoolId, ...weights }, update: weights })),
    );
  }
}
