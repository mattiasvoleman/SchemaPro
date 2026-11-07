import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Area } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { AckService } from './ack.service';
import type {
  AckConfirmed,
  AckCreated,
  AckDetail,
  AckListItem,
  AckMine,
  AckPage,
  AckPupilChoice,
  AckReminderStopped,
  AckSettingsView,
} from './ack-views';
import { AckPageQueryDto, AckSettingsDto, CreateAckRequestDto } from './dto/ack.dto';

/**
 * Kvittens: personnel ask the guardians of their pupils to confirm a message
 * (/teacher/acknowledgements, /admin/acknowledgements), and a guardian
 * confirms (/guardian/acknowledgements).
 *
 * An administrator writes under Drift; a teacher asks about their mentees; a
 * guardian reads and confirms their own, and the database says which rows
 * each may see. The settings are the administrators' to write.
 */
@Controller('api/v1/acknowledgements')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
@Area('DRIFT')
export class AckController {
  constructor(private readonly ack: AckService) {}

  @Get('settings')
  settings(@CurrentUser() user: AuthenticatedUser): Promise<AckSettingsView> {
    return this.ack.settings(user);
  }

  @Put('settings')
  @Roles(Role.SCHOOL_ADMIN)
  updateSettings(@Body() dto: AckSettingsDto, @CurrentUser() user: AuthenticatedUser): Promise<AckSettingsView> {
    return this.ack.updateSettings(dto, user);
  }

  /** The pupils the caller may ask about. Recorded in the read log. */
  @Get('pupils')
  pupils(@CurrentUser() user: AuthenticatedUser): Promise<AckPupilChoice[]> {
    return this.ack.pupils(user);
  }

  /** A page of the guardian's own requests. Before ':id', which would take 'mine' for an id. */
  @Get('mine')
  @Roles(Role.GUARDIAN)
  mine(@CurrentUser() user: AuthenticatedUser, @Query() query: AckPageQueryDto): Promise<AckPage<AckMine>> {
    return this.ack.mine(user, query);
  }

  /** A page of the requests the caller may see. */
  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: AckPageQueryDto): Promise<AckPage<AckListItem>> {
    return this.ack.list(user, query);
  }

  /** Who has confirmed and when. Recorded in the read log. */
  @Get(':id')
  detail(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @CurrentUser() user: AuthenticatedUser): Promise<AckDetail> {
    return this.ack.detail(id, user);
  }

  /**
   * Five a minute besides the database's limit (10 an hour for a person, 20 000
   * receipts a day for a school): a request is up to 4 000 notices.
   */
  @Post()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  create(@Body() dto: CreateAckRequestDto, @CurrentUser() user: AuthenticatedUser): Promise<AckCreated> {
    return this.ack.create(dto, user);
  }

  /** The author, or an administrator under Drift, stops the reminder of a request that went out wrong. */
  @Post(':id/stop-reminder')
  @HttpCode(HttpStatus.OK)
  stopReminder(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @CurrentUser() user: AuthenticatedUser): Promise<AckReminderStopped> {
    return this.ack.stopReminder(id, user);
  }

  @Post(':id/confirm')
  @Roles(Role.GUARDIAN)
  @HttpCode(HttpStatus.OK)
  confirm(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @CurrentUser() user: AuthenticatedUser): Promise<AckConfirmed> {
    return this.ack.confirm(id, user);
  }
}
