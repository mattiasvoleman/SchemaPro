import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
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
  TeacherEmploymentsService,
  type TeacherEmploymentResponse,
  type TeacherHistoryResponse,
} from './teacher-employments.service';
import { UpsertTeacherEmploymentDto } from './dto/teacher-employment.dto';

const uuid = () => new ParseUUIDPipe({ version: '4' });

/**
 * Lärarnas tjänster per läsår.
 *
 * TEACHER IS IN THE CLASS ROLES FOR THE LIST ONLY. The service hands a teacher
 * their own row and nothing else, and the table's teacher_own_select arm says
 * the same for the writers that never pass through here. The two writes carry
 * their own @Roles(SCHOOL_ADMIN): a teacher does not set their own percentage,
 * and the table has no teacher write arm to let them — so a teacher's PUT stops
 * at the guard, with a 403 that names the role rather than a 404 that pretends
 * the colleague does not exist.
 *
 * KEYED ON TEACHER AND YEAR, both in the URL. One row per pair, so PUT on the
 * pair is the whole write surface, as with the work rules — but per year, because
 * a tjänstgöringsgrad is renegotiated every August.
 */
@Controller('api/v1/teacher-employments')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
export class TeacherEmploymentsController {
  constructor(private readonly employments: TeacherEmploymentsService) {}

  @Get()
  list(
    @Query('academicYearId', uuid()) academicYearId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TeacherEmploymentResponse[]> {
    return this.employments.list(academicYearId, user);
  }

  /**
   * `/:userId/history?academicYearId=` — the teacher's tjänst for the year,
   * version by version (staffing Fas 3). The admin reads any teacher; a
   * teacher their own, and a colleague's is 403.
   */
  @Get(':userId/history')
  history(
    @Param('userId', uuid()) userId: string,
    @Query('academicYearId', uuid()) academicYearId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TeacherHistoryResponse> {
    return this.employments.history(userId, academicYearId, user);
  }

  @Put(':userId')
  @Roles(Role.SCHOOL_ADMIN)
  upsert(
    @Param('userId', uuid()) userId: string,
    @Query('academicYearId', uuid()) academicYearId: string,
    @Body() dto: UpsertTeacherEmploymentDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TeacherEmploymentResponse> {
    return this.employments.upsert(userId, academicYearId, dto, user);
  }

  @Delete(':userId')
  @Roles(Role.SCHOOL_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('userId', uuid()) userId: string,
    @Query('academicYearId', uuid()) academicYearId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.employments.remove(userId, academicYearId, user);
  }
}
