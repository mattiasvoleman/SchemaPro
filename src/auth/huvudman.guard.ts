import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { Role } from './enums/role.enum';
import type { AuthenticatedUser } from './interfaces/authenticated-user.interface';

export const HUVUDMAN_NO_SCHOOL = 'HUVUDMAN_NO_SCHOOL';

/**
 * The only routes a huvudman's member reaches with no school named (Role.HUVUDMAN,
 * 20261212090000): the huvudman's own pages and the person's own /me. Kept
 * as paths, beside the routes' @Roles, so that the answer does not hang on
 * any one route remembering its roles, nor on row security: some reads take
 * no school's claims at all (a service principal, the public viewer).
 */
export const HUVUDMAN_ROUTES: readonly RegExp[] = [/^\/api\/v1\/huvudman(\/|$)/, /^\/api\/v1\/me(\/|$)/];

/** The route the request matched, as its controller declares it, or the path asked. */
function routeOf(request: Request): string {
  const declared = (request.route as { path?: unknown } | undefined)?.path;
  return `${request.baseUrl ?? ''}${typeof declared === 'string' ? declared : request.path}`;
}

/**
 * Refuses the HUVUDMAN principal every route but HUVUDMAN_ROUTES, whatever
 * the method, before RolesGuard and before any handler: denied unless
 * allowed. The huvudman's reader at a school (role SCHOOL_ADMIN, with
 * `huvudman`) is no HUVUDMAN principal; RolesGuard and the database hold
 * that one to reading.
 */
@Injectable()
export class HuvudmanGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as AuthenticatedUser | undefined;
    if (!user || user.role !== Role.HUVUDMAN) return true;
    const route = routeOf(request);
    if (HUVUDMAN_ROUTES.some((allowed) => allowed.test(route))) return true;
    throw new ForbiddenException({
      message: 'Välj en skola först. Utan skola når en huvudmans person bara huvudmannens egna sidor.',
      code: HUVUDMAN_NO_SCHOOL,
    });
  }
}
