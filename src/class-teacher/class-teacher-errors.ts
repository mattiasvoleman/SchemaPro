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

/**
 * The coded 403/404 for a frame reason: the web translates by `params.reason`,
 * the message is for a plain client. The global filter forwards a problem's
 * `code` and its FLAT `params` and nothing else of the body, so the reason
 * rides in `params`: a field of its own would be dropped on the way out.
 */
export function frameRefusal(reason: FrameReason): HttpException {
  if (reason === 'NOT_APPOINTED') {
    return new ForbiddenException({ message: FRAME_MESSAGES[reason], code: CODES.NOT_APPOINTED, params: { reason } });
  }
  if (reason === 'LESSON_GONE') {
    return new NotFoundException({ message: FRAME_MESSAGES[reason], code: CODES.GONE, params: { reason } });
  }
  return new ForbiddenException({ message: FRAME_MESSAGES[reason], code: CODES.OUTSIDE_FRAME, params: { reason } });
}

/**
 * 409: the lesson is not what the page read. `params.version` is the lesson as
 * it is now (the page reads the week again and gets the rest), `params.changed`
 * the names of the fields that differ when the draft saw something to compare
 * with. Flat on purpose: see `frameRefusal`.
 */
export function staleLesson(detail: { changed?: FieldChange[]; current?: { version: string } }): ConflictException {
  const params: Record<string, string> = {};
  if (detail.current) params.version = detail.current.version;
  const names = (detail.changed ?? []).map((change) => change.field).join(',');
  if (names) params.changed = names.slice(0, 200);
  return new ConflictException({
    message: 'Lektionen har ändrats sedan du läste den. Läs om den och försök igen.',
    code: CODES.STALE,
    ...(Object.keys(params).length > 0 ? { params } : {}),
  });
}

/** 409: the draft is at another revision than the one the page edited. `params.rev` is the revision it is at now. */
export function staleDraft(current: { rev: number }): ConflictException {
  return new ConflictException({
    message: 'Utkastet har ändrats av någon annan. Läs om det och försök igen.',
    code: CODES.REV,
    params: { rev: current.rev },
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
