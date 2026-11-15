import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import type { AdminProfile } from '@prisma/client';
import { AnyAdministrator, Area, AsTeacher, Decides } from './decorators/area.decorator';
import { Roles } from './decorators/roles.decorator';
import { Role } from './enums/role.enum';
import type { AuthenticatedUser } from './interfaces/authenticated-user.interface';
import { AREA_NOT_YOURS, DECISION_NOT_YOURS, RolesGuard } from './roles.guard';
import { HUVUDMAN_READS_ONLY, HuvudmanRoute, ReadsOnly } from './huvudman-reader';

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
      for (const profile of ['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION', 'LASARE'] as const) {
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
        expect(body.message).toBe(
          'Schemaläggare ändrar inte personal. Personal ändras av rektor, en fullständig administratör eller expeditionen.',
        );
      }
    });

    it('refuses a läsare every write by name, saying it changes nothing and who does (Läsbehörighet)', () => {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        expect(refusal(() => guard.canActivate(routeTo(PeopleController, 'edit', admin('LASARE', true), method)))).toEqual({
          message:
            'Läsare ändrar inte personal: profilen läser men ändrar ingenting. Personal ändras av rektor, en fullständig administratör eller expeditionen.',
          code: AREA_NOT_YOURS,
          area: 'PERSONAL',
        });
      }
      expect(refusal(() => guard.canActivate(routeTo(PeopleController, 'publish', admin('LASARE'))))).toMatchObject({
        code: AREA_NOT_YOURS,
      });
      expect(refusal(() => guard.canActivate(routeTo(PeopleController, 'changeRole', admin('LASARE', true))))).toMatchObject({
        code: DECISION_NOT_YOURS,
        message: 'Läsare fattar inte det här beslutet. Det gör rektor eller en fullständig administratör.',
      });
      // Its own notice choices are its own, as for every administrator.
      expect(guard.canActivate(routeTo(PeopleController, 'ownNotices', admin('LASARE')))).toBe(true);
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
      for (const profile of ['SCHEMALAGGARE', 'EXPEDITION', 'LASARE'] as const) {
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

// Huvudman (20261212090000): reading across schools never gives a write.
describe('RolesGuard and the huvudman\'s reader', () => {
  const guard = new RolesGuard(new Reflector());
  const reader: AuthenticatedUser = {
    authId: 'auth-h',
    role: Role.SCHOOL_ADMIN,
    schoolId: 'school-1',
    adminProfile: 'LASARE',
    hrRead: false,
    huvudman: { id: 'h-1', name: 'Vimmerby kommun', memberId: 'm-1', role: 'PLANERARE', firstName: 'Pia', lastName: 'P' },
  };
  const member: AuthenticatedUser = { authId: 'auth-h', role: Role.HUVUDMAN };

  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  @AnyAdministrator("the caller's own devices")
  class DevicesController {
    register(): void {}
  }

  class OpenController {
    anything(): void {}
  }

  @Roles(Role.HUVUDMAN, Role.SCHOOL_ADMIN)
  @HuvudmanRoute()
  @AnyAdministrator("the huvudman's own tables")
  class HuvudmanController {
    invite(): void {}
  }

  @Roles(Role.SCHOOL_ADMIN)
  @AnyAdministrator('a preview')
  class YearsController {
    @ReadsOnly('a preview that writes nothing')
    preview(): void {}
  }

  const readsOnly = (thrown: unknown) =>
    thrown instanceof ForbiddenException && (thrown.getResponse() as { code?: string }).code === HUVUDMAN_READS_ONLY;

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('refuses the reader every %s outside the huvudman\'s own routes', (method) => {
    for (const [controller, handler] of [
      [PeopleController, 'edit'],
      [DevicesController, 'register'],
      [OpenController, 'anything'],
    ] as const) {
      let thrown: unknown;
      try {
        guard.canActivate(routeTo(controller as never, handler, reader, method));
      } catch (error) {
        thrown = error;
      }
      expect(readsOnly(thrown)).toBe(true);
    }
  });

  it('names the huvudman the reader reads for', () => {
    expect(() => guard.canActivate(routeTo(DevicesController, 'register', reader))).toThrow(/Vimmerby kommun/);
  });

  it('lets the reader read, as the läsare reads', () => {
    expect(guard.canActivate(routeTo(PeopleController, 'edit', reader, 'GET'))).toBe(true);
  });

  it("lets the reader and a member at no school write the huvudman's own tables", () => {
    expect(guard.canActivate(routeTo(HuvudmanController, 'invite', reader))).toBe(true);
    expect(guard.canActivate(routeTo(HuvudmanController, 'invite', member))).toBe(true);
  });

  it('lets the reader make a POST that only reads', () => {
    expect(guard.canActivate(routeTo(YearsController, 'preview', reader))).toBe(true);
  });

  it('refuses a member at no school every other write, the open routes included', () => {
    let thrown: unknown;
    try {
      guard.canActivate(routeTo(OpenController, 'anything', member));
    } catch (error) {
      thrown = error;
    }
    expect(readsOnly(thrown)).toBe(true);
  });

  it('leaves everybody else as they were', () => {
    const full = { ...user(Role.SCHOOL_ADMIN), adminProfile: 'FULL' as AdminProfile };
    expect(guard.canActivate(routeTo(DevicesController, 'register', full))).toBe(true);
    expect(guard.canActivate(routeTo(OpenController, 'anything', user(Role.TEACHER)))).toBe(true);
  });
});

// Administratör som lärare: Users.teaches is a door into the teacher's own
// routes, one by one, never a role the guard counts.
describe('RolesGuard and an administrator who teaches', () => {
  const guard = new RolesGuard(new Reflector());

  @Roles(Role.TEACHER)
  @Area('DRIFT')
  class OwnController {
    /** The teacher's own, and says so. */
    @AsTeacher("the teacher's own note")
    putNote(): void {}

    /** Lists TEACHER and no more: the colleague side, which stays the teachers'. */
    colleague(): void {}

    @Roles(Role.TEACHER, Role.STUDENT)
    @AsTeacher("the teacher's own week")
    week(): void {}

    @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
    @Area('PLANERING')
    @AsTeacher('the route lists both, so the area is asked as it was')
    both(): void {}

    /** Marked, but for administrators alone: there is no teacher's route to come in by. */
    @Roles(Role.SCHOOL_ADMIN)
    @Area('PERSONAL')
    @AsTeacher('marked in error')
    adminsOnly(): void {}
  }

  const teaching = (adminProfile: AdminProfile = 'SCHEMALAGGARE', extra: Partial<AuthenticatedUser> = {}): AuthenticatedUser =>
    ({ ...admin(adminProfile), teaches: true, ...extra }) as AuthenticatedUser;

  it('lets an administrator with the mark through a route that lists TEACHER and says @AsTeacher', () => {
    expect(guard.canActivate(routeTo(OwnController, 'putNote', teaching(), 'PUT'))).toBe(true);
    expect(guard.canActivate(routeTo(OwnController, 'week', teaching(), 'GET'))).toBe(true);
  });

  it('asks no area of the person it lets in as the teacher: a profile without DRIFT is no reason to refuse a note on their own lesson', () => {
    // No profile writes no area at all; the route's class says @Area('DRIFT') and is not asked.
    for (const profile of ['REKTOR', 'FULL', 'SCHEMALAGGARE', 'EXPEDITION'] as const) {
      expect(guard.canActivate(routeTo(OwnController, 'putNote', teaching(profile), 'PUT'))).toBe(true);
    }
  });

  it('refuses the same administrator at a TEACHER route that does not say @AsTeacher (fail closed: the colleague side, krisläge, mentor stay the teachers\')', () => {
    expect(() => guard.canActivate(routeTo(OwnController, 'colleague', teaching(), 'POST'))).toThrow(
      new ForbiddenException('You do not have permission to perform this action.'),
    );
  });

  it('refuses an administrator without the mark, or with it false, at the door as before', () => {
    expect(() => guard.canActivate(routeTo(OwnController, 'putNote', admin('FULL'), 'PUT'))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(routeTo(OwnController, 'putNote', teaching('FULL', { teaches: false }), 'PUT'))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(routeTo(OwnController, 'week', admin('SCHEMALAGGARE'), 'GET'))).toThrow(ForbiddenException);
  });

  it('never opens a route to the mark on anything but a SCHOOL_ADMIN with a row: not a pupil, a guardian, the huvudman, the reader, a läsare', () => {
    const marked = (overrides: Partial<AuthenticatedUser>): AuthenticatedUser => ({ ...user(Role.STUDENT), teaches: true, ...overrides }) as AuthenticatedUser;
    for (const person of [
      marked({ role: Role.STUDENT }),
      marked({ role: Role.GUARDIAN }),
      marked({ role: Role.HUVUDMAN }),
      marked({ role: Role.SYSTEM_ADMIN }),
      // A läsare cannot carry the mark (CHECK); a principal that says so is refused all the same.
      teaching('LASARE'),
      marked({
        role: Role.SCHOOL_ADMIN,
        adminProfile: 'LASARE',
        huvudman: { id: 'h-1', name: 'Vimmerby kommun', memberId: 'm-1', role: 'PLANERARE', firstName: 'Pia', lastName: 'P' },
      }),
    ]) {
      expect(() => guard.canActivate(routeTo(OwnController, 'putNote', person, 'GET'))).toThrow(ForbiddenException);
    }
  });

  it('leaves a route that lists SCHOOL_ADMIN itself exactly as it was: the profile’s area is still asked', () => {
    // Come in as the administrator, so the area is the administrator's: a planner does not write PERSONAL.
    expect(refusal(() => guard.canActivate(routeTo(OwnController, 'adminsOnly', teaching('SCHEMALAGGARE'), 'PUT')))).toMatchObject({ code: AREA_NOT_YOURS });
    expect(refusal(() => guard.canActivate(routeTo(OwnController, 'both', teaching('EXPEDITION'), 'PUT')))).toMatchObject({ code: AREA_NOT_YOURS });
    expect(guard.canActivate(routeTo(OwnController, 'both', teaching('SCHEMALAGGARE'), 'PUT'))).toBe(true);
  });

  it('does not lift the huvudman’s reads-only refusal: the reader writes nothing, mark or not', () => {
    const reader = {
      authId: 'auth-h',
      role: Role.SCHOOL_ADMIN,
      adminProfile: 'LASARE',
      teaches: true,
      huvudman: { id: 'h-1', name: 'Vimmerby kommun', memberId: 'm-1', role: 'PLANERARE', firstName: 'Pia', lastName: 'P' },
    } as AuthenticatedUser;
    expect(() => guard.canActivate(routeTo(OwnController, 'putNote', reader, 'PUT'))).toThrow(/huvudman|Huvudman|läs/);
  });
});
