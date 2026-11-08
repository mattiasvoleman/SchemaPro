import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AnyAdministrator, Area } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CreateExternalBookingDto, ExternalBookingRuleDto, UpdateExternalBookingDto } from './dto/external-booking.dto';
import { CreateResourceBookingDto, DecideResourceBookingDto } from './dto/resource-booking.dto';
import { CreateResourceDto, CreateResourceTypeDto, UpdateResourceDto, UpdateResourceTypeDto } from './dto/resource.dto';
import {
  ExternalBookingListQueryDto,
  ResourceAvailabilityQueryDto,
  ResourceBookingListQueryDto,
  UtilisationQueryDto,
} from './dto/utilisation.dto';
import { ExternalBookingsService } from './external-bookings.service';
import type {
  ExternalBookingDetail,
  ExternalBookingResult,
  ExternalBookingSummary,
  ExternalClashResponse,
  ExternalDayResponse,
  ExternalPreviewResponse,
  ResourceAvailabilityResponse,
  ResourceBookingResponse,
  ResourceBookingResult,
  ResourceResponse,
  ResourceTypeResponse,
  UtilisationResponse,
} from './local-types';
import { ResourceBookingsService } from './resource-bookings.service';
import { ResourceTypesService } from './resource-types.service';
import { ResourcesService } from './resources.service';
import { UtilisationService } from './utilisation.service';
import { utilisationCsv, utilisationFilename } from './utilisation-csv';

/**
 * Lokal: the kinds of resource. Personnel read, Planering writes (as the room types).
 * Reads go through the gateway, not PostgREST: the tables grant `authenticated` nothing.
 */
@Controller('api/v1/resource-types')
@UseGuards(JwtAuthGuard, RolesGuard)
@Area('PLANERING')
export class ResourceTypesController {
  constructor(private readonly types: ResourceTypesService) {}

  @Get()
  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN)
  list(@CurrentUser() user: AuthenticatedUser): Promise<ResourceTypeResponse[]> {
    return this.types.list(user);
  }

  @Post()
  @Roles(Role.SCHOOL_ADMIN)
  create(@Body() dto: CreateResourceTypeDto, @CurrentUser() user: AuthenticatedUser): Promise<ResourceTypeResponse> {
    return this.types.create(dto, user);
  }

  @Patch(':id')
  @Roles(Role.SCHOOL_ADMIN)
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateResourceTypeDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ResourceTypeResponse> {
    return this.types.update(id, dto, user);
  }

  @Delete(':id')
  @Roles(Role.SCHOOL_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.types.remove(id, user);
  }
}

/** Lokal: the resources, and what is free of them in a window. */
@Controller('api/v1/resources')
@UseGuards(JwtAuthGuard, RolesGuard)
@Area('PLANERING')
export class ResourcesController {
  constructor(private readonly resources: ResourcesService) {}

  @Get()
  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN)
  list(@CurrentUser() user: AuthenticatedUser): Promise<ResourceResponse[]> {
    return this.resources.list(user);
  }

  @Get('availability')
  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN)
  availability(@Query() query: ResourceAvailabilityQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<ResourceAvailabilityResponse[]> {
    return this.resources.availability(query.from, query.to, user);
  }

  @Post()
  @Roles(Role.SCHOOL_ADMIN)
  create(@Body() dto: CreateResourceDto, @CurrentUser() user: AuthenticatedUser): Promise<ResourceResponse> {
    return this.resources.create(dto, user);
  }

  @Patch(':id')
  @Roles(Role.SCHOOL_ADMIN)
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateResourceDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ResourceResponse> {
    return this.resources.update(id, dto, user);
  }

  @Delete(':id')
  @Roles(Role.SCHOOL_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.resources.remove(id, user);
  }
}

/**
 * Lokal: bookings of resources, on the room bookings' flow. Teachers book and cancel their
 * own; Drift decides.
 */
@Controller('api/v1/resource-bookings')
@UseGuards(JwtAuthGuard, RolesGuard)
@Area('DRIFT')
export class ResourceBookingsController {
  constructor(private readonly bookings: ResourceBookingsService) {}

  @Get()
  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN)
  list(@Query() query: ResourceBookingListQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<ResourceBookingResponse[]> {
    return this.bookings.list(user, { status: query.status, mine: query.mine === 'true' });
  }

  @Post()
  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  create(@Body() dto: CreateResourceBookingDto, @CurrentUser() user: AuthenticatedUser): Promise<ResourceBookingResult> {
    return this.bookings.create(dto, user);
  }

  @Patch(':id/cancel')
  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN)
  cancel(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @CurrentUser() user: AuthenticatedUser): Promise<ResourceBookingResult> {
    return this.bookings.cancel(id, user);
  }

  @Patch(':id/decide')
  @Roles(Role.SCHOOL_ADMIN)
  decide(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: DecideResourceBookingDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ResourceBookingResult> {
    return this.bookings.decide(id, dto, user);
  }
}

/**
 * Lokal: external bookers. The expedition (SCHOOL_ADMIN under Drift) registers a series for a hirer
 * who has no login; the contact is personal data and is answered to administrators alone.
 * The static routes come before `:id`.
 */
@Controller('api/v1/external-bookings')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Area('DRIFT')
export class ExternalBookingsController {
  constructor(private readonly external: ExternalBookingsService) {}

  @Post('preview')
  preview(@Body() dto: ExternalBookingRuleDto, @CurrentUser() user: AuthenticatedUser): Promise<ExternalPreviewResponse> {
    return this.external.preview(dto, user);
  }

  @Post()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  create(@Body() dto: CreateExternalBookingDto, @CurrentUser() user: AuthenticatedUser): Promise<ExternalBookingResult> {
    return this.external.create(dto, user);
  }

  @Get()
  list(@Query() query: ExternalBookingListQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<ExternalBookingSummary[]> {
    return this.external.list(query.state ?? 'active', user);
  }

  @Get('clashes')
  clashes(@CurrentUser() user: AuthenticatedUser): Promise<ExternalClashResponse[]> {
    return this.external.clashes(user);
  }

  @Get(':id')
  detail(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @CurrentUser() user: AuthenticatedUser): Promise<ExternalBookingDetail> {
    return this.external.detail(id, user);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateExternalBookingDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ExternalBookingSummary> {
    return this.external.update(id, dto, user);
  }

  @Patch(':id/cancel')
  cancel(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @CurrentUser() user: AuthenticatedUser): Promise<ExternalBookingSummary> {
    return this.external.cancel(id, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.external.remove(id, user);
  }

  @Patch(':id/days/:dayId/cancel')
  cancelDay(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('dayId', new ParseUUIDPipe({ version: '4' })) dayId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ExternalDayResponse> {
    return this.external.cancelDay(id, dayId, user);
  }
}

/** Lokal: the utilisation report, as a screen and as a CSV. Every administrator reads. */
@Controller('api/v1/utilisation')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@AnyAdministrator('Reads only: the report names no person and writes nothing.')
export class UtilisationController {
  constructor(private readonly utilisation: UtilisationService) {}

  @Get()
  report(@Query() query: UtilisationQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<UtilisationResponse> {
    return this.utilisation.report(query, user);
  }

  @Get('csv')
  async csv(
    @Query() query: UtilisationQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const report = await this.utilisation.report(query, user);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="${utilisationFilename(report)}"`);
    response.setHeader('Cache-Control', 'no-store');
    return utilisationCsv(report);
  }
}
