import { Controller, Get, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { MySchoolsService, type MySchoolView } from './my-schools.service';
import { PER_ADDRESS, PerLoginThrottlerGuard } from './per-login-throttler.guard';

/**
 * The signed-in person's own login, whatever their role. Rate-limited per
 * login (PerLoginThrottlerGuard), and per address with a bucket of its own
 * (PER_ADDRESS): the web asks from its server, for everybody with several
 * schools.
 */
@Controller('api/v1/me')
@Throttle({ default: PER_ADDRESS })
@UseGuards(JwtAuthGuard, RolesGuard, PerLoginThrottlerGuard)
@Roles(Role.SCHOOL_ADMIN, Role.TEACHER, Role.STUDENT, Role.GUARDIAN)
export class MeController {
  constructor(private readonly schools: MySchoolsService) {}

  /**
   * The schools this login has a row in, for the school switcher (Flera
   * skolor per inloggning): the first it got first, with the one this request is
   * about, and why the session may not enter a school when it may not.
   */
  @Get('schools')
  mySchools(@CurrentUser() user: AuthenticatedUser): Promise<MySchoolView[]> {
    return this.schools.list(user);
  }
}
