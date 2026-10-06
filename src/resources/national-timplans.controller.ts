import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  NationalTimplansService,
  type NationalTimplansResponse,
} from './national-timplans.service';

/**
 * Den nationella timplanen — skolförordningens bilagor as data.
 *
 * EVERY TENANT ROLE IS IN @Roles, which no other controller in this folder
 * does. The statute is public information: a pupil or a guardian asking how
 * many hours of matematik åk 4–6 are guaranteed is asking the law, not the
 * school, and the tables' own SELECT policy already answers any active
 * signed-in user. Listing the four roles rather than dropping the decorator
 * keeps route-guards.e2e-spec's invariant intact — a route with no @Roles and
 * no @Public reads as a mistake there, and it should.
 *
 * SYSTEM_ADMIN is left out on purpose. The role has no Users row, so under RLS
 * it reads nothing from these tables, and a 200 with six empty arrays would be
 * a lie about the deploy; the guard's 403 is the honest answer.
 *
 * READ-ONLY. Writes happen as the migration owner and nowhere else: the API
 * role holds no INSERT/UPDATE/DELETE on the three tables (rls-policies.sql
 * section 15 proves it), so there is nothing a POST here could do.
 *
 * CACHEABLE. The figures change when a migration seeds a new lydelse, which is
 * a deploy — so a client may hold them for an hour, and the ETag Express
 * computes from the body (the default `etag` setting is on) turns every later
 * GET into a 304 while nothing changed. `private`, because the response sits
 * behind a bearer token and a shared cache must not serve one user's answer
 * to another, even though the answer is the same for all of them.
 */
@Controller('api/v1/national-timplans')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN, Role.TEACHER, Role.STUDENT, Role.GUARDIAN)
export class NationalTimplansController {
  constructor(private readonly timplans: NationalTimplansService) {}

  @Get()
  @Header('Cache-Control', 'private, max-age=3600')
  get(@CurrentUser() user: AuthenticatedUser): Promise<NationalTimplansResponse> {
    return this.timplans.get(user);
  }
}
