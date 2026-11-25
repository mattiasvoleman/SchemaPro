import { Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Area } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { RolesGuard } from '../auth/roles.guard';
import { SuggestionsService } from './suggestions.service';
import type { SuggestionsView } from './suggestions';

/**
 * Åtgärdsförslag vid vägran: the analysis of a run that ended without a timetable. Its own controller, under the optimization prefix,
 * so that the routes of a run (OptimizationController) are not touched by it.
 *
 * Guarded exactly as the routes it sits beside are: school administrators who write Schemaläggning AND Drift (@Area asks every area it
 * names, RolesGuard assertAdministratorMay), so a profile with one of them gets the 403 that names the other. The analysis reads the school as
 * a Generera does, so it needs what a Generera needs, and it writes nothing but the run's own column.
 */
@Controller('api/v1/optimization')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Area('SCHEMALAGGNING', 'DRIFT')
export class SuggestionsController {
  constructor(private readonly suggestions: SuggestionsService) {}

  /**
   * Asks for the analysis of a run, and answers at once with it RUNNING (202): the page polls the run (GET jobs/:id), which carries the
   * list when it is there. A second press while one runs is the same answer. A run it may not be asked for, an older run than the year's
   * newest, and a year with a run going are 409 with a code the page words.
   *
   * Throttled as the routes that wake the solver are (three a minute): it is a minute and a half of the engine's cores.
   */
  @Post('jobs/:id/suggestions')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  start(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser): Promise<SuggestionsView> {
    return this.suggestions.start(id, user);
  }
}
