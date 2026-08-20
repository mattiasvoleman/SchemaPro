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
  ImportRoomTypesDto,
  ImportSubjectsDto,
  ImportStudentsDto,
  ImportTeachersDto,
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
}
