import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import type { AdminProfile } from '@prisma/client';
import { AnyAdministrator, Area, Decides } from './decorators/area.decorator';
import { Roles } from './decorators/roles.decorator';
import { Role } from './enums/role.enum';
import type { AuthenticatedUser } from './interfaces/authenticated-user.interface';
import { AREA_NOT_YOURS, DECISION_NOT_YOURS, RolesGuard } from './roles.guard';

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
  method = 'POST',
) =>
  new ExecutionContextHost(
    [{ user: principal, method }, {}, jest.fn()],
    controller as never,
    (controller.prototype as Record<string, () => void>)[handler],
  );

@Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
@Area('PERSONAL')
class PeopleController {
  edit(): void {}

  @Area('PUBLICERING', 'DRIFT')
  publish(): void {}

  @Decides()
  changeRole(): void {}

  @AnyAdministrator("the caller's own notices")
  ownNotices(): void {}
}

const admin = (adminProfile?: AdminProfile, hrRead = false): AuthenticatedUser =>
  ({ ...user(Role.SCHOOL_ADMIN), ...(adminProfile ? { adminProfile, hrRead } : {}) }) as AuthenticatedUser;

const refusal = (fn: () => unknown): Record<string, unknown> => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ForbiddenException);
    return (error as ForbiddenException).getResponse() as Record<string, unknown>;
  }
  throw new Error('expected a 403');
};

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

  describe("an administrator's areas (Roller i skolan)", () => {
    it('lets every profile read a route whose area it does not write', () => {
      for (const profile of ['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION'] as const) {
        for (const method of ['GET', 'HEAD', 'OPTIONS']) {
          expect(guard.canActivate(routeTo(PeopleController, 'edit', admin(profile), method))).toBe(true);
        }
      }
    });

    it("holds a write to the class's area: the roster is expedition's and not the planner's", () => {
      expect(guard.canActivate(routeTo(PeopleController, 'edit', admin('EXPEDITION')))).toBe(true);
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const body = refusal(() => guard.canActivate(routeTo(PeopleController, 'edit', admin('SCHEMALAGGARE'), method)));
        expect(body).toMatchObject({ code: AREA_NOT_YOURS, area: 'PERSONAL' });
        expect(body.message).toBe('Schemaläggare ändrar inte personal. Be rektor eller en administratör som har det området.');
      }
    });

    it("lets a handler's areas replace the class's, and asks for every one of them", () => {
      expect(guard.canActivate(routeTo(PeopleController, 'publish', admin('SCHEMALAGGARE')))).toBe(true);
      expect(guard.canActivate(routeTo(PeopleController, 'publish', admin('REKTOR')))).toBe(true);
      // Expedition writes drift but not publicering: the first area missing is named.
      expect(refusal(() => guard.canActivate(routeTo(PeopleController, 'publish', admin('EXPEDITION'))))).toMatchObject({
        code: AREA_NOT_YOURS,
        area: 'PUBLICERING',
      });
    });

    it('leaves a decision to rektor and a full administrator, HR-läs or not', () => {
      expect(guard.canActivate(routeTo(PeopleController, 'changeRole', admin('FULL')))).toBe(true);
      expect(guard.canActivate(routeTo(PeopleController, 'changeRole', admin('REKTOR')))).toBe(true);
      for (const profile of ['SCHEMALAGGARE', 'EXPEDITION'] as const) {
        expect(
          refusal(() => guard.canActivate(routeTo(PeopleController, 'changeRole', admin(profile, true)))),
        ).toMatchObject({ code: DECISION_NOT_YOURS });
      }
    });

    it('lets every administrator through a route that writes nothing of an area', () => {
      expect(guard.canActivate(routeTo(PeopleController, 'ownNotices', admin('EXPEDITION')))).toBe(true);
    });

    it("asks nothing of a teacher's area: the profile is an administrator's", () => {
      expect(guard.canActivate(routeTo(PeopleController, 'edit', user(Role.TEACHER)))).toBe(true);
      expect(guard.canActivate(routeTo(PeopleController, 'changeRole', user(Role.TEACHER)))).toBe(true);
    });

    it('refuses an administrator who arrives without a profile, rather than reading none as full', () => {
      expect(refusal(() => guard.canActivate(routeTo(PeopleController, 'edit', admin())))).toMatchObject({
        code: AREA_NOT_YOURS,
      });
      expect(refusal(() => guard.canActivate(routeTo(PeopleController, 'changeRole', admin())))).toMatchObject({
        code: DECISION_NOT_YOURS,
      });
    });
  });
});
