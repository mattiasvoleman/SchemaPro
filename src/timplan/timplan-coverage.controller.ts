import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { TimplanCoverageQueryDto } from './dto/timplan-coverage.dto';
import { TimplanCoverageService, type TimplanCoverageResponse } from './timplan-coverage.service';

/**
 * Timplanstäckning. Today layer 1 only (?layer=planned, the default);
 * "schemalagt" and "genomfört" are the next phase and answer 400 until then.
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
  ): Promise<TimplanCoverageResponse> {
    return this.coverage.planned(query, user);
  }
}
