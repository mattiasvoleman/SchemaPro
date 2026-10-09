import { BadRequestException, Injectable } from '@nestjs/common';
import type { StaffingPolicy } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import type { UpsertStaffingPolicyDto } from './dto/staffing-policy.dto';

/**
 * The policy as the client sees it: the one Decimal column as a number.
 *
 * Prisma hands `semesterHoursPerWeek` back as a Decimal, which JSON.stringify
 * renders as the string "40" — a form reading a number gets a string. Converted
 * once here, like the clocks in LunchSettingsService.
 */
export interface StaffingPolicyResponse
  extends Omit<StaffingPolicy, 'semesterHoursPerWeek'> {
  semesterHoursPerWeek: number;
}

/**
 * The table's defaults, restated. The DTO reads absent as "the default" and
 * the row is replaced whole, so the service has to know the defaults rather
 * than lean on the column — otherwise `update` would have nothing to write for
 * an omitted field and the PUT would stop being a replacement.
 */
export const STAFFING_POLICY_DEFAULTS = {
  fullTimeTeachingMinutesPerWeek: null,
  fullTimeRegulatedHoursPerYear: 1360,
  fullTimeAnnualHours: 1767,
  workDaysPerYear: 194,
  semesterHoursPerWeek: 40,
  qualificationMode: 'WARN',
  overAllocationMode: 'WARN',
  overAllocationTolerancePercent: 10,
  loadModel: 'MINUTES',
  unstaffedGeneration: 'ALLOW',
  shareEmploymentWithIntegrations: false,
} as const;

function toResponse(row: StaffingPolicy): StaffingPolicyResponse {
  return { ...row, semesterHoursPerWeek: Number(row.semesterHoursPerWeek) };
}

/**
 * Tjänstefördelningens inställningar: one row per school, upserted — the
 * lunch-settings pattern. The riktmärke is the one field with no default and
 * the whole point of the row; see the DTO.
 */
@Injectable()
export class StaffingPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The school's row, or null when nobody has decided anything yet. Null
   * rather than the defaults: "not yet decided" and "decided to keep 1 360 h"
   * are different facts, and the settings card shows the first as a prompt.
   */
  async get(user: AuthenticatedUser): Promise<StaffingPolicyResponse | null> {
    const schoolId = requireSchoolId(user);
    const row = await this.prisma.withRls(user, (tx) =>
      tx.staffingPolicy.findUnique({ where: { schoolId } }),
    );
    return row === null ? null : toResponse(row);
  }

  async upsert(
    dto: UpsertStaffingPolicyDto,
    user: AuthenticatedUser,
  ): Promise<StaffingPolicyResponse> {
    const schoolId = requireSchoolId(user);

    const data = {
      fullTimeTeachingMinutesPerWeek:
        dto.fullTimeTeachingMinutesPerWeek ??
        STAFFING_POLICY_DEFAULTS.fullTimeTeachingMinutesPerWeek,
      fullTimeRegulatedHoursPerYear:
        dto.fullTimeRegulatedHoursPerYear ??
        STAFFING_POLICY_DEFAULTS.fullTimeRegulatedHoursPerYear,
      fullTimeAnnualHours:
        dto.fullTimeAnnualHours ?? STAFFING_POLICY_DEFAULTS.fullTimeAnnualHours,
      workDaysPerYear: dto.workDaysPerYear ?? STAFFING_POLICY_DEFAULTS.workDaysPerYear,
      semesterHoursPerWeek:
        dto.semesterHoursPerWeek ?? STAFFING_POLICY_DEFAULTS.semesterHoursPerWeek,
      qualificationMode: dto.qualificationMode ?? STAFFING_POLICY_DEFAULTS.qualificationMode,
      overAllocationMode:
        dto.overAllocationMode ?? STAFFING_POLICY_DEFAULTS.overAllocationMode,
      overAllocationTolerancePercent:
        dto.overAllocationTolerancePercent ??
        STAFFING_POLICY_DEFAULTS.overAllocationTolerancePercent,
      loadModel: dto.loadModel ?? STAFFING_POLICY_DEFAULTS.loadModel,
      unstaffedGeneration:
        dto.unstaffedGeneration ?? STAFFING_POLICY_DEFAULTS.unstaffedGeneration,
      shareEmploymentWithIntegrations:
        dto.shareEmploymentWithIntegrations ??
        STAFFING_POLICY_DEFAULTS.shareEmploymentWithIntegrations,
    };

    // The table says the same with StaffingPolicies_regulatedHours_within_annual,
    // but only as a constraint name in a 500. This is the copy that can name
    // both numbers.
    if (data.fullTimeRegulatedHoursPerYear > data.fullTimeAnnualHours) {
      throw new BadRequestException(
        `Den reglerade arbetstiden (${data.fullTimeRegulatedHoursPerYear} h) kan inte vara större än årsarbetstiden (${data.fullTimeAnnualHours} h).`,
      );
    }

    try {
      return toResponse(
        await this.prisma.withRls(user, (tx) =>
          tx.staffingPolicy.upsert({
            where: { schoolId },
            create: { schoolId, ...data },
            update: data,
          }),
        ),
      );
    } catch (error) {
      rethrowPrismaError(error);
    }
  }
}
