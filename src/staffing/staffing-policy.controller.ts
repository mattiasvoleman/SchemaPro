import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  StaffingPolicyService,
  type StaffingPolicyResponse,
} from './staffing-policy.service';
import { UpsertStaffingPolicyDto } from './dto/staffing-policy.dto';

/**
 * Tjänstefördelningens inställningar. One row per school, so PUT rather than
 * POST/PATCH: nothing to create a second of, no id for a caller to hold.
 *
 * ADMIN ONLY, both verbs. The table's staff_select arm lets a teacher read the
 * row through Supabase — the self-view needs the riktmärke to draw its bar —
 * but the gateway route is the admin's settings card, and a GET here that
 * admitted TEACHER would be the one route in the module whose role list
 * differs from its writes for no reason the card has.
 */
@Controller('api/v1/staffing-policy')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class StaffingPolicyController {
  constructor(private readonly policy: StaffingPolicyService) {}

  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<StaffingPolicyResponse | null> {
    return this.policy.get(user);
  }

  @Put()
  upsert(
    @Body() dto: UpsertStaffingPolicyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StaffingPolicyResponse> {
    return this.policy.upsert(dto, user);
  }
}
