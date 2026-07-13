import { createHash } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../database/prisma.service';

export interface IntegrationRequest extends Request {
  integrationSchoolId?: string;
}

/**
 * Authenticates external systems on the SS12000-style API via `X-API-Key`.
 * Keys are stored as SHA-256 hashes; a match scopes the request to exactly
 * one school (`req.integrationSchoolId`), which every query filters by.
 */
@Injectable()
export class IntegrationKeyGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<IntegrationRequest>();
    const key = request.headers['x-api-key'];
    if (typeof key !== 'string' || !key.startsWith('sp_')) {
      throw new UnauthorizedException('Missing or malformed X-API-Key.');
    }

    const keyHash = createHash('sha256').update(key).digest('hex');
    const row = await this.prisma.withSystemTransaction((tx) =>
      tx.integrationApiKey.findFirst({
        where: { keyHash, revokedAt: null },
        select: { id: true, schoolId: true },
      }),
    );
    if (!row) {
      throw new UnauthorizedException('Invalid API key.');
    }

    request.integrationSchoolId = row.schoolId;
    // Best-effort usage timestamp; never blocks the request.
    void this.prisma
      .withSystemTransaction((tx) =>
        tx.integrationApiKey.update({
          where: { id: row.id },
          data: { lastUsedAt: new Date() },
        }),
      )
      .catch(() => undefined);
    return true;
  }
}
