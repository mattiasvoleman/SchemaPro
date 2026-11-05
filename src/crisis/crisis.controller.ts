import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Area, Decides } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CrisisService } from './crisis.service';
import type { AlarmDetail, AlarmSummary, CrisisSettingsView, MyCrisisResponse, ProtocolView } from './crisis-views';
import { AlarmListQueryDto, EndAlarmDto, MarksDto, StartAlarmDto, UpdateCrisisSettingsDto } from './dto/crisis.dto';

const uuid = () => new ParseUUIDPipe({ version: '4' });

/** What a mark answers: how many were stored, how many were already, and the ones that belong to no alarm of the caller's. */
export interface MarkResult {
  stored: number;
  duplicates: number;
  unresolved: string[];
}

/**
 * Krisläge, the school's side: the settings (rektor decides who may start an
 * alarm), starting and ending an alarm, the live view, the protocol, and the
 * administration's own marks for a group nobody answers for. Drift's, as the
 * cover board is; the database holds the start to the profiles the school let
 * start an alarm (app.crisis_may_start).
 */
@Controller('api/v1/crisis')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Area('DRIFT')
export class CrisisAdminController {
  constructor(private readonly crisis: CrisisService) {}

  @Get('settings')
  settings(@CurrentUser() user: AuthenticatedUser): Promise<CrisisSettingsView> {
    return this.crisis.settings(user);
  }

  @Put('settings')
  @Decides()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  updateSettings(@Body() dto: UpdateCrisisSettingsDto, @CurrentUser() user: AuthenticatedUser): Promise<CrisisSettingsView> {
    return this.crisis.updateSettings(dto, user);
  }

  @Get('alarms')
  list(@Query() query: AlarmListQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<AlarmSummary[]> {
    return this.crisis.list(query, user);
  }

  @Post('alarms')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  start(@Body() dto: StartAlarmDto, @CurrentUser() user: AuthenticatedUser): Promise<AlarmDetail> {
    return this.crisis.start(dto, user);
  }

  @Get('alarms/:id')
  detail(@Param('id', uuid()) id: string, @CurrentUser() user: AuthenticatedUser): Promise<AlarmDetail> {
    return this.crisis.detail(id, user);
  }

  @Get('alarms/:id/protocol')
  protocol(@Param('id', uuid()) id: string, @CurrentUser() user: AuthenticatedUser): Promise<ProtocolView> {
    return this.crisis.protocol(id, user);
  }

  @Post('alarms/:id/end')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  end(@Param('id', uuid()) id: string, @Body() dto: EndAlarmDto, @CurrentUser() user: AuthenticatedUser): Promise<AlarmDetail> {
    return this.crisis.end(id, dto, user);
  }

  @Post('alarms/:id/marks')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  mark(@Param('id', uuid()) id: string, @Body() dto: MarksDto, @CurrentUser() user: AuthenticatedUser): Promise<MarkResult> {
    return this.crisis.markAsAdministration(id, dto.marks, user);
  }
}

/**
 * Krisläge, the teacher's side: the alarms they are to answer in and the
 * groups the timetable gave them, and their marks. A TEACHER's, and nobody
 * else's; what they read is their own groups (row-level security).
 */
@Controller('api/v1/crisis/mine')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.TEACHER)
export class CrisisTeacherController {
  constructor(private readonly crisis: CrisisService) {}

  @Get()
  mine(@CurrentUser() user: AuthenticatedUser): Promise<MyCrisisResponse> {
    return this.crisis.mine(user);
  }

  @Post('marks')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  mark(@Body() dto: MarksDto, @CurrentUser() user: AuthenticatedUser): Promise<MarkResult> {
    return this.crisis.markMine(dto.marks, user);
  }
}
