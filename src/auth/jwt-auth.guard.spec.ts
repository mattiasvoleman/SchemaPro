import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import passport from 'passport';
import { Strategy } from 'passport-strategy';
import { Public } from './decorators/public.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';

/*
 * The guard decides two things: whether a route asks for a token at all, and
 * which Passport strategy answers when it does. Verifying the token is
 * JwtStrategy's job and has its own spec, so a stub stands in for it here,
 * registered under the name JwtStrategy registers as.
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
    expect(request.user).toEqual({ userId: 'user-1', role: 'TEACHER' });
  });
});
