import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { Roles } from './decorators/roles.decorator';
import { Role } from './enums/role.enum';
import type { AuthenticatedUser } from './interfaces/authenticated-user.interface';
import { RolesGuard } from './roles.guard';

/*
 * The guard is driven through the real Reflector and the real @Roles
 * decorator, so what is tested is what a controller annotation actually
 * grants — not a stub standing in for the metadata.
 */

class RoomsController {
  list(): void {}

  @Roles(Role.SCHOOL_ADMIN)
  remove(): void {}

  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  book(): void {}

  @Roles()
  unnamed(): void {}
}

@Roles(Role.SYSTEM_ADMIN)
class PlatformController {
  audit(): void {}

  @Roles(Role.SCHOOL_ADMIN)
  schoolView(): void {}
}

const user = (role: Role): AuthenticatedUser =>
  ({ authId: 'auth-1', role, userId: 'user-1', schoolId: 'school-1' }) as AuthenticatedUser;

/** The context Nest builds for an HTTP request routed to `controller[handler]`. */
const routeTo = (
  controller: new () => object,
  handler: string,
  principal?: AuthenticatedUser,
) =>
  new ExecutionContextHost(
    [{ user: principal }, {}, jest.fn()],
    controller as never,
    (controller.prototype as Record<string, () => void>)[handler],
  );

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());

  it('lets any authenticated user through a route that names no roles', () => {
    expect(guard.canActivate(routeTo(RoomsController, 'list', user(Role.STUDENT)))).toBe(
      true,
    );
  });

  it('does not refuse a route with no roles that arrives with no principal', () => {
    // A @Public() route reaches this guard with no request.user; refusing it
    // here would close the health check the JWT guard deliberately opened.
    expect(guard.canActivate(routeTo(RoomsController, 'list'))).toBe(true);
  });

  it('reads an empty @Roles() as no restriction, like no annotation', () => {
    expect(
      guard.canActivate(routeTo(RoomsController, 'unnamed', user(Role.GUARDIAN))),
    ).toBe(true);
  });

  it('lets through a user whose role the route names', () => {
    expect(guard.canActivate(routeTo(RoomsController, 'book', user(Role.TEACHER)))).toBe(
      true,
    );
  });

  it('refuses a role the route does not name with 403', () => {
    expect(() =>
      guard.canActivate(routeTo(RoomsController, 'remove', user(Role.TEACHER))),
    ).toThrow(
      new ForbiddenException('You do not have permission to perform this action.'),
    );
  });

  it('refuses a restricted route that arrives with no principal, as 403 and not a crash', () => {
    expect(() => guard.canActivate(routeTo(RoomsController, 'remove'))).toThrow(
      new ForbiddenException('Access denied.'),
    );
  });

  describe('when both the class and the handler are annotated', () => {
    it('applies the class roles to a handler without its own', () => {
      expect(() =>
        guard.canActivate(routeTo(PlatformController, 'audit', user(Role.SCHOOL_ADMIN))),
      ).toThrow(ForbiddenException);
      expect(
        guard.canActivate(routeTo(PlatformController, 'audit', user(Role.SYSTEM_ADMIN))),
      ).toBe(true);
    });

    it('lets the handler roles replace the class roles rather than add to them', () => {
      expect(
        guard.canActivate(
          routeTo(PlatformController, 'schoolView', user(Role.SCHOOL_ADMIN)),
        ),
      ).toBe(true);
      expect(() =>
        guard.canActivate(
          routeTo(PlatformController, 'schoolView', user(Role.SYSTEM_ADMIN)),
        ),
      ).toThrow(ForbiddenException);
    });
  });
});
