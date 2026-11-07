import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { sqlStateOf } from '../cover/cover-errors';
import { isWriteConflict, writeConflict } from '../common/utils/prisma-errors';
import { isLockTimeout, publishInProgress } from '../publication/publish-mode';
import { CODES, FRAME_MESSAGES, type FieldChange, type FrameReason } from './class-teacher.types';

/** The coded 403/404 for a frame reason: the web translates by `reason`, the message is for a plain client. */
export function frameRefusal(reason: FrameReason): HttpException {
  if (reason === 'NOT_APPOINTED') {
    return new ForbiddenException({ message: FRAME_MESSAGES[reason], code: CODES.NOT_APPOINTED, reason });
  }
  if (reason === 'LESSON_GONE') {
    return new NotFoundException({ message: FRAME_MESSAGES[reason], code: CODES.GONE, reason });
  }
  return new ForbiddenException({ message: FRAME_MESSAGES[reason], code: CODES.OUTSIDE_FRAME, reason });
}

/** 409: the lesson is not what the page read. `changed` is what the draft saw against what is now, when it saw something. */
export function staleLesson(detail: { changed?: FieldChange[]; current?: { version: string; snapshot: Record<string, unknown> } }): ConflictException {
  return new ConflictException({
    message: 'Lektionen har ändrats sedan du läste den. Läs om den och försök igen.',
    code: CODES.STALE,
    ...detail,
  });
}

export function appointerGone(): ConflictException {
  return new ConflictException({
    message: 'Den som utsåg dig kan inte längre ändra schemat. Be en schemaläggare utse dig på nytt.',
    code: CODES.APPOINTER_GONE,
  });
}

/**
 * The database's own refusals on the klasslärare's tables, as coded answers
 * before they reach the global filter. A Postgres error here carries a row;
 * what the answer names is a code and at most a constraint.
 */
export function rethrowClassTeacherError(error: unknown): never {
  if (error instanceof HttpException) throw error;
  if (isLockTimeout(error)) throw publishInProgress();
  if (isWriteConflict(error)) throw writeConflict();
  switch (sqlStateOf(error)) {
    case 'CT403':
      throw frameRefusal('NOT_APPOINTED');
    case 'CT404':
      throw frameRefusal('LESSON_GONE');
    case 'CT409':
      throw staleLesson({});
    case 'CT422':
      throw appointerGone();
    case 'CT400':
    case '23514':
      throw new BadRequestException({ message: 'Ändringen är inte giltig.', code: 'CLASS_TEACHER_INVALID' });
    case '42501':
      // Row security refused what the frame had not named first: a race with a closing hour, say.
      throw new ForbiddenException({ message: 'Ändringen ligger utanför det du får ändra.', code: CODES.OUTSIDE_FRAME });
    default:
      throw error;
  }
}
