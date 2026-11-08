import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { ClassTeacherService, type MineView, type PreviewView, type WeekView } from './class-teacher.service';
import type { ChangeView, PublishOutcome, Verdict } from './class-teacher.types';
import { CreateChangeDto, PreviewChangeDto, PublishDto, RevQueryDto, UpdateChangeDto, WeekQueryDto } from './dto/class-teacher.dto';

/**
 * Klasslärarens schema, a teacher's routes. A teacher is klasslärare of the
 * classes an administrator has appointed them to and of no other: every route
 * names a class, and the service answers 403 CLASS_TEACHER_NOT_APPOINTED for one
 * that is not theirs. What a draft may be is the frame's (the database's
 * app.class_teacher_frame, the same in row security), not this controller's.
 */
@Controller('api/v1/class-teacher')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.TEACHER)
export class ClassTeacherController {
  constructor(private readonly service: ClassTeacherService) {}

  /** The classes the caller is klasslärare of, and whether the school lets them publish. */
  @Get('mine')
  mine(@CurrentUser() user: AuthenticatedUser): Promise<MineView> {
    return this.service.mine(user);
  }

  /** A week of the class: the dated lessons and the grundschema, each with the frame's verdict, and the class's drafts. */
  @Get('classes/:classId/week')
  week(
    @Param('classId', new ParseUUIDPipe({ version: '4' })) classId: string,
    @Query() query: WeekQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WeekView> {
    return this.service.week(classId, query, user);
  }

  @Post('classes/:classId/changes')
  create(
    @Param('classId', new ParseUUIDPipe({ version: '4' })) classId: string,
    @Body() dto: CreateChangeDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ChangeView> {
    return this.service.create(classId, dto, user);
  }

  @Patch('classes/:classId/changes/:changeId')
  update(
    @Param('classId', new ParseUUIDPipe({ version: '4' })) classId: string,
    @Param('changeId', new ParseUUIDPipe({ version: '4' })) changeId: string,
    @Body() dto: UpdateChangeDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ChangeView> {
    return this.service.update(classId, changeId, dto, user);
  }

  @Delete('classes/:classId/changes/:changeId')
  @HttpCode(204)
  async discard(
    @Param('classId', new ParseUUIDPipe({ version: '4' })) classId: string,
    @Param('changeId', new ParseUUIDPipe({ version: '4' })) changeId: string,
    @Query() query: RevQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.service.discard(classId, changeId, query.rev, user);
  }

  /** Every waiting draft of the class, judged by the check the schemaläggare's editor makes. */
  @Get('classes/:classId/check')
  check(
    @Param('classId', new ParseUUIDPipe({ version: '4' })) classId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Array<{ change: ChangeView; verdict: Verdict }>> {
    return this.service.check(classId, user);
  }

  /** A change tried and not written, for the conflicts to show while the klasslärare edits. */
  @Post('classes/:classId/preview')
  @HttpCode(200)
  preview(
    @Param('classId', new ParseUUIDPipe({ version: '4' })) classId: string,
    @Body() dto: PreviewChangeDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PreviewView> {
    return this.service.preview(classId, dto, user);
  }

  /** Publishes the class's drafts, when the school lets a klasslärare (403 CLASS_TEACHER_PUBLISH_OFF otherwise). */
  @Post('classes/:classId/publish')
  @HttpCode(200)
  publish(
    @Param('classId', new ParseUUIDPipe({ version: '4' })) classId: string,
    @Body() dto: PublishDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ outcomes: PublishOutcome[] }> {
    return this.service.publish(classId, dto, user);
  }
}
