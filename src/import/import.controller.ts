import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { ImportService } from './import.service';
import {
  ImportGroupsDto,
  ImportMembershipsDto,
  ImportRequirementsDto,
  ImportRoomTypesDto,
  ImportSubjectsDto,
  ImportStudentsDto,
  ImportTeacherDutiesDto,
  ImportTeacherQualificationsDto,
  ImportTeachersDto,
  ImportTimplanDto,
} from './dto/import.dto';

/**
 * CSV import endpoints. The browser parses the file (web/lib/csv.ts) and posts
 * typed rows; templates are generated client-side, so download needs no
 * endpoint. People imports fan out one Supabase invite per created row —
 * throttled hard, since a single request already represents up to 500 invites.
 */
@Controller('api/v1/import')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Throttle({ default: { limit: 10, ttl: 60_000 } })
export class ImportController {
  constructor(private readonly imports: ImportService) {}

  @Post('teachers')
  importTeachers(@Body() dto: ImportTeachersDto, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.importTeachers(dto, user);
  }

  @Post('students')
  importStudents(@Body() dto: ImportStudentsDto, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.importStudents(dto, user);
  }

  @Post('groups')
  importGroups(@Body() dto: ImportGroupsDto, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.importGroups(dto, user);
  }

  @Post('subjects')
  importSubjects(@Body() dto: ImportSubjectsDto, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.importSubjects(dto, user);
  }

  @Post('room-types')
  importRoomTypes(
    @Body() dto: ImportRoomTypesDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.imports.importRoomTypes(dto, user);
  }

  @Post('group-members')
  importMemberships(
    @Body() dto: ImportMembershipsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.imports.importMemberships(dto, user);
  }

  /**
   * Behörigheter per teacher and subject. Updates a changed span or kind like
   * the timplan import, for the same reason: a behörighetslista is a document
   * a school keeps editing, not a set of things that exist or do not.
   */
  @Post('teacher-qualifications')
  importTeacherQualifications(
    @Body() dto: ImportTeacherQualificationsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.imports.importTeacherQualifications(dto, user);
  }

  /**
   * Uppdrag per teacher for one läsår. Updates a changed figure like the
   * behörigheter; never a blocked time — see the service.
   */
  @Post('teacher-duties')
  importTeacherDuties(
    @Body() dto: ImportTeacherDutiesDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.imports.importTeacherDuties(dto, user);
  }

  /**
   * A lokal timplan's cells into a DRAFT plan; updates changed cells like the
   * requirements import. 409 for a decided plan — see the service.
   */
  @Post('timplan')
  importTimplan(@Body() dto: ImportTimplanDto, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.importTimplan(dto, user);
  }

  /** The timplan also updates existing rows — see the service. */
  @Post('requirements')
  importRequirements(
    @Body() dto: ImportRequirementsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.imports.importRequirements(dto, user);
  }
}
