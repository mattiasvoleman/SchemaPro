import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';

/**
 * Set on a request once this guard has authenticated it.
 *
 * A symbol rather than a check on `request.user`: nothing an HTTP client sends
 * can produce a symbol-keyed property, so the only way to skip verification is
 * to have passed it earlier in the same request.
 */
const AUTHENTICATED = Symbol('JwtAuthGuard.authenticated');

type MarkableRequest = { [AUTHENTICATED]?: true };

/**
 * Global authentication guard. Verifies the bearer JWT for every route except
 * those explicitly annotated with `@Public()`.
 *
 * ## Why it remembers a request it has already authenticated
 *
 * It runs twice on most routes. AppModule registers it as an `APP_GUARD`, and
 * 25 controllers name it again in `@UseGuards(JwtAuthGuard, RolesGuard)`. Nest
 * does not deduplicate a global guard against a controller one, and
 * `AuthGuard.canActivate` always calls into passport, so `JwtStrategy.validate`
 * ran twice per request — two interactive transactions (BEGIN, set_config, the
 * Users lookup, COMMIT) that returned the same row, before the handler opened
 * its own `withRls`. Three transactions on the pool per request, where one
 * lookup decides everything the second one repeats.
 *
 * The second pass is skipped rather than the decorators removed: a controller
 * that keeps `@UseGuards(JwtAuthGuard)` still authenticates when read on its
 * own, and a future duplicate costs nothing.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = this.getRequest(context) as MarkableRequest;
    if (request[AUTHENTICATED]) {
      return true;
    }

    // Throws on a missing, invalid or unlinked token, so the mark is only
    // ever set after passport has attached a verified principal.
    const allowed = (await super.canActivate(context)) as boolean;
    if (allowed) {
      request[AUTHENTICATED] = true;
    }
    return allowed;
  }
}
