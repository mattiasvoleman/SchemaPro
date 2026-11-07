import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Area } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { MoveCandidatesQueryDto, MoveLessonPupilDto } from './dto/lesson-moves.dto';
import { LessonMovesService, type LessonMovesView, type MoveCandidates, type MoveResult } from './lesson-moves.service';

const uuid = () => new ParseUUIDPipe({ version: '4' });

/**
 * Elevens lektion för dagen: move one pupil to a parallel lesson for a day.
 *
 * A TEACHER and a SCHOOL_ADMIN (Drift) may ask; whether this login may move this
 * pupil is the service's and the database's question (a teacher of one of the
 * two lessons, or the pupil's mentor that day). The läsare is turned away by the
 * area as for every write.
 */
@Controller('api/v1/lesson-moves')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.TEACHER, Role.SCHOOL_ADMIN)
@Area('DRIFT')
export class LessonMovesController {
  constructor(private readonly moves: LessonMovesService) {}

  /** `GET /api/v1/lesson-moves/lessons/:lessonId/candidates?studentId`: where the pupil can go from this lesson. */
  @Get('lessons/:lessonId/candidates')
  candidates(
    @Param('lessonId', uuid()) lessonId: string,
    @Query() query: MoveCandidatesQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MoveCandidates> {
    return this.moves.candidates(lessonId, query.studentId, user);
  }

  /** `GET /api/v1/lesson-moves/lessons/:lessonId`: the pupils this lesson lost and gained for the day. */
  @Get('lessons/:lessonId')
  forLesson(@Param('lessonId', uuid()) lessonId: string, @CurrentUser() user: AuthenticatedUser): Promise<LessonMovesView> {
    return this.moves.forLesson(lessonId, user);
  }

  /** `POST /api/v1/lesson-moves`: move the pupil, or send them back to where they started. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  move(@Body() dto: MoveLessonPupilDto, @CurrentUser() user: AuthenticatedUser): Promise<MoveResult> {
    return this.moves.move(dto.studentId, dto.fromLessonId, dto.toLessonId, user);
  }

  /** `DELETE /api/v1/lesson-moves/:id`: Ångra. */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  undo(@Param('id', uuid()) id: string, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.moves.undo(id, user);
  }
}
