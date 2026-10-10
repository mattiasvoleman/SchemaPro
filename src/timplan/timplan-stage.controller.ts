import { Body, Controller, Delete, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PublishTimplanStatementDto, TeachingTimeCardQueryDto, TimplanStageQueryDto } from './dto/timplan-stage.dto';
import {
  TimplanStageService,
  type StagePublicationSummary,
  type TeachingTimeCardResponse,
  type TimplanStageResponse,
} from './timplan-stage.service';

/**
 * Stadiesummor över läsår (timplan P4).
 *
 *   GET    /timplan-stages              the Stadium view: per class, and per pupil with studentGroupId
 *   POST   /timplan-stages/statements   publish the families' "Undervisningstid" for the active year
 *   DELETE /timplan-stages/statements   withdraw it
 *   GET    /timplan-stages/card         one pupil's card, read under the caller's RLS
 *
 * The first three are SCHOOL_ADMIN's: the view is per pupil by nature, and a
 * teacher's coverage strips every pupil figure (P2/P3). The card is a
 * pupil's own and a guardian's child's — and the admin's, to see what the
 * family sees; TimplanStatements' RLS arms decide which rows exist for the
 * caller, so a pupil asking for a classmate reads nothing. Teachers read no
 * card.
 */
@Controller('api/v1/timplan-stages')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TimplanStageController {
  constructor(private readonly stages: TimplanStageService) {}

  @Get()
  @Roles(Role.SCHOOL_ADMIN)
  overview(@Query() query: TimplanStageQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<TimplanStageResponse> {
    return this.stages.overview(query, user);
  }

  @Post('statements')
  @Roles(Role.SCHOOL_ADMIN)
  publish(
    @Body() dto: PublishTimplanStatementDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StagePublicationSummary & { rows: number }> {
    return this.stages.publish(dto, user);
  }

  @Delete('statements')
  @HttpCode(204)
  @Roles(Role.SCHOOL_ADMIN)
  withdraw(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.stages.withdraw(user);
  }

  @Get('card')
  @Roles(Role.STUDENT, Role.GUARDIAN, Role.SCHOOL_ADMIN)
  card(@Query() query: TeachingTimeCardQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<TeachingTimeCardResponse> {
    return this.stages.card(query, user);
  }
}
