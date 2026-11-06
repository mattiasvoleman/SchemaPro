import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { Area } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { AckService } from './ack.service';
import type { AckConfirmed, AckCreated, AckDetail, AckListItem, AckMine, AckPupilChoice, AckSettingsView } from './ack-views';
import { AckSettingsDto, CreateAckRequestDto } from './dto/ack.dto';

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

  /** The guardian's own requests. Before ':id', which would take 'mine' for an id. */
  @Get('mine')
  @Roles(Role.GUARDIAN)
  mine(@CurrentUser() user: AuthenticatedUser): Promise<AckMine[]> {
    return this.ack.mine(user);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<AckListItem[]> {
    return this.ack.list(user);
  }

  /** Who has confirmed and when. Recorded in the read log. */
  @Get(':id')
  detail(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @CurrentUser() user: AuthenticatedUser): Promise<AckDetail> {
    return this.ack.detail(id, user);
  }

  @Post()
  create(@Body() dto: CreateAckRequestDto, @CurrentUser() user: AuthenticatedUser): Promise<AckCreated> {
    return this.ack.create(dto, user);
  }

  @Post(':id/confirm')
  @Roles(Role.GUARDIAN)
  @HttpCode(HttpStatus.OK)
  confirm(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @CurrentUser() user: AuthenticatedUser): Promise<AckConfirmed> {
    return this.ack.confirm(id, user);
  }
}
