import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import passport from 'passport';
import { Strategy } from 'passport-strategy';
import { Public } from './decorators/public.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';

/*
 * The guard decides three things: whether a route asks for a token at all,
 * which Passport strategy answers when it does, and whether this request has
 * already been answered by an earlier pass. Verifying the token is
 * JwtStrategy's job and has its own spec, so a stub stands in for it here,
 * registered under the name JwtStrategy registers as. Each entry in `asked` is
 * one run of JwtStrategy.validate — in production, one identity transaction.
 */
class BearerStub extends Strategy {
  readonly name = 'jwt';
  /**
   * Passport runs a registered strategy through Object.create, so a counter
   * assigned on `this` would land on a throwaway copy. A shared array does not.
   */
  readonly asked: unknown[] = [];

  authenticate(req: { headers: Record<string, string | undefined> }): void {
    this.asked.push(req);
    const self = this as unknown as {
      success(user: object): void;
      fail(status: number): void;
    };
    if (req.headers['authorization'] === 'Bearer verified') {
      self.success({ userId: 'user-1', role: 'TEACHER' });
    } else {
      self.fail(401);
    }
  }
}

class LessonsController {
  list(): void {}

  @Public()
  health(): void {}
}

@Public()
class StatusController {
  version(): void {}
}

type FakeRequest = { headers: Record<string, string | undefined>; user?: unknown };

const routeTo = (
  controller: new () => object,
  handler: string,
  request: FakeRequest,
) =>
  new ExecutionContextHost(
    [request, {}, jest.fn()],
    controller as never,
    (controller.prototype as Record<string, () => void>)[handler],
  );

describe('JwtAuthGuard', () => {
  let strategy: BearerStub;
  const guard = new JwtAuthGuard(new Reflector());

  beforeEach(() => {
    strategy = new BearerStub();
    passport.use(strategy);
  });

  afterEach(() => {
    passport.unuse('jwt');
  });

  // Wrapped in Promise.resolve so the assertion is about the decision, not about
  // whether the guard answers synchronously or with a promise.

  it('lets a @Public() handler through without asking for a token', async () => {
    const request: FakeRequest = { headers: {} };

    await expect(
      Promise.resolve(guard.canActivate(routeTo(LessonsController, 'health', request))),
    ).resolves.toBe(true);
    expect(strategy.asked).toHaveLength(0);
  });

  it('lets every handler of a @Public() controller through', async () => {
    await expect(
      Promise.resolve(
        guard.canActivate(routeTo(StatusController, 'version', { headers: {} })),
      ),
    ).resolves.toBe(true);
    expect(strategy.asked).toHaveLength(0);
  });

  it('sends any other route to the jwt strategy and answers 401 when it fails', async () => {
    const request: FakeRequest = { headers: { authorization: 'Bearer forged' } };

    await expect(
      Promise.resolve(guard.canActivate(routeTo(LessonsController, 'list', request))),
    ).rejects.toThrow(UnauthorizedException);
    expect(strategy.asked).toHaveLength(1);
    expect(request.user).toBeUndefined();
  });

  it('attaches the principal the strategy verified to the request', async () => {
    const request: FakeRequest = { headers: { authorization: 'Bearer verified' } };

    await expect(
      Promise.resolve(guard.canActivate(routeTo(LessonsController, 'list', request))),
    ).resolves.toBe(true);
    expect(strategy.asked).toHaveLength(1);
    expect(request.user).toEqual({ userId: 'user-1', role: 'TEACHER' });
  });

  describe('remembering a request it has verified', () => {
    it('does not verify the same request a second time', async () => {
      // AppModule's APP_GUARD and a controller's @UseGuards(JwtAuthGuard) are
      // two instances over one request; both must count as one identity lookup.
      const request: FakeRequest = { headers: { authorization: 'Bearer verified' } };
      const globalGuard = new JwtAuthGuard(new Reflector());
      const controllerGuard = new JwtAuthGuard(new Reflector());

      await globalGuard.canActivate(routeTo(LessonsController, 'list', request));
      await expect(
        controllerGuard.canActivate(routeTo(LessonsController, 'list', request)),
      ).resolves.toBe(true);

      expect(strategy.asked).toHaveLength(1);
    });

    it('verifies every new request, whichever guard instance sees it', async () => {
      const bearer = () => ({ headers: { authorization: 'Bearer verified' } });

      await guard.canActivate(routeTo(LessonsController, 'list', bearer()));
      await guard.canActivate(routeTo(LessonsController, 'list', bearer()));

      expect(strategy.asked).toHaveLength(2);
    });

    it('is not skipped by a user a client could have put on the request', async () => {
      // The mark is a symbol only this guard sets. A `user` that is already
      // present — from anything other than a verified pass — earns no shortcut.
      const request: FakeRequest = {
        headers: { authorization: 'Bearer forged' },
        user: { userId: 'forged' },
      };

      await expect(
        guard.canActivate(routeTo(LessonsController, 'list', request)),
      ).rejects.toThrow(UnauthorizedException);
      expect(strategy.asked).toHaveLength(1);
    });

    it('verifies again after a rejected pass instead of remembering it', async () => {
      const request: FakeRequest = { headers: { authorization: 'Bearer forged' } };
      const globalGuard = new JwtAuthGuard(new Reflector());
      const controllerGuard = new JwtAuthGuard(new Reflector());

      await expect(
        globalGuard.canActivate(routeTo(LessonsController, 'list', request)),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        controllerGuard.canActivate(routeTo(LessonsController, 'list', request)),
      ).rejects.toThrow(UnauthorizedException);

      expect(strategy.asked).toHaveLength(2);
    });
  });
});
