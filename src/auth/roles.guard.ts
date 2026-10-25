import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  AREA_LABELS,
  PROFILE_LABELS,
  profileDecides,
  profileWrites,
  writersOf,
} from './admin-areas';
import { AREA_KEY, type AreaRequirement } from './decorators/area.decorator';
import { HUVUDMAN_ROUTE_KEY, READS_ONLY_KEY, huvudmanReadsOnly } from './huvudman-reader';
import { ROLES_KEY } from './decorators/roles.decorator';
import { Role } from './enums/role.enum';
import type { AuthenticatedUser } from './interfaces/authenticated-user.interface';

/** The problem `code` of an administrator's write outside their profile's areas. */
export const AREA_NOT_YOURS = 'AREA_NOT_YOURS';
/** The problem `code` of a decision by an administrator who does not decide. */
export const DECISION_NOT_YOURS = 'DECISION_NOT_YOURS';

/** Requests that only read, and so need no area: reading is every administrator's. */
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Enforces `@Roles(...)` RBAC annotations, and for an administrator the
 * route's `@Area`/`@Decides` (Roller i skolan). Must be applied *after*
 * `JwtAuthGuard` (i.e. registered later in the guards chain) so that
 * `request.user` is already populated.
 *
 * If a route carries no `@Roles()` metadata the guard passes, meaning any
 * *authenticated* user may access it — fine-grained access control then falls
 * back to the PostgreSQL RLS policies.
 *
 * The area half answers before anything is written, with a 403 that names
 * what the profile does not change. The database refuses the same write on
 * its own (app.current_user_may in every administrator's write arm), so a
 * route whose annotation is wrong fails there instead of passing.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Huvudman (20261212090000): reading across schools never gives a write.
    // The huvudman's reader at a school, and a member at none, may write
    // only the huvudman's own tables; every other write is refused here,
    // before any route's roles or areas, the routes with no @Roles and the
    // person's-own ones (@AnyAdministrator: devices, feeds, notice choices)
    // included. The database refuses the same writes on its own: the reader
    // writes no area (app.current_user_may) and has no row to own anything.
    {
      const request = context.switchToHttp().getRequest<Request>();
      const user = request.user as AuthenticatedUser | undefined;
      if (
        user &&
        (user.huvudman !== undefined || user.role === Role.HUVUDMAN) &&
        !READS.has((request.method ?? '').toUpperCase()) &&
        !this.reflector.getAllAndOverride<boolean | undefined>(HUVUDMAN_ROUTE_KEY, [context.getHandler(), context.getClass()]) &&
        !this.reflector.getAllAndOverride<string | undefined>(READS_ONLY_KEY, [context.getHandler(), context.getClass()])
      ) {
        throw huvudmanReadsOnly(user.huvudman);
      }
    }

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as AuthenticatedUser | undefined;

    if (!user) {
      throw new ForbiddenException('Access denied.');
    }

    if (!requiredRoles.includes(user.role)) {
      throw new ForbiddenException(
        'You do not have permission to perform this action.',
      );
    }

    if (user.role === Role.SCHOOL_ADMIN && !READS.has((request.method ?? '').toUpperCase())) {
      const requirement = this.reflector.getAllAndOverride<AreaRequirement | undefined>(AREA_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (requirement) {
        assertAdministratorMay(user, requirement);
      }
    }

    return true;
  }
}

/** Throws the 403 for an administrator whose profile does not hold the requirement. */
export function assertAdministratorMay(user: AuthenticatedUser, requirement: AreaRequirement): void {
  if (requirement.kind === 'any') return;
  const profile = user.adminProfile;
  const named = profile ? PROFILE_LABELS[profile] : 'Din roll';
  if (requirement.kind === 'decides') {
    if (!profileDecides(profile)) {
      throw new ForbiddenException({
        message: `${named} fattar inte det här beslutet. Det gör rektor eller en fullständig administratör.`,
        code: DECISION_NOT_YOURS,
      });
    }
    return;
  }
  const missing = requirement.areas.find((area) => !profileWrites(profile, area));
  if (missing) {
    // Named for the reader: what the profile does not change, and who does.
    // A läsare changes nothing, which the sentence says, so it does not read
    // as a gap in one area.
    const area = AREA_LABELS[missing];
    const why = profile === 'LASARE' ? ': profilen läser men ändrar ingenting' : '';
    throw new ForbiddenException({
      message: `${named} ändrar inte ${area.toLowerCase()}${why}. ${area} ändras av ${writersOf(missing)}.`,
      code: AREA_NOT_YOURS,
      area: missing,
    });
  }
}
