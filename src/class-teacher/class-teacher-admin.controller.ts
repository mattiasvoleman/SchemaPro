import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Area } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  ClassTeacherAdminService,
  type AppointmentView,
  type DraftRowView,
  type OpenTimeView,
} from './class-teacher-admin.service';
import type { PublishOutcome } from './class-teacher.types';
import { AppointDto, ClassTeacherSettingsDto, DraftsQueryDto, OpenTimesDto, OpenTimesQueryDto, PublishDto } from './dto/class-teacher.dto';

/**
 * Klasslärarens schema, the administrators' routes. Every administrator reads;
 * the appointments and the open times are Schemaläggning's to write, the
 * school's option and the publication or discarding of a draft are
 * Publicering's. Which administrator an appointment runs as is the one who made
 * it (a second appointment of the same teacher to the same class takes it over).
 */
@Controller('api/v1/class-teachers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class ClassTeacherAdminController {
  constructor(private readonly service: ClassTeacherAdminService) {}

  @Get('appointments')
  appointments(@Query() query: OpenTimesQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<AppointmentView[]> {
    return this.service.appointments(query.academicYearId, user);
  }

  @Post('appointments')
  @HttpCode(200)
  @Area('SCHEMALAGGNING')
  appoint(@Body() dto: AppointDto, @CurrentUser() user: AuthenticatedUser): Promise<AppointmentView[]> {
    return this.service.appoint(dto, user);
  }

  @Delete('appointments/:id')
  @HttpCode(204)
  @Area('SCHEMALAGGNING')
  async remove(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.service.remove(id, user);
  }

  @Get('open-times')
  openTimes(@Query() query: OpenTimesQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<OpenTimeView[]> {
    return this.service.openTimes(query.academicYearId, user);
  }

  /** Replaces the open spans of one scope: one class's, or every class of the läsår's. */
  @Put('open-times')
  @Area('SCHEMALAGGNING')
  setOpenTimes(@Body() dto: OpenTimesDto, @CurrentUser() user: AuthenticatedUser): Promise<OpenTimeView[]> {
    return this.service.setOpenTimes(dto, user);
  }

  @Get('settings')
  settings(@CurrentUser() user: AuthenticatedUser): Promise<{ selfPublish: boolean }> {
    return this.service.settings(user);
  }

  @Put('settings')
  @Area('PUBLICERING')
  updateSettings(@Body() dto: ClassTeacherSettingsDto, @CurrentUser() user: AuthenticatedUser): Promise<{ selfPublish: boolean }> {
    return this.service.updateSettings(dto, user);
  }

  /** The waiting drafts, each judged as publication would judge it. */
  @Get('drafts')
  drafts(@Query() query: DraftsQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<DraftRowView[]> {
    return this.service.drafts(query.studentGroupId, user);
  }

  @Delete('drafts/:id')
  @HttpCode(204)
  @Area('PUBLICERING')
  async discard(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.service.discard(id, user);
  }

  /** Publishes a class's waiting drafts (or the ones named) through the editor's own services. */
  @Post('classes/:classId/publish')
  @HttpCode(200)
  @Area('SCHEMALAGGNING', 'DRIFT', 'PUBLICERING')
  publish(
    @Param('classId', new ParseUUIDPipe({ version: '4' })) classId: string,
    @Body() dto: PublishDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ outcomes: PublishOutcome[] }> {
    return this.service.publish(classId, dto.changeIds, user);
  }
}
