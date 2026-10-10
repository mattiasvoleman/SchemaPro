import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../database/prisma.service';
import type { IntegrationRequest } from './integration-key.guard';
import { resolveIntegrationKey } from './integration-key';
import type { Scope } from './ss12000-v2/scopes';

export const REQUIRED_SCOPE_KEY = 'integration:requiredScope';

/** The scope a /ss12000/v1 route needs (handler over class). */
export const RequireScope = (scope: Scope) => SetMetadata(REQUIRED_SCOPE_KEY, scope);

/**
 * /ss12000/v1's scope check, after IntegrationKeyGuard (migration
 * 20261014120000).
 *
 * IntegrationKeyGuard is unchanged — the same lookup, the same 401s and
 * their messages. This guard runs after it and refuses a key that lacks the
 * route's scope with a 403 in the house's RFC 7807 body. Every key that
 * existed before the migration holds ss12000.v1 and ss12000.v1.import (the
 * column's default was the backfill), so no existing key can meet this 403;
 * a new key may be read-only (no import) or v2-only (no v1 at all).
 *
 * It costs v1 one more indexed lookup per request, through the same narrow
 * key-lookup principal; v2.0's guard reads the key and its scopes in one.
 */
@Injectable()
export class IntegrationScopeGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const scope = this.reflector.getAllAndOverride<Scope | undefined>(REQUIRED_SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!scope) return true;
    const request = context.switchToHttp().getRequest<IntegrationRequest>();
    const key = request.headers['x-api-key'];
    if (typeof key !== 'string' || !key.startsWith('sp_')) {
      throw new UnauthorizedException('Missing or malformed X-API-Key.');
    }
    const resolved = await resolveIntegrationKey(this.prisma, key, { touch: false });
    if (!resolved || resolved.schoolId !== request.integrationSchoolId) {
      throw new UnauthorizedException('Invalid API key.');
    }
    if (!resolved.scopes.includes(scope)) {
      throw new ForbiddenException(`This API key lacks the scope ${scope}.`);
    }
    return true;
  }
}
