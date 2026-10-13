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
import { Area, Decides } from '../auth/decorators/area.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { FamilyService } from './family.service';
import {
  FamilyReadsService,
  type AbsenceReportView,
  type ChildView,
  type GuardianLinkView,
} from './family-reads.service';
import { FamilyScheduleService, type FamilySchedule } from './family-schedule.service';
import { LeaveService, type LeaveRequestView } from './leave.service';
import { FamilyScheduleQueryDto } from './dto/family-schedule.dto';
import { AbsenceReportsQueryDto, GuardianLinksQueryDto, LeaveRequestsQueryDto } from './dto/family-reads.dto';
import {
  CreateAbsenceReportDto,
  CreateGuardianLinkDto,
  CreateLeaveRequestDto,
  DecideLeaveRequestDto,
  RecordLeaveDelegationDto,
} from './dto/family.dto';

/**
 * Guardian↔student links, absence reporting and leave requests, and a
 * child's schedule for the family. Every read of them passes through here
 * too (Läslogg): a guardian's children, the absence reports and leave
 * requests a caller may see, and a pupil's guardians each name other people,
 * so each response is recorded in the read log. The leave requests are
 * LeaveService's, for families and staff alike: the mentor's arms are the
 * API's alone (20261023091000). The schedule needs the teacher labels only a
 * SECURITY DEFINER function may give.
 */
@Controller('api/v1')
@UseGuards(JwtAuthGuard, RolesGuard)
export class FamilyController {
  constructor(
    private readonly family: FamilyService,
    private readonly schedule: FamilyScheduleService,
    private readonly reads: FamilyReadsService,
    private readonly leave: LeaveService,
  ) {}

  /** The signed-in guardian's linked pupils: names and whether they are active, no contact details. */
  @Get('family/children')
  @Roles(Role.GUARDIAN)
  children(@CurrentUser() user: AuthenticatedUser): Promise<ChildView[]> {
    return this.reads.children(user);
  }

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

  /** One pupil's guardians, for the administrator's people page. */
  @Get('guardian-links')
  @Roles(Role.SCHOOL_ADMIN)
  guardianLinks(
    @Query() query: GuardianLinksQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<GuardianLinkView[]> {
    return this.reads.guardianLinks(query, user);
  }

  @Post('guardian-links')
  @Roles(Role.SCHOOL_ADMIN)
  @Area('PERSONAL')
  createLink(
    @Body() dto: CreateGuardianLinkDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.family.createLink(dto, user);
  }

  @Delete('guardian-links/:id')
  @Roles(Role.SCHOOL_ADMIN)
  @Area('PERSONAL')
  removeLink(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.family.removeLink(id, user);
  }

  /** The absence reports row security shows the caller: a guardian's children's, a pupil's own, the school's. */
  @Get('absence-reports')
  @Roles(Role.GUARDIAN, Role.STUDENT, Role.SCHOOL_ADMIN)
  absenceReports(
    @Query() query: AbsenceReportsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AbsenceReportView[]> {
    return this.reads.absenceReports(query, user);
  }

  @Post('absence-reports')
  @Roles(Role.GUARDIAN, Role.STUDENT, Role.SCHOOL_ADMIN)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Area('DRIFT')
  createAbsenceReport(
    @Body() dto: CreateAbsenceReportDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.family.createAbsenceReport(dto, user);
  }

  @Delete('absence-reports/:id')
  @Roles(Role.GUARDIAN, Role.STUDENT, Role.SCHOOL_ADMIN)
  @Area('DRIFT')
  removeAbsenceReport(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.family.removeAbsenceReport(id, user);
  }

  /**
   * The leave requests row security shows the caller, with their reasons. A
   * guardian reads their children's, a pupil their own, the admin the
   * school's and a mentor those theirs to decide or decided by them; for the
   * admin and the mentor each comes with its skoldagar, who decides it now
   * and the pupil's leave so far this läsår. Every response is recorded in
   * the read log.
   */
  @Get('leave-requests')
  @Roles(Role.GUARDIAN, Role.STUDENT, Role.SCHOOL_ADMIN, Role.TEACHER)
  listLeaveRequests(
    @Query() query: LeaveRequestsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<LeaveRequestView[]> {
    return this.leave.listLeaveRequests(query, user);
  }

  @Post('leave-requests')
  @Roles(Role.GUARDIAN, Role.STUDENT, Role.SCHOOL_ADMIN)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Area('DRIFT')
  createLeaveRequest(
    @Body() dto: CreateLeaveRequestDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.leave.createLeaveRequest(dto, user);
  }

  /** Rektor decides any request; a TEACHER only one theirs to decide as the pupil's mentor. */
  @Patch('leave-requests/:id/decide')
  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  @Area('DRIFT')
  decideLeaveRequest(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: DecideLeaveRequestDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.leave.decideLeaveRequest(id, dto, user);
  }

  /** The deciding mentor passes a request on to rektor. */
  @Patch('leave-requests/:id/refer')
  @Roles(Role.TEACHER)
  referLeaveRequest(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.leave.referLeaveRequest(id, user);
  }

  /** Rektor's delegation in force, and its history. */
  @Get('leave-delegation')
  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  getLeaveDelegation(@CurrentUser() user: AuthenticatedUser) {
    return this.leave.getDelegation(user);
  }

  @Post('leave-delegation')
  @Roles(Role.SCHOOL_ADMIN)
  // Roller i skolan: delegating leave decisions to the mentors is rektor's.
  @Decides()
  recordLeaveDelegation(
    @Body() dto: RecordLeaveDelegationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.leave.recordDelegation(dto, user);
  }
}
