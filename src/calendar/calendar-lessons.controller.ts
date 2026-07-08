import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  CalendarLessonsService,
  type LessonActionResult,
} from './calendar-lessons.service';
import { AssignSubstituteDto, CancelLessonDto } from './dto/lesson-action.dto';

/**
 * Day-to-day lesson operations for school admins: cancel, reinstate and
 * assign a substitute teacher. All actions broadcast realtime updates.
 */
@Controller('api/v1/calendar-lessons')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class CalendarLessonsController {
  constructor(private readonly lessons: CalendarLessonsService) {}

  @Patch(':id/cancel')
  cancel(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: CancelLessonDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<LessonActionResult> {
    return this.lessons.cancel(id, dto, user);
  }

  @Patch(':id/reinstate')
  reinstate(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<LessonActionResult> {
    return this.lessons.reinstate(id, user);
  }

  @Patch(':id/substitute')
  assignSubstitute(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: AssignSubstituteDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<LessonActionResult> {
    return this.lessons.assignSubstitute(id, dto, user);
  }
}
