import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Optional,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { RolesGuard } from '../auth/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { IntegrationKeyGuard, type IntegrationRequest } from './integration-key.guard';
import { IntegrationScopeGuard, RequireScope } from './integration-scope.guard';
import { Ss12000Service } from './ss12000.service';
import { parseScopes } from './ss12000-v2/scopes';
import { newWebhookSecret, webhookSecretAad } from './ss12000-v2/signing';
import { Ss12000Secrets } from './ss12000-sync/ss12000-sync.providers';
import { sqlStateOf } from './ss12000-sync/errors';

/**
 * Admin management of integration API keys. The plaintext key is returned
 * exactly once on create; only the SHA-256 hash is stored.
 */
@Controller('api/v1/integration-keys')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class IntegrationKeysController {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly secrets?: Ss12000Secrets,
  ) {}

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser) {
    return this.prisma.withRls(user, (tx) =>
      tx.integrationApiKey.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          lastUsedAt: true,
          revokedAt: true,
          createdAt: true,
        },
      }),
    );
  }

  /**
   * `scopes` is optional: without it the key gets the column's default,
   * ss12000.v1 and ss12000.v1.import — what every key could reach before
   * scopes existed (20261014120000). With it, exactly those (scopes.ts).
   */
  @Post()
  async create(
    @Body() body: { name?: string; scopes?: unknown },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const schoolId = requireSchoolId(user);
    const name = (body.name ?? '').trim() || 'Integration';
    const scopes = body.scopes === undefined ? undefined : parseScopes(body.scopes);
    if (scopes === null) {
      throw new BadRequestException({ message: 'scopes must be a non-empty list of known scopes.', code: 'INTEGRATION_KEY_SCOPES_INVALID' });
    }
    const key = `sp_${randomBytes(24).toString('hex')}`;
    const keyHash = createHash('sha256').update(key).digest('hex');
    const created = await this.prisma.withRls(user, (tx) =>
      tx.integrationApiKey.create({
        data: {
          schoolId,
          name: name.slice(0, 120),
          keyHash,
          createdById: user.userId ?? null,
          ...(scopes ? { scopes } : {}),
        },
        select: { id: true, name: true, createdAt: true },
      }),
    );
    // Plaintext key: shown once, never retrievable again.
    return { ...created, key };
  }

  /**
   * The keys as the provider sees them: scopes, whether a webhook signing
   * secret exists (and until when the previous one still signs), and each
   * key's subscriptions with their delivery state. Never a key, a hash or a
   * secret. A route of its own so GET / answers exactly what it always did.
   */
  @Get('provider')
  async provider(@CurrentUser() user: AuthenticatedUser) {
    return this.prisma.withRls(user, async (tx) => {
      const keys = await tx.integrationApiKey.findMany({
        orderBy: { createdAt: 'desc' },
        select: { id: true, name: true, scopes: true, lastUsedAt: true, revokedAt: true, createdAt: true },
      });
      const presence = await tx.$queryRaw<{ key_id: string; set_at: Date; previous_valid_until: Date | null }[]>(
        Prisma.sql`SELECT key_id, set_at, previous_valid_until FROM app.integration_key_webhook_secret_presence()`,
      );
      const subscriptions = await tx.ss12000Subscription.findMany({
        where: { endedAt: null },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          keyId: true,
          name: true,
          target: true,
          resourceTypes: true,
          expiresAt: true,
          suspendedAt: true,
          suspendedReason: true,
          lastNotifiedAt: true,
          failingSince: true,
          attempts: true,
          createdAt: true,
        },
      });
      return keys.map((key) => {
        const secret = presence.find((row) => row.key_id === key.id);
        return {
          id: key.id,
          name: key.name,
          scopes: key.scopes,
          lastUsedAt: key.lastUsedAt,
          revokedAt: key.revokedAt,
          createdAt: key.createdAt,
          webhookSecret: secret ? { setAt: secret.set_at, previousValidUntil: secret.previous_valid_until } : null,
          subscriptions: subscriptions
            .filter((row) => row.keyId === key.id)
            .map((row) => ({
              id: row.id,
              name: row.name,
              targetHost: hostOf(row.target),
              resourceTypes: row.resourceTypes,
              expiresAt: row.expiresAt,
              suspendedAt: row.suspendedAt,
              suspendedReason: row.suspendedReason,
              lastNotifiedAt: row.lastNotifiedAt,
              failingSince: row.failingSince,
              attempts: row.attempts,
              createdAt: row.createdAt,
            })),
        };
      });
    });
  }

  /** PATCH {scopes}: what the key may reach from now on. */
  @Patch(':id')
  async updateScopes(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() body: { scopes?: unknown },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const scopes = parseScopes(body.scopes);
    if (!scopes) {
      throw new BadRequestException({ message: 'scopes must be a non-empty list of known scopes.', code: 'INTEGRATION_KEY_SCOPES_INVALID' });
    }
    const updated = await this.prisma.withRls(user, (tx) =>
      tx.integrationApiKey.updateMany({ where: { id, revokedAt: null }, data: { scopes } }),
    );
    if (updated.count !== 1) throw new NotFoundException({ message: 'No such live key.', code: 'INTEGRATION_KEY_NOT_FOUND' });
    return { id, scopes };
  }

  /**
   * A new webhook signing secret for the key: returned ONCE, stored sealed
   * (AES-256-GCM, bound to the school and the key), and the previous one
   * keeps signing for 24 hours. 503 without INTEGRATION_SECRETS_KEY:
   * nothing is ever stored in plaintext.
   */
  @Post(':id/webhook-secret')
  @HttpCode(201)
  async webhookSecret(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const schoolId = requireSchoolId(user);
    const box = this.secrets?.box;
    if (!box?.configured) {
      throw new ServiceUnavailableException({ message: 'INTEGRATION_SECRETS_KEY is not configured.', code: 'SS12000_SECRETS_NOT_CONFIGURED' });
    }
    const secret = newWebhookSecret();
    const sealed = box.sealWith(secret, webhookSecretAad(schoolId, id));
    try {
      const [row] = await this.prisma.withRls(user, (tx) =>
        tx.$queryRaw<{ set_at: Date }[]>(
          Prisma.sql`SELECT app.integration_key_set_webhook_secret(${id}::uuid, ${sealed.ciphertext}, ${sealed.iv}, ${sealed.authTag}, ${sealed.keyId}) AS set_at`,
        ),
      );
      return { id, secret, setAt: row?.set_at ?? null };
    } catch (error) {
      if (sqlStateOf(error) === 'SS404') throw new NotFoundException({ message: 'No such live key.', code: 'INTEGRATION_KEY_NOT_FOUND' });
      throw error;
    }
  }

  /** The school pauses a key's subscription (suspendedReason ADMIN), or lifts any suspension. */
  @Post(':id/subscriptions/:subscriptionId/:action')
  @HttpCode(200)
  async subscriptionState(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('subscriptionId', new ParseUUIDPipe()) subscriptionId: string,
    @Param('action') action: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (action !== 'pause' && action !== 'resume') throw new NotFoundException();
    const data =
      action === 'pause'
        ? { suspendedAt: new Date(), suspendedReason: 'ADMIN' }
        : { suspendedAt: null, suspendedReason: null, failingSince: null, attempts: 0, nextAttemptAt: new Date() };
    const updated = await this.prisma.withRls(user, (tx) =>
      tx.ss12000Subscription.updateMany({ where: { id: subscriptionId, keyId: id, endedAt: null }, data }),
    );
    if (updated.count !== 1) throw new NotFoundException({ message: 'No such subscription.', code: 'SUBSCRIPTION_NOT_FOUND' });
    return { id: subscriptionId, state: action === 'pause' ? 'PAUSED' : 'ACTIVE' };
  }

  @Delete(':id')
  async revoke(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.prisma.withRls(user, (tx) =>
      tx.integrationApiKey.update({ where: { id }, data: { revokedAt: new Date() } }),
    );
    return { id };
  }
}

/** The host of a subscription's target, for the admin's list: never its path or query. */
function hostOf(target: string): string {
  try {
    return new URL(target).host;
  } catch {
    return '';
  }
}

/**
 * SS12000:2020-inspired external API. Authenticated with `X-API-Key`
 * (see `IntegrationKeyGuard`); every route is scoped to the key's school.
 */
@Controller('ss12000/v1')
@Public()
@UseGuards(IntegrationKeyGuard, IntegrationScopeGuard)
@RequireScope('ss12000.v1')
@Throttle({ default: { limit: 120, ttl: 60_000 } })
export class Ss12000Controller {
  constructor(private readonly ss12000: Ss12000Service) {}

  @Get('organisation')
  organisation(@Req() req: IntegrationRequest) {
    return this.ss12000.organisation(req.integrationSchoolId as string);
  }

  @Get('persons')
  persons(
    @Req() req: IntegrationRequest,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('role') role?: string,
  ) {
    return this.ss12000.persons(
      req.integrationSchoolId as string,
      limit,
      offset,
      role,
    );
  }

  @Get('groups')
  groups(
    @Req() req: IntegrationRequest,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.ss12000.groups(req.integrationSchoolId as string, limit, offset);
  }

  /**
   * SS12000 2.1.0 Duty: the active year's teaching posts, one per teacher,
   * with their mentorships; percentages only when the school shares them.
   */
  @Get('duties')
  duties(
    @Req() req: IntegrationRequest,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.ss12000.duties(req.integrationSchoolId as string, limit, offset);
  }

  @Get('activities')
  activities(
    @Req() req: IntegrationRequest,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.ss12000.activities(req.integrationSchoolId as string, limit, offset);
  }

  @Get('calendarEvents')
  calendarEvents(
    @Req() req: IntegrationRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.ss12000.calendarEvents(
      req.integrationSchoolId as string,
      from,
      to,
      limit,
      offset,
    );
  }

  @Post('import/persons')
  @RequireScope('ss12000.v1.import')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  importPersons(
    @Req() req: IntegrationRequest,
    @Body()
    body: {
      persons?: Array<{
        givenName?: string;
        familyName?: string;
        email?: string;
        groupDisplayName?: string;
        responsibleEmails?: string[];
      }>;
    },
  ) {
    return this.ss12000.importPersons(
      req.integrationSchoolId as string,
      body.persons ?? [],
    );
  }
}
