import {
  Body,
  Controller,
  Delete,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
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
  type CreateMasterLessonResult,
  type DeleteMasterLessonResult,
  type LockBlockResult,
  type MoveBlockCardResult,
  type UpdateMasterLessonResult,
} from './master-lessons.service';
import { CreateMasterLessonDto } from './dto/create-master-lesson.dto';
import { LockBlockDto, MoveBlockCardDto } from './dto/block-card.dto';
import { UpdateMasterLessonDto } from './dto/update-master-lesson.dto';

@Controller('api/v1/master-lessons')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class MasterLessonsController {
  constructor(private readonly masterLessons: MasterLessonsService) {}

  /**
   * `POST /api/v1/master-lessons` — manually add a timetable slot. Validated
   * against the rest of the timetable; responds 409 with a conflict list when
   * the new slot would double-book.
   */
  @Post()
  create(
    @Body() dto: CreateMasterLessonDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CreateMasterLessonResult> {
    return this.masterLessons.create(dto, user);
  }

  /**
   * `PATCH /api/v1/master-lessons/block-card` — move a parallel block's card,
   * the lessons of its members that stand in one slot, to another slot as one
   * move. Validated against the rest of the timetable like a single lesson;
   * responds 409 with a conflict list when any member would double-book, 409
   * BLOCK_CARD_STALE when the lessons no longer stand together, and 400
   * NOT_A_BLOCK_CARD for lessons that are not one block's card. Declared
   * before `:id`, whose UUID pipe would refuse the word.
   */
  @Patch('block-card')
  moveBlockCard(
    @Body() dto: MoveBlockCardDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MoveBlockCardResult> {
    return this.masterLessons.moveBlockCard(dto, user);
  }

  /**
   * `PATCH /api/v1/master-lessons/block-lock` — lock or unlock every lesson of
   * a parallel block (or those named among them): the generation refuses a
   * block that is partly locked.
   */
  @Patch('block-lock')
  lockBlock(
    @Body() dto: LockBlockDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<LockBlockResult> {
    return this.masterLessons.lockBlock(dto, user);
  }

  /**
   * `PATCH /api/v1/master-lessons/:id` — manually adjust a timetable slot
   * (day, time, room, teacher, lock state). Validated against the rest of the
   * timetable; responds 409 with a conflict list when the change would
   * double-book.
   */
  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateMasterLessonDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<UpdateMasterLessonResult> {
    return this.masterLessons.update(id, dto, user);
  }

  /**
   * `DELETE /api/v1/master-lessons/:id` — remove a timetable slot together
   * with its future, attendance-free calendar lessons. Past lessons and
   * lessons with recorded attendance are preserved.
   */
  @Delete(':id')
  remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DeleteMasterLessonResult> {
    return this.masterLessons.remove(id, user);
  }
}
