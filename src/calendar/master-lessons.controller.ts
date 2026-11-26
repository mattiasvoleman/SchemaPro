import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Area } from '../auth/decorators/area.decorator';
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
import { JudgeLessonsDto } from './dto/judge-lessons.dto';
import { PossibleTimesDto } from './dto/possible-times.dto';
import type { LessonJudgement } from './lesson-judge';
import { PossibleTimesService, type PossibleTimes } from './possible-times.service';

@Controller('api/v1/master-lessons')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Area('SCHEMALAGGNING', 'DRIFT')
export class MasterLessonsController {
  constructor(
    private readonly masterLessons: MasterLessonsService,
    private readonly possibleTimes: PossibleTimesService,
  ) {}

  /**
   * `POST /api/v1/master-lessons` — manually add a timetable slot. Validated
   * against the rest of the timetable and the rules a swap and a förläggning
   * are held to; responds 409 MASTER_LESSON_REFUSED, with the reason and the
   * other lesson's class, subject, day and time, when the new slot may not
   * stand.
   */
  @Post()
  create(
    @Body() dto: CreateMasterLessonDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CreateMasterLessonResult> {
    return this.masterLessons.create(dto, user);
  }

  /**
   * `POST /api/v1/master-lessons/judge` — whether one or more tänkta drag would
   * be let through, said the way a write says no (the reason and the other
   * lesson's class, subject, day and time), and nothing written. The moves are
   * judged together as one move. A POST because the question is a body, not
   * because it changes anything.
   */
  @Post('judge')
  @HttpCode(200)
  judge(@Body() dto: JudgeLessonsDto, @CurrentUser() user: AuthenticatedUser): Promise<LessonJudgement> {
    return this.masterLessons.judgeMoves(dto, user);
  }

  /**
   * `POST /api/v1/master-lessons/possible-times` — where a lesson (or a brick that is not a lesson yet) can stand: the times
   * the judge lets through, best first with the soft figures that rank them, the stretches a rule shuts (named by the rule),
   * and the lessons that hold the rest. Nothing written. A POST because the question is a body.
   */
  @Post('possible-times')
  @HttpCode(200)
  possible(@Body() dto: PossibleTimesDto, @CurrentUser() user: AuthenticatedUser): Promise<PossibleTimes> {
    return this.possibleTimes.possibleTimes(dto, user);
  }

  /**
   * `PATCH /api/v1/master-lessons/block-card` — move a parallel block's card,
   * the lessons of its members that stand in one slot, to another slot as one
   * move. Validated against the rest of the timetable like a single lesson;
   * responds 409 MASTER_LESSON_REFUSED when any member may not stand there, 409
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
   * timetable and the rules a swap and a förläggning are held to, a lesson that
   * already stands against one of the board's rules being let stand; responds
   * 409 MASTER_LESSON_REFUSED, with the reason and the other lesson's class,
   * subject, day and time, when the change may not stand.
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
