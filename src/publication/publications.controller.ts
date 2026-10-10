import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  PublicationListQueryDto,
  PublicationRangeDto,
  PublishTimetableDto,
  UpsertPublicationSettingsDto,
} from './dto/publication.dto';
import {
  PublicationsService,
  type PublicationOutcome,
  type PublicationPreview,
  type PublicationSettingsResponse,
  type PublicationTimeline,
} from './publications.service';

/**
 * Publicering. ADMIN ONLY, every verb: the policy, the timeline and the
 * gated publish are the school's to decide, and nothing here is a read a
 * teacher, pupil or guardian has a page for — they read the calendar.
 *
 * Preview and publish are throttled like the old publish (10 a minute each):
 * a preview materialises the whole window before rolling back.
 */
@Controller('api/v1')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class PublicationsController {
  constructor(private readonly publications: PublicationsService) {}

  @Get('publication-settings')
  settings(@CurrentUser() user: AuthenticatedUser): Promise<PublicationSettingsResponse> {
    return this.publications.settings(user);
  }

  @Put('publication-settings')
  upsertSettings(
    @Body() dto: UpsertPublicationSettingsDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PublicationSettingsResponse> {
    return this.publications.upsertSettings(dto, user);
  }

  @Get('publications')
  timeline(
    @Query() query: PublicationListQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PublicationTimeline> {
    return this.publications.timeline(query.academicYearId, user);
  }

  @Post('publications/preview')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  preview(
    @Body() dto: PublicationRangeDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PublicationPreview> {
    return this.publications.preview(dto, user);
  }

  @Post('publications')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  publish(
    @Body() dto: PublishTimetableDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PublicationOutcome> {
    return this.publications.publish(dto, user);
  }
}
