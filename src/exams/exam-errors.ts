import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';

/*
 * Provplanering's named refusals. A code the web says in the reader's language
 * (the sentence beside it is the Swedish fallback); the gateway's own reasons
 * for an exam it could not even ask the engine about are in exam-reasons.ts.
 */
export const EXAM_PLANNING_OFF = 'EXAM_PLANNING_OFF';
export const EXAM_NO_REPLACEMENT_SUBJECT = 'EXAM_NO_REPLACEMENT_SUBJECT';
export const EXAM_REPLACEMENT_SUBJECT_COUNTS = 'EXAM_REPLACEMENT_SUBJECT_COUNTS';
export const EXAM_NO_ROOMS = 'EXAM_NO_ROOMS';
export const EXAM_NOT_FOUND = 'EXAM_NOT_FOUND';
export const EXAM_IS_PLANNED = 'EXAM_IS_PLANNED';
export const EXAM_STALE = 'EXAM_STALE';
export const EXAM_SUBJECT = 'EXAM_SUBJECT';
export const EXAM_GROUPS = 'EXAM_GROUPS';
export const EXAM_WINDOW = 'EXAM_WINDOW';
export const EXAM_ROOM = 'EXAM_ROOM';
export const EXAM_PLACEMENT = 'EXAM_PLACEMENT';
export const EXAM_ROOM_TAKEN = 'EXAM_ROOM_TAKEN';
export const EXAM_NOT_PLANNED = 'EXAM_NOT_PLANNED';
export const EXAM_BUSY = 'EXAM_BUSY';
export const EXAM_TOO_MANY = 'EXAM_TOO_MANY';

export const badExam = (code: string, message: string, params?: Record<string, string | number>) =>
  new BadRequestException({ message, code, ...(params ? { params } : {}) });

export const conflictingExam = (code: string, message: string, params?: Record<string, string | number>) =>
  new ConflictException({ message, code, ...(params ? { params } : {}) });

export const forbiddenExam = (code: string, message: string) => new ForbiddenException({ message, code });

export const missingExam = () => new NotFoundException({ message: 'Provet finns inte.', code: EXAM_NOT_FOUND });
