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
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  SchoolBreaksService,
  type SchoolBreakResponse,
  type SchoolBreakWriteResult,
} from './school-breaks.service';
import {
  CreateSchoolBreakDto,
  UpdateSchoolBreakDto,
} from './dto/school-break.dto';

/**
 * Lov och studiedagar — the days the läsår has but the timetable does not.
 *
 * Admin-only for the whole controller, including the list. The table's own RLS
 * lets every member of the school SELECT a break, because a lov is not
 * confidential and is the reason a pupil's calendar is empty that week — but
 * pupils and guardians read it straight from Supabase like every other
 * catalog table. This route exists for the admin UI that also writes, and it
 * carries the same guard as its neighbours here rather than a second, looser
 * one that would have to be kept in step with the policy by hand.
 */
@Controller('api/v1/school-breaks')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class SchoolBreaksController {
  constructor(private readonly breaks: SchoolBreaksService) {}

  /** `GET /api/v1/school-breaks?academicYearId=…` — the year's breaks. */
  @Get()
  list(
    @Query('academicYearId', new ParseUUIDPipe({ version: '4' }))
    academicYearId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SchoolBreakResponse[]> {
    return this.breaks.list(academicYearId, user);
  }

  /**
   * The response carries `removedCalendarLessons`, which is not decoration:
   * saving a lov deletes published lessons, and the caller is the only one in
   * a position to tell the admin so while they are still looking at the form.
   */
  @Post()
  create(
    @Body() dto: CreateSchoolBreakDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SchoolBreakWriteResult> {
    return this.breaks.create(dto, user);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateSchoolBreakDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SchoolBreakWriteResult> {
    return this.breaks.update(id, dto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.breaks.remove(id, user);
  }
}
