import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Area } from '../auth/decorators/area.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  ScheduleActivitiesService,
  type ActivityPreview,
  type RemovePreview,
  type ScheduleActivityView,
} from './schedule-activities.service';
import {
  CreateScheduleActivityDto,
  ScheduleActivityListQueryDto,
  ScheduleActivitySelectionDto,
  UpdateScheduleActivityDto,
} from './dto/schedule-activity.dto';

/**
 * Schemabrytande aktivitet. ADMIN ONLY, area DRIFT, as the avbokning it owns:
 * an activity cancels lessons for whole classes and years and puts a lesson
 * in their place; pupils, guardians and teachers read the outcome in the
 * calendar and in the notices.
 */
@Controller('api/v1/schedule-activities')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Area('DRIFT')
export class ScheduleActivitiesController {
  constructor(private readonly activities: ScheduleActivitiesService) {}

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  preview(@Body() dto: ScheduleActivitySelectionDto, @CurrentUser() user: AuthenticatedUser): Promise<ActivityPreview> {
    return this.activities.preview(dto, user);
  }

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  create(@Body() dto: CreateScheduleActivityDto, @CurrentUser() user: AuthenticatedUser) {
    return this.activities.create(dto, user);
  }

  @Get()
  list(@Query() query: ScheduleActivityListQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<ScheduleActivityView[]> {
    return this.activities.list(query.academicYearId, user);
  }

  @Post(':id/preview')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  updatePreview(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ScheduleActivitySelectionDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ActivityPreview> {
    return this.activities.updatePreview(id, dto, user);
  }

  @Patch(':id')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateScheduleActivityDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.activities.refuseWhenAnExam(id, user);
    return this.activities.update(id, dto, user);
  }

  @Post(':id/reapply')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  reapply(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.activities.reapply(id, user);
  }

  @Post(':id/remove/preview')
  @HttpCode(HttpStatus.OK)
  removePreview(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RemovePreview> {
    return this.activities.removePreview(id, user);
  }

  @Post(':id/remove')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RemovePreview> {
    await this.activities.refuseWhenAnExam(id, user);
    return this.activities.remove(id, user);
  }
}
