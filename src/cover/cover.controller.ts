import {
  BadRequestException,
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
  Put,
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
import { CoverService, type BoardResponse } from './cover.service';
import { CoverSuggestionsService, type CandidatesResponse } from './cover-suggestions.service';
import { CoverReportsService, type CounterView, type HoursResponse } from './cover-reports.service';
import {
  CoverSettingsService,
  type AvailabilityView,
  type CoverSettingsView,
  type ReasonView,
} from './cover-settings.service';
import { TeacherAbsencesService, type AbsenceView } from './teacher-absences.service';
import type { DayProposal } from './day-proposal';
import {
  ApplyDto,
  AvailabilityQueryDto,
  BoardQueryDto,
  BulkDto,
  CounterQueryDto,
  CoverSettingsDto,
  CreateAbsenceDto,
  CreateAvailabilityDto,
  CreateReasonDto,
  DecisionDto,
  EndAbsenceDto,
  HoursQueryDto,
  ListAbsencesQueryDto,
  PoolMemberDto,
  ProposalDto,
  UndoQueryDto,
  UpdateAbsenceDto,
  UpdateReasonDto,
  WithdrawAbsenceDto,
} from './dto/cover.dto';

const uuid = () => new ParseUUIDPipe({ version: '4' });

function isoDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime())) {
    throw new BadRequestException('date: YYYY-MM-DD.');
  }
  return value;
}

/**
 * Teacher absences. An admin registers and edits anybody's; a TEACHER reads
 * their own and — when the school allows self-report — registers, ends early
 * and withdraws their own (RLS and the guard trigger decide that too).
 * STUDENT and GUARDIAN reach nothing here.
 */
@Controller('api/v1/teacher-absences')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class TeacherAbsencesController {
  constructor(private readonly absences: TeacherAbsencesService) {}

  @Get()
  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  list(@Query() query: ListAbsencesQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<AbsenceView[]> {
    return this.absences.list(query, user);
  }

  @Post()
  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  create(@Body() dto: CreateAbsenceDto, @CurrentUser() user: AuthenticatedUser): Promise<AbsenceView> {
    return this.absences.create(dto, user);
  }

  @Patch(':id')
  update(
    @Param('id', uuid()) id: string,
    @Body() dto: UpdateAbsenceDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AbsenceView> {
    return this.absences.update(id, dto, user);
  }

  @Post(':id/end')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  end(
    @Param('id', uuid()) id: string,
    @Body() dto: EndAbsenceDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AbsenceView> {
    return this.absences.end(id, dto, user);
  }

  @Post(':id/withdraw')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  withdraw(
    @Param('id', uuid()) id: string,
    @Body() dto: WithdrawAbsenceDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AbsenceView> {
    return this.absences.withdraw(id, Boolean(dto.undoDecisions), user);
  }
}

/** The school's absence categories: staff read them, the admin writes them. */
@Controller('api/v1/teacher-absence-reasons')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class TeacherAbsenceReasonsController {
  constructor(private readonly settings: CoverSettingsService) {}

  @Get()
  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  list(@CurrentUser() user: AuthenticatedUser): Promise<ReasonView[]> {
    return this.settings.reasons(user);
  }

  @Post()
  create(@Body() dto: CreateReasonDto, @CurrentUser() user: AuthenticatedUser): Promise<ReasonView> {
    return this.settings.createReason(dto, user);
  }

  @Patch(':id')
  update(
    @Param('id', uuid()) id: string,
    @Body() dto: UpdateReasonDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReasonView> {
    return this.settings.updateReason(id, dto, user);
  }
}

/**
 * The cover board (Vikarietavla), its suggestions, the day proposal, the
 * counter, the hour statement and the pool. ADMIN ONLY, except the settings
 * a teacher reads and the availability a pool member keeps.
 */
@Controller('api/v1/cover')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class CoverController {
  constructor(
    private readonly cover: CoverService,
    private readonly suggestions: CoverSuggestionsService,
    private readonly reports: CoverReportsService,
    private readonly settings: CoverSettingsService,
  ) {}

  @Get('settings')
  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  getSettings(@CurrentUser() user: AuthenticatedUser): Promise<CoverSettingsView> {
    return this.settings.settings(user);
  }

  @Put('settings')
  putSettings(@Body() dto: CoverSettingsDto, @CurrentUser() user: AuthenticatedUser): Promise<CoverSettingsView> {
    return this.settings.putSettings(dto, user);
  }

  @Get('board')
  board(@Query() query: BoardQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<BoardResponse> {
    return this.cover.board(query.from, query.to, user);
  }

  @Post('lessons/:lessonId/decision')
  @HttpCode(HttpStatus.OK)
  decide(
    @Param('lessonId', uuid()) lessonId: string,
    @Body() dto: DecisionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.cover.decide(lessonId, dto, user);
  }

  @Delete('lessons/:lessonId/decision')
  undo(
    @Param('lessonId', uuid()) lessonId: string,
    @Query() query: UndoQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ lessonId: string; absenceId: string }> {
    return this.cover.undo(lessonId, query.absenceId, user);
  }

  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  bulk(@Body() dto: BulkDto, @CurrentUser() user: AuthenticatedUser): Promise<{ done: number }> {
    return this.cover.bulk(dto, user);
  }

  @Get('lessons/:lessonId/candidates')
  candidates(
    @Param('lessonId', uuid()) lessonId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CandidatesResponse> {
    return this.suggestions.candidates(lessonId, user);
  }

  @Post('days/:date/proposal')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  proposal(
    @Param('date') date: string,
    @Body() dto: ProposalDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DayProposal & { date: string; basis: string }> {
    return this.suggestions.proposal(isoDate(date), dto.excludeUserIds ?? [], user);
  }

  @Post('days/:date/apply')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  apply(
    @Param('date') date: string,
    @Body() dto: ApplyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ applied: number }> {
    return this.suggestions.apply(isoDate(date), dto, user);
  }

  @Get('counter')
  counter(@Query() query: CounterQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<{ date: string; rows: CounterView[] }> {
    return this.reports.counter(query.date, user);
  }

  @Get('hours')
  hours(@Query() query: HoursQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<HoursResponse> {
    return this.reports.hours(query.from, query.to, query.userId, user);
  }

  @Get('pool')
  pool(@CurrentUser() user: AuthenticatedUser): Promise<{ userId: string; createdAt: string }[]> {
    return this.settings.pool(user);
  }

  @Post('pool')
  addToPool(@Body() dto: PoolMemberDto, @CurrentUser() user: AuthenticatedUser): Promise<{ userId: string }> {
    return this.settings.addToPool(dto.userId, user);
  }

  @Delete('pool/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeFromPool(@Param('userId', uuid()) userId: string, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.settings.removeFromPool(userId, user);
  }

  @Get('availability')
  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  availability(@Query() query: AvailabilityQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<AvailabilityView[]> {
    return this.settings.availability(query.userId, user);
  }

  @Post('availability')
  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  addAvailability(@Body() dto: CreateAvailabilityDto, @CurrentUser() user: AuthenticatedUser): Promise<AvailabilityView> {
    return this.settings.addAvailability(dto, user);
  }

  @Delete('availability/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  removeAvailability(@Param('id', uuid()) id: string, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.settings.removeAvailability(id, user);
  }
}
