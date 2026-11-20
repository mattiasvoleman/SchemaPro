import { Body, Controller, Get, HttpCode, HttpStatus, ParseUUIDPipe, Put, Query, UseGuards } from '@nestjs/common';
import { Area } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { SetEngineReleaseDto } from './dto/engine-release.dto';
import { EngineReleaseService, type EngineReleaseList, type EngineReleaseResult } from './engine-release.service';

/**
 * Släppt för motorn. The school's administrators read it; releasing and taking back is Planering's, as the posts it is about
 * (the table's arms ask the same). A teacher is refused at the guard: "may be moved" is the administration's to know.
 */
@Controller('api/v1/staffing/engine-release')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Area('PLANERING')
export class EngineReleaseController {
  constructor(private readonly releases: EngineReleaseService) {}

  /** `?academicYearId=` — every released post of the year, with when and by whom. */
  @Get()
  list(
    @Query('academicYearId', new ParseUUIDPipe({ version: '4' })) academicYearId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<EngineReleaseList> {
    return this.releases.list(academicYearId, user);
  }

  /** Releases the posts for the engine, or takes the release back: 400 ENGINE_RELEASE_POST_NOT_IN_YEAR and nothing written when one post is not the year's. */
  @Put()
  @HttpCode(HttpStatus.OK)
  set(@Body() dto: SetEngineReleaseDto, @CurrentUser() user: AuthenticatedUser): Promise<EngineReleaseResult> {
    return this.releases.set(dto, user);
  }
}
