import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Put, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Decides } from '../auth/decorators/area.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { UpsertScopeAssessmentDto } from './dto/scope-assessment.dto';
import { ScopeAssessmentsService, type ScopeAssessmentResponse } from './scope-assessments.service';

const uuid = () => new ParseUUIDPipe({ version: '4' });

/**
 * Rektorns bedömning av lärarens omfattning och undantag enligt 11 § (SFS 2026:1487), per lärare och läsår.
 *
 * ADMINISTRATORS ONLY. The assessment is the assessment of an employee: a teacher reads their own through Min tjänst's report
 * (`scope.teachers[].assessment`, which the table's own-row arm lets them read), and no colleague's. Reading is every administrator's
 * and writing is whoever decides (rektor or a full administrator): the class carries @Decides(), the database asks the same.
 *
 * KEYED ON TEACHER AND YEAR, both in the URL, one row per pair, so PUT on the pair is the whole write surface, as with the post.
 */
@Controller('api/v1/scope-assessments')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Decides()
export class ScopeAssessmentsController {
  constructor(private readonly assessments: ScopeAssessmentsService) {}

  @Get()
  list(@Query('academicYearId', uuid()) academicYearId: string, @CurrentUser() user: AuthenticatedUser): Promise<ScopeAssessmentResponse[]> {
    return this.assessments.list(academicYearId, user);
  }

  @Put(':userId')
  upsert(
    @Param('userId', uuid()) userId: string,
    @Query('academicYearId', uuid()) academicYearId: string,
    @Body() dto: UpsertScopeAssessmentDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ScopeAssessmentResponse> {
    return this.assessments.upsert(userId, academicYearId, dto, user);
  }

  @Delete(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('userId', uuid()) userId: string,
    @Query('academicYearId', uuid()) academicYearId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.assessments.remove(userId, academicYearId, user);
  }
}
