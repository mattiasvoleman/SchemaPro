import { Controller, Get, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  StaffingLoadService,
  type TeacherLoadReportResponse,
} from './staffing-load.service';
import type { UnstaffedRequirement } from './teacher-load';

const uuid = () => new ParseUUIDPipe({ version: '4' });

/**
 * The belastningsrapport, read-only. Computed on every request from the rows
 * (teacher-load.ts), never stored — a stored figure would drift from the
 * requirements the first time one changed.
 *
 * TEACHER reads the load route for their own row; the unstaffed list is the
 * admin's to act on and admits nobody else.
 */
@Controller('api/v1/staffing')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class StaffingLoadController {
  constructor(private readonly loads: StaffingLoadService) {}

  /** `?academicYearId=&horizon=planned` — the whole school, or a teacher's own row. */
  @Get('load')
  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  load(
    @Query('academicYearId', uuid()) academicYearId: string,
    @Query('horizon') horizon: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TeacherLoadReportResponse> {
    return this.loads.load(academicYearId, horizon, user);
  }

  /** `?academicYearId=` — every requirement with no lead teacher. */
  @Get('unstaffed')
  unstaffed(
    @Query('academicYearId', uuid()) academicYearId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<UnstaffedRequirement[]> {
    return this.loads.unstaffed(academicYearId, user);
  }
}
