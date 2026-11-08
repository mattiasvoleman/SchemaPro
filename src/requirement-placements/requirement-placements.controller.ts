import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query, UseGuards } from '@nestjs/common';
import { Area } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { ReplacePlacementsDto } from './dto/requirement-placements.dto';
import { RequirementPlacementsService } from './requirement-placements.service';

/**
 * Förlagda poster: where the school has put a timplanspost's lessons before
 * Generera. The same prefix as the posts' own routes; the GETs are open to
 * every administrator (RolesGuard asks an area only of a write), the PUT is
 * Planering's.
 */
@Controller('api/v1/teaching-requirements')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Area('PLANERING')
export class RequirementPlacementsController {
  constructor(private readonly placements: RequirementPlacementsService) {}

  /** The year's förläggningar, for the märke on the timplan. Declared before the `:id` routes. */
  @Get('placements')
  listOfYear(
    @Query('academicYearId', new ParseUUIDPipe({ version: '4' })) academicYearId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.placements.listOfYear(academicYearId, user);
  }

  /** One post's förläggningar with a verdict for each, judged now. */
  @Get(':id/placements')
  listOfPost(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.placements.listOfPost(id, user);
  }

  /** Replaces the post's förläggningar; 409 and nothing written when they do not fit or the week does not hold one. */
  @Put(':id/placements')
  replace(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ReplacePlacementsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.placements.replace(id, dto, user);
  }
}
