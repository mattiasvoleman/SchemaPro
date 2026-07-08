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
  MasterLessonsService,
  type UpdateMasterLessonResult,
} from './master-lessons.service';
import { UpdateMasterLessonDto } from './dto/update-master-lesson.dto';

@Controller('api/v1/master-lessons')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class MasterLessonsController {
  constructor(private readonly masterLessons: MasterLessonsService) {}

  /**
   * `PATCH /api/v1/master-lessons/:id` — manually adjust a timetable slot
   * (day, time, room, teacher). Validated against the rest of the timetable;
   * responds 409 with a conflict list when the change would double-book.
   */
  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateMasterLessonDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<UpdateMasterLessonResult> {
    return this.masterLessons.update(id, dto, user);
  }
}
