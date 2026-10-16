import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AnyAdministrator } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CreateCalendarFeedDto } from './dto/calendar-feed.dto';
import { CalendarFeedsService, type CalendarFeedsView, type CreatedCalendarFeed, type FeedCounts } from './calendar-feeds.service';

/**
 * Kalenderprenumeration (20261112091000), a person's own feeds:
 *
 *   GET    calendar-feeds         whether the caller's audience is on, and
 *                                 their live feeds (never an address)
 *   POST   calendar-feeds         a new address for their week, or a child's;
 *                                 the old one stops. Throttled to a minute's
 *                                 worth of a person trying again: each is a
 *                                 credential drawn and a row written
 *   DELETE calendar-feeds/:id     revoke one of their own
 *   GET    calendar-feeds/counts  the admin's count per audience
 *
 * An administrator's writes here are their own feed and nothing of the
 * school's, so every profile may make them (Roller i skolan). The switches
 * are PublicationSettings, written through publication-settings under
 * Publicering.
 */
@Controller('api/v1')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CalendarFeedsController {
  constructor(private readonly feeds: CalendarFeedsService) {}

  @Get('calendar-feeds')
  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN, Role.STUDENT, Role.GUARDIAN)
  mine(@CurrentUser() user: AuthenticatedUser): Promise<CalendarFeedsView> {
    return this.feeds.mine(user);
  }

  @Get('calendar-feeds/counts')
  @Roles(Role.SCHOOL_ADMIN)
  counts(@CurrentUser() user: AuthenticatedUser): Promise<FeedCounts> {
    return this.feeds.counts(user);
  }

  @Post('calendar-feeds')
  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN, Role.STUDENT, Role.GUARDIAN)
  @AnyAdministrator("the caller's own calendar feed")
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  create(@Body() dto: CreateCalendarFeedDto, @CurrentUser() user: AuthenticatedUser): Promise<CreatedCalendarFeed> {
    return this.feeds.create(dto, user);
  }

  @Delete('calendar-feeds/:id')
  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN, Role.STUDENT, Role.GUARDIAN)
  @AnyAdministrator("the caller's own calendar feed")
  @HttpCode(204)
  revoke(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.feeds.revoke(id, user);
  }
}
