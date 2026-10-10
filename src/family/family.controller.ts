import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { FamilyService } from './family.service';
import { FamilyScheduleService, type FamilySchedule } from './family-schedule.service';
import { FamilyScheduleQueryDto } from './dto/family-schedule.dto';
import {
  CreateAbsenceReportDto,
  CreateGuardianLinkDto,
  CreateLeaveRequestDto,
  DecideLeaveRequestDto,
} from './dto/family.dto';

/**
 * Guardian↔student links, absence reporting and leave requests, and a
 * child's schedule for the family. Most reads go straight to Supabase under
 * RLS; mutations and the schedule (which needs the teacher labels only a
 * SECURITY DEFINER function may give) pass through here.
 */
@Controller('api/v1')
@UseGuards(JwtAuthGuard, RolesGuard)
export class FamilyController {
  constructor(
    private readonly family: FamilyService,
    private readonly schedule: FamilyScheduleService,
  ) {}

  /**
   * A child's published week as the school shows it to the family. A pupil
   * reads their own week through RLS as before, and a teacher has the staff
   * calendar; neither is a family.
   */
  @Get('family/schedule')
  @Roles(Role.GUARDIAN, Role.SCHOOL_ADMIN)
  childSchedule(
    @Query() query: FamilyScheduleQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<FamilySchedule> {
    return this.schedule.week(query, user);
  }

  @Post('guardian-links')
  @Roles(Role.SCHOOL_ADMIN)
  createLink(
    @Body() dto: CreateGuardianLinkDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.family.createLink(dto, user);
  }

  @Delete('guardian-links/:id')
  @Roles(Role.SCHOOL_ADMIN)
  removeLink(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.family.removeLink(id, user);
  }

  @Post('absence-reports')
  @Roles(Role.GUARDIAN, Role.STUDENT, Role.SCHOOL_ADMIN)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  createAbsenceReport(
    @Body() dto: CreateAbsenceReportDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.family.createAbsenceReport(dto, user);
  }

  @Delete('absence-reports/:id')
  @Roles(Role.GUARDIAN, Role.STUDENT, Role.SCHOOL_ADMIN)
  removeAbsenceReport(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.family.removeAbsenceReport(id, user);
  }

  @Post('leave-requests')
  @Roles(Role.GUARDIAN, Role.STUDENT, Role.SCHOOL_ADMIN)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  createLeaveRequest(
    @Body() dto: CreateLeaveRequestDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.family.createLeaveRequest(dto, user);
  }

  @Patch('leave-requests/:id/decide')
  @Roles(Role.SCHOOL_ADMIN)
  decideLeaveRequest(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: DecideLeaveRequestDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.family.decideLeaveRequest(id, dto, user);
  }
}
