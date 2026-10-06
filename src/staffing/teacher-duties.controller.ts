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
import { TeacherDutiesService, type TeacherDutyResponse } from './teacher-duties.service';
import { CreateTeacherDutyDto, UpdateTeacherDutyDto } from './dto/teacher-duty.dto';

const uuid = () => new ParseUUIDPipe({ version: '4' });
const optionalUuid = () => new ParseUUIDPipe({ version: '4', optional: true });

/**
 * Lärarnas uppdrag per läsår.
 *
 * TEACHER IS IN THE CLASS ROLES FOR THE LIST ONLY, as on the posts: the
 * service hands a teacher their own uppdrag and nothing else, and the three
 * writes carry their own @Roles(SCHOOL_ADMIN) — an uppdrag is assigned, and a
 * teacher's write stops at the guard with a 403 that names the role.
 */
@Controller('api/v1/teacher-duties')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
export class TeacherDutiesController {
  constructor(private readonly duties: TeacherDutiesService) {}

  /** `?academicYearId=&userId=` — userId narrows an admin's list; a teacher's is their own. */
  @Get()
  list(
    @Query('academicYearId', uuid()) academicYearId: string,
    @Query('userId', optionalUuid()) userId: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TeacherDutyResponse[]> {
    return this.duties.list(academicYearId, userId, user);
  }

  @Post()
  @Roles(Role.SCHOOL_ADMIN)
  create(
    @Body() dto: CreateTeacherDutyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TeacherDutyResponse> {
    return this.duties.create(dto, user);
  }

  @Patch(':id')
  @Roles(Role.SCHOOL_ADMIN)
  update(
    @Param('id', uuid()) id: string,
    @Body() dto: UpdateTeacherDutyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TeacherDutyResponse> {
    return this.duties.update(id, dto, user);
  }

  @Delete(':id')
  @Roles(Role.SCHOOL_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', uuid()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.duties.remove(id, user);
  }
}
