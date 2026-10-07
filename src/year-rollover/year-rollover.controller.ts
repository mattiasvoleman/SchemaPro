import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  ExecuteActivationDto,
  ExecuteRolloverDto,
  ExecuteStaffingRolloverDto,
  RolloverOptionsDto,
} from './dto/year-rollover.dto';
import { StaffingRolloverService } from './staffing-rollover.service';
import { YearRolloverService } from './year-rollover.service';

/**
 * Läsårsrullning and activation, beside the year's own CRUD
 * (AcademicYearsController) under the same prefix. SCHOOL_ADMIN only: both
 * write a whole year at once, and the activation moves every pupil's class.
 *
 * Each operation is a POST preview, which writes nothing and answers 200 with
 * a plan and its planHash, and a POST execute that takes the hash back.
 *
 * GET :id/rosters is the year's förberäknade klasslistor: the home class its
 * activation would give each pupil it moves (projected-rosters.ts). Pupil ids
 * only, and the admin's: the class lists of next year are not a teacher's to
 * browse, although the teacher-facing reports compute from them.
 *
 * POST :id/staffing-rollover(/preview) carries tjänster and uppdrag into a
 * year that was rolled without them; `:id` is that year, the TARGET, and the
 * source is its predecessor (staffing-rollover.service.ts). Admin only, like
 * the rest: the preview lists every teacher's post and uppdrag.
 */
@Controller('api/v1/academic-years')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class YearRolloverController {
  constructor(
    private readonly rollover: YearRolloverService,
    private readonly staffing: StaffingRolloverService,
  ) {}

  @Post(':id/rollover/preview')
  @HttpCode(HttpStatus.OK)
  previewRollover(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: RolloverOptionsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.rollover.previewRollover(id, dto, user);
  }

  @Post(':id/rollover')
  executeRollover(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ExecuteRolloverDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.rollover.executeRollover(id, dto, user);
  }

  @Get(':id/rosters')
  rosters(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.rollover.rosters(id, user);
  }

  @Post(':id/staffing-rollover/preview')
  @HttpCode(HttpStatus.OK)
  previewStaffingRollover(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.staffing.preview(id, user);
  }

  @Post(':id/staffing-rollover')
  executeStaffingRollover(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ExecuteStaffingRolloverDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.staffing.execute(id, dto.planHash, user);
  }

  @Post(':id/activation/preview')
  @HttpCode(HttpStatus.OK)
  previewActivation(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.rollover.previewActivation(id, user);
  }

  @Post(':id/activation')
  @HttpCode(HttpStatus.OK)
  executeActivation(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ExecuteActivationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.rollover.executeActivation(id, dto, user);
  }
}
