import { createHash, randomBytes } from 'node:crypto';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
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
import { Ss12000Service } from './ss12000.service';

/**
 * Admin management of integration API keys. The plaintext key is returned
 * exactly once on create; only the SHA-256 hash is stored.
 */
@Controller('api/v1/integration-keys')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class IntegrationKeysController {
  constructor(private readonly prisma: PrismaService) {}

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

  @Post()
  async create(
    @Body() body: { name?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const schoolId = requireSchoolId(user);
    const name = (body.name ?? '').trim() || 'Integration';
    const key = `sp_${randomBytes(24).toString('hex')}`;
    const keyHash = createHash('sha256').update(key).digest('hex');
    const created = await this.prisma.withRls(user, (tx) =>
      tx.integrationApiKey.create({
        data: {
          schoolId,
          name: name.slice(0, 120),
          keyHash,
          createdById: user.userId ?? null,
        },
        select: { id: true, name: true, createdAt: true },
      }),
    );
    // Plaintext key: shown once, never retrievable again.
    return { ...created, key };
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

/**
 * SS12000:2020-inspired external API. Authenticated with `X-API-Key`
 * (see `IntegrationKeyGuard`); every route is scoped to the key's school.
 */
@Controller('ss12000/v1')
@Public()
@UseGuards(IntegrationKeyGuard)
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
