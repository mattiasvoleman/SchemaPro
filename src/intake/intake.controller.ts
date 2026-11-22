import { Controller, Get, UseGuards } from '@nestjs/common';
import { AnyAdministrator } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type { IntakeView } from './intake';
import { IntakeService } from './intake.service';

/**
 * Vad kom in (/admin/intake): what the school's base data holds and what is missing from it, counted against what
 * Generera and the steps after it ask for. The one route here only reads, and it reads the ACTIVE läsår: it takes no year, because a
 * year that is rolled and not yet activated has its classes' pupils still in the old classes (förberäknade klasslistor), which a count
 * of what the school holds now cannot answer for.
 *
 * Every administrator reads, whatever the profile: the läsare and the huvudman's reader included. A teacher, a pupil and
 * a guardian have no route: the class guard stops them before the service. The answer is counts and the names of classes,
 * subjects and årskurser; it holds no person, no percentage of a post and no signature.
 */
@Controller('api/v1/intake')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@AnyAdministrator('Reads only: the route writes nothing.')
export class IntakeController {
  constructor(private readonly intake: IntakeService) {}

  @Get()
  read(@CurrentUser() user: AuthenticatedUser): Promise<IntakeView> {
    return this.intake.read(user);
  }
}
