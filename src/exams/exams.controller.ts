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
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Area } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { ApplyExamPlanDto, CreateExamDto, ExamListQueryDto, ExamRoomDto, ExamSettingsDto, PlanExamsDto, UpdateExamDto } from './dto/exam.dto';
import { ExamPlannerService, type ApplyResult, type ExamProposal } from './exam-planner.service';
import { ExamsService, type ExamRoomView, type ExamSettingsView, type ExamView, type InvigilatorCounterRow } from './exams.service';

/**
 * Provplanering. ADMIN ONLY, area DRIFT, as the activity an exam becomes:
 * pupils, guardians and teachers read the outcome in the calendar (a
 * replacement lesson with its room and its invigilators) and in the notices.
 * The planner is the school's to turn on (settings.enabled); everything else
 * here works with it off.
 */
@Controller('api/v1/exams')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Area('DRIFT')
export class ExamsController {
  constructor(
    private readonly exams: ExamsService,
    private readonly planner: ExamPlannerService,
  ) {}

  @Get('settings')
  settings(@CurrentUser() user: AuthenticatedUser): Promise<ExamSettingsView> {
    return this.exams.settings(user);
  }

  @Put('settings')
  updateSettings(@Body() dto: ExamSettingsDto, @CurrentUser() user: AuthenticatedUser): Promise<ExamSettingsView> {
    return this.exams.updateSettings(dto, user);
  }

  @Get('rooms')
  rooms(@CurrentUser() user: AuthenticatedUser): Promise<ExamRoomView[]> {
    return this.exams.rooms(user);
  }

  @Put('rooms/:roomId')
  markRoom(
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @Body() dto: ExamRoomDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ExamRoomView[]> {
    return this.exams.markRoom(roomId, dto.seats, user);
  }

  @Delete('rooms/:roomId')
  unmarkRoom(
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ExamRoomView[]> {
    return this.exams.unmarkRoom(roomId, user);
  }

  @Get('counter')
  counter(@Query() query: ExamListQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<InvigilatorCounterRow[]> {
    return this.exams.counter(query.academicYearId, user);
  }

  @Post('plan')
  @HttpCode(HttpStatus.OK)
  // A solve is the engine's most expensive call a school makes by hand.
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  plan(@Body() dto: PlanExamsDto, @CurrentUser() user: AuthenticatedUser): Promise<ExamProposal> {
    return this.planner.propose(dto, user);
  }

  @Post('plan/apply')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  apply(@Body() dto: ApplyExamPlanDto, @CurrentUser() user: AuthenticatedUser): Promise<ApplyResult> {
    return this.planner.apply(dto, user);
  }

  @Get()
  list(@Query() query: ExamListQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<ExamView[]> {
    return this.exams.list(query.academicYearId, user);
  }

  @Post()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  create(@Body() dto: CreateExamDto, @CurrentUser() user: AuthenticatedUser): Promise<ExamView> {
    return this.exams.create(dto, user);
  }

  @Patch(':id')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateExamDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ExamView> {
    return this.exams.update(id, dto, user);
  }

  @Post(':id/unplan')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  unplan(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ removed: true }> {
    return this.planner.unplan(id, user);
  }

  @Delete(':id')
  remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ removed: true }> {
    return this.exams.remove(id, user);
  }
}
