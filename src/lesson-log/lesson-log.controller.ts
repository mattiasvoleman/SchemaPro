import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Area } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { ClassBookService, type ClassBook } from './class-book.service';
import { ClassBookQueryDto, LessonLogRangeQueryDto, PutLessonLogDto, PutSubstituteNoteDto } from './dto/lesson-log.dto';
import {
  LessonLogService,
  type HandedOverLesson,
  type LessonLogEntry,
  type LessonLogLessonView,
  type LessonLogText,
  type SubstituteNoteText,
} from './lesson-log.service';

/**
 * Lektionslogg (20261203090000).
 *
 *   GET lesson-logs                  the caller's own lessons' logs over a
 *                                    range: a pupil's, a teacher's with their
 *                                    notes to the substitute
 *   GET lesson-logs/handed-over      the lessons the calling teacher handed
 *                                    over for an absence, which took them off
 *                                    the lesson: their way back to its note
 *   GET lesson-logs/lessons/:id      one lesson for its page: the log, the
 *                                    note when the caller may read it, and
 *                                    what the caller may change
 *   PUT lesson-logs/lessons/:id      the log, whole
 *   PUT lesson-logs/lessons/:id/substitute-note
 *                                    the note to the substitute
 *   GET lesson-logs/class-book       klassboken: a class's lessons over a
 *                                    period, throttled like the print set
 *
 * A guardian reads the log in the family's week (GET family/schedule). An
 * administrator's write of a log is DRIFT's, as the calendar's. The note is
 * the lesson's own teacher's to write and its teachers' to read; no
 * administrator does either (the cover board says that one exists).
 */
@Controller('api/v1/lesson-logs')
@UseGuards(JwtAuthGuard, RolesGuard)
@Area('DRIFT')
export class LessonLogController {
  constructor(
    private readonly logs: LessonLogService,
    private readonly classBooks: ClassBookService,
  ) {}

  @Get()
  @Roles(Role.STUDENT, Role.TEACHER)
  list(@Query() query: LessonLogRangeQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<{ entries: LessonLogEntry[] }> {
    return this.logs.listForCaller(query, user);
  }

  /** The lessons the calling teacher handed over for an absence, so they can still leave the note. */
  @Get('handed-over')
  @Roles(Role.TEACHER)
  handedOver(@Query() query: LessonLogRangeQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<{ lessons: HandedOverLesson[] }> {
    return this.logs.handedOver(query, user);
  }

  @Get('class-book')
  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  classBook(@Query() query: ClassBookQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<ClassBook> {
    return this.classBooks.classBook(query, user);
  }

  @Get('lessons/:id')
  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN)
  lesson(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<LessonLogLessonView> {
    return this.logs.lesson(id, user);
  }

  @Put('lessons/:id')
  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  putLog(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: PutLessonLogDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ log: LessonLogText | null }> {
    return this.logs.putLog(id, dto, user);
  }

  @Put('lessons/:id/substitute-note')
  @Roles(Role.TEACHER)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  putNote(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: PutSubstituteNoteDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ note: SubstituteNoteText | null }> {
    return this.logs.putNote(id, dto, user);
  }
}
