import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Ss12000SecretKind } from '@prisma/client';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { Role } from '../../auth/enums/role.enum';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import {
  ApplyRunDto,
  ListChangesQueryDto,
  ListRunsQueryDto,
  Ss12000ScheduleDto,
  Ss12000SecretDto,
  Ss12000SourceDto,
  StartRunDto,
} from './dto';
import { Ss12000SourceService } from './ss12000-source.service';
import { Ss12000SyncService } from './ss12000-sync.service';

const HOUR_MS = 60 * 60 * 1000;

/**
 * The school's SS12000 source (the consumer): configuration, write-only
 * credentials, "Testa anslutning" and the schedule. SCHOOL_ADMIN only; a
 * TEACHER, STUDENT or GUARDIAN gets 403, an integration key 401 (these are
 * JWT routes).
 */
@Controller('api/v1/ss12000-source')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class Ss12000SourceController {
  constructor(private readonly sources: Ss12000SourceService) {}

  @Get()
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.sources.get(user);
  }

  @Put()
  put(@Body() body: Ss12000SourceDto, @CurrentUser() user: AuthenticatedUser) {
    return this.sources.put(user, body);
  }

  /** Write-only: answers {kind, setAt}, never the value. */
  @Put('secrets/:kind')
  putSecret(
    @Param('kind', new ParseEnumPipe(Ss12000SecretKind)) kind: Ss12000SecretKind,
    @Body() body: Ss12000SecretDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.sources.putSecret(user, kind, body.value);
  }

  @Delete('secrets/:kind')
  clearSecret(@Param('kind', new ParseEnumPipe(Ss12000SecretKind)) kind: Ss12000SecretKind, @CurrentUser() user: AuthenticatedUser) {
    return this.sources.clearSecret(user, kind);
  }

  @Post('test')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: HOUR_MS } })
  test(@CurrentUser() user: AuthenticatedUser) {
    return this.sources.test(user);
  }

  @Patch('schedule')
  patchSchedule(@Body() body: Ss12000ScheduleDto, @CurrentUser() user: AuthenticatedUser) {
    return this.sources.patchSchedule(user, body);
  }
}

/**
 * Runs, their diffs, the apply and the provisioning list. SCHOOL_ADMIN only.
 */
@Controller('api/v1/ss12000-sync')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class Ss12000SyncController {
  constructor(private readonly sync: Ss12000SyncService) {}

  /** "Synka nu": 202 {runId}; poll GET runs/:id. */
  @Post('runs')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 6, ttl: HOUR_MS } })
  start(@Body() body: StartRunDto, @CurrentUser() user: AuthenticatedUser) {
    return this.sync.startManualRun(user, body.mode);
  }

  @Get('runs')
  list(@Query() query: ListRunsQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.sync.listRuns(user, query);
  }

  @Get('runs/:id')
  get(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.sync.getRun(user, id);
  }

  @Get('runs/:id/changes')
  changes(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: ListChangesQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.sync.listChanges(user, id, query);
  }

  @Post('runs/:id/apply')
  @HttpCode(HttpStatus.OK)
  apply(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() body: ApplyRunDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.sync.apply(user, id, body);
  }

  @Post('runs/:id/discard')
  @HttpCode(HttpStatus.OK)
  discard(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.sync.discard(user, id);
  }

  @Get('provisioning')
  provisioning(@CurrentUser() user: AuthenticatedUser) {
    return this.sync.provisioning(user);
  }
}
