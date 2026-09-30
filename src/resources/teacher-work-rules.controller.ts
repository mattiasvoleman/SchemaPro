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
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  TeacherWorkRulesService,
  type TeacherWorkRuleResponse,
} from './teacher-work-rules.service';
import { UpsertTeacherWorkRuleDto } from './dto/teacher-work-rule.dto';

/**
 * Lärarnas arbetstid — the lunch a teacher is owed and the rest between their
 * days.
 *
 * TEACHER IS IN @Roles, which every other controller in this folder leaves out.
 * That is the feature, not an oversight: these are per-teacher rules, and the
 * person who knows they cannot eat before 12:15 is the one teaching until then.
 * The route is not thereby open — `TeacherWorkRulesService.assertMayWrite`
 * refuses a teacher any row but their own, and
 * `teacher_work_rules_teacher_own` refuses it again in the database, for the
 * writers that never pass through here at all.
 *
 * KEYED ON THE TEACHER, not on the row's id. The table holds one row per teacher
 * (`@@unique([userId])`), so PUT on the person is the whole write surface: there
 * is nothing to create a second of, and no id a form has any reason to hold.
 * Deleting the row and writing one with every field null are the same fact, and
 * DELETE is the one that leaves nothing behind to misread.
 *
 * No academicYearId anywhere, like the frames and unlike the timplan: a person's
 * meal and a person's night belong to the person rather than to the curriculum,
 * and a rule keyed per year would be missing every August — at exactly the moment
 * a new timetable is generated.
 */
@Controller('api/v1/teacher-work-rules')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
export class TeacherWorkRulesController {
  constructor(private readonly rules: TeacherWorkRulesService) {}

  /**
   * The school's rules, a teacher's own among them.
   *
   * One list for both roles. A teacher reads their colleagues' rules as well,
   * which the table's `_staff_select` policy allows on purpose: a refused week
   * names the rule row that did not fit, and a teacher who cannot open it meets a
   * refusal with no visible cause.
   */
  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<TeacherWorkRuleResponse[]> {
    return this.rules.list(user);
  }

  @Put(':userId')
  upsert(
    @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
    @Body() dto: UpsertTeacherWorkRuleDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TeacherWorkRuleResponse> {
    return this.rules.upsert(userId, dto, user);
  }

  @Delete(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.rules.remove(userId, user);
  }
}
