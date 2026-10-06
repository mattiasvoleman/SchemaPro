import {
  Body,
  Controller,
  Get,
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
  TeacherQualificationsService,
  type TeacherQualificationResponse,
} from './teacher-qualifications.service';
import { ReplaceTeacherQualificationsDto } from './dto/teacher-qualification.dto';

/**
 * Lärarnas behörigheter.
 *
 * Staff read the whole school's list — the table's staff_select arm, because a
 * colleague's behörighet is not secret and the substitute picker ranks on it.
 * Only an admin writes, and writes the teacher's whole list at once (the
 * student-group members pattern): the form saves what it shows, a repeated
 * PUT is a no-op, and an empty list takes every behörighet away.
 */
@Controller('api/v1/teacher-qualifications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
export class TeacherQualificationsController {
  constructor(private readonly qualifications: TeacherQualificationsService) {}

  /** `?userId=` narrows to one teacher; without it, the school. */
  @Get()
  list(
    @Query('userId', new ParseUUIDPipe({ version: '4', optional: true }))
    userId: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TeacherQualificationResponse[]> {
    return this.qualifications.list(userId, user);
  }

  @Put(':userId')
  @Roles(Role.SCHOOL_ADMIN)
  replace(
    @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
    @Body() dto: ReplaceTeacherQualificationsDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TeacherQualificationResponse[]> {
    return this.qualifications.replace(userId, dto, user);
  }
}
