import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { TimplanCoverageQueryDto } from './dto/timplan-coverage.dto';
import {
  TimplanCoverageService,
  type DeliveredCoverageResponse,
  type ScheduledCoverageResponse,
  type TimplanCoverageResponse,
} from './timplan-coverage.service';

/**
 * Timplanstäckning, by layer: ?layer=planned (the default, P2's answer
 * unchanged), ?layer=scheduled (schemalagt mot planerat) and ?layer=delivered
 * (genomfört mot schemalagt), with an optional studentGroupId drill-down on
 * the latter two. Each layer's response type is its
 * own; P2's is untouched.
 *
 * SCHOOL_ADMIN and TEACHER. The admin reads the pupil level; a teacher reads
 * the same document with every pupil id, figure and verdict stripped (see
 * TimplanCoverageService). Pupils and guardians are not here: the timplan
 * itself is theirs to read through PostgREST, a coverage report over other
 * pupils is not.
 *
 * Teacher minutes per subject are NOT here either: Fas 1/2's load report
 * (GET /staffing/load, /teacher/tjanst) already states them.
 */
@Controller('api/v1/timplan-coverage')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
export class TimplanCoverageController {
  constructor(private readonly coverage: TimplanCoverageService) {}

  @Get()
  get(
    @Query() query: TimplanCoverageQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TimplanCoverageResponse | ScheduledCoverageResponse | DeliveredCoverageResponse> {
    if (query.layer === 'scheduled') return this.coverage.scheduled(query, user);
    if (query.layer === 'delivered') return this.coverage.delivered(query, user);
    return this.coverage.planned(query, user);
  }
}
