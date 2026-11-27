import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Area } from '../auth/decorators/area.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  DirectReachQueryDto,
  DiscardDraftDto,
  PublicationListQueryDto,
  PublicationRangeDto,
  PublishTimetableDto,
  RefillPublicationDto,
  SwitchPublishModeDto,
  UpsertPublicationSettingsDto,
} from './dto/publication.dto';
import { DraftService, type DraftState, type ModeSwitchResult } from './draft.service';
import { DirectReachService, type DirectReachView } from './direct-reach.service';
import type { PublishResult } from '../calendar/calendar.service';
import type { GateItem } from './publication-gates';
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
@Area('PUBLICERING', 'DRIFT')
export class PublicationsController {
  constructor(
    private readonly publications: PublicationsService,
    private readonly drafts: DraftService,
    private readonly directReach: DirectReachService,
  ) {}

  @Get('publication-settings')
  settings(@CurrentUser() user: AuthenticatedUser): Promise<PublicationSettingsResponse> {
    return this.publications.settings(user);
  }

  @Put('publication-settings')
  @Area('PUBLICERING')
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

  /** DIRECT ↔ DRAFT. To DRAFT records a BASELINE; back to DIRECT only with nothing unpublished. */
  @Post('publication-settings/mode')
  @HttpCode(HttpStatus.OK)
  @Area('PUBLICERING')
  switchMode(
    @Body() dto: SwitchPublishModeDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ModeSwitchResult> {
    return this.drafts.switchMode(dto.publishMode, user);
  }

  /**
   * Frågan före en ändring i Direkt som når familjer (P5, beslut 8): om sidan ska fråga, vilken publicerad period det gäller och hur många
   * som kan få en notis. Läses av varje administratör: den som drar lektionen ställs frågan till.
   */
  @Get('publication-settings/direct-reach')
  directReachQuestion(
    @Query() query: DirectReachQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DirectReachView> {
    return this.directReach.read(user, query.academicYearId);
  }

  /** "Fortsätt i Direkt": the school has answered for the publication that holds. Publicering writes the settings row, so Publicering answers. */
  @Post('publication-settings/direct-reach/acknowledge')
  @HttpCode(HttpStatus.OK)
  @Area('PUBLICERING')
  acknowledgeDirectReach(
    @Body() dto: DirectReachQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DirectReachView> {
    return this.directReach.acknowledge(user, dto.academicYearId);
  }

  /** The draft against what is published: added, changed, removed, pending. */
  @Get('publications/state')
  state(
    @Query() query: PublicationListQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DraftState> {
    return this.drafts.state(query.academicYearId, user);
  }

  @Post('publications/discard')
  @HttpCode(HttpStatus.OK)
  @Area('PUBLICERING', 'SCHEMALAGGNING', 'DRIFT')
  discard(
    @Body() dto: DiscardDraftDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ restored: number; removed: number; safetyVersionId: string }> {
    return this.drafts.discard(dto.academicYearId, user);
  }

  @Post('publications/refill')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  refill(
    @Body() dto: RefillPublicationDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ result: PublishResult; gates: GateItem[]; publicationId: string }> {
    return this.drafts.refill(dto, user);
  }
}
