import { ConflictException } from '@nestjs/common';
import type { LessonRecurrence } from '@prisma/client';
import { toWallClock } from '../common/utils/time';
import type { ExpectedLessonDto } from './dto/update-master-lesson.dto';
import { exemptionsOf } from './lesson-exemption';

/*
 * SÄKERHETSNÄT (E9): "den här lektionen har ändrats av någon annan sedan sidan läste den".
 *
 * A PATCH of a lesson may carry what the page saw of it (UpdateMasterLessonDto.expected). The write is then held to it under the lesson's row
 * lock, in the transaction that writes: a value that is not what the page read is somebody else's change, and the request is refused with the
 * names of the fields instead of putting its own value over it. The check is of values, never of a time stamp: see ExpectedLessonDto.
 */

/** The problem `code` of a write that would put a value over one somebody else changed since the page read the lesson. */
export const LESSON_CHANGED = 'LESSON_CHANGED';

/** The fields a page can say it saw, in the order a refusal names them. */
export const EXPECTED_FIELDS = [
  'dayOfWeek',
  'startTime',
  'endTime',
  'roomId',
  'teacherId',
  'coTeacherId',
  'isLocked',
  'isParked',
  'recurrence',
  'startDate',
  'endDate',
  'extraGroupIds',
  'studentIds',
  'exempt',
] as const satisfies ReadonlyArray<keyof ExpectedLessonDto>;

/** A lesson as the write read it: the columns the page can have seen, with its extra classes and its named pupils. */
export interface LessonAsStored {
  dayOfWeek: number;
  startTime: Date;
  endTime: Date;
  roomId: string | null;
  teacherId: string | null;
  coTeacherId: string | null;
  isLocked: boolean;
  isParked: boolean;
  recurrence: LessonRecurrence;
  startDate: Date | null;
  endDate: Date | null;
  exemptFrom: readonly string[];
  extraGroups: ReadonlyArray<{ studentGroupId: string }>;
  participants: ReadonlyArray<{ studentId: string }>;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => new Set(a).size === new Set(b).size && a.every((item) => new Set(b).has(item));

const dayOf = (date: Date | null): string | null => (date ? date.toISOString().slice(0, 10) : null);

/** Two values of one field: a list as a set, anything else as it is. */
const same = (a: unknown, b: unknown): boolean => (Array.isArray(a) ? Array.isArray(b) && sameSet(a as string[], b as string[]) : a === b);

/** What a request writes into a field, in the form the lesson holds it: a day is its first ten characters (parseDateOrNull), and no day at all is null. */
const asHeld = (field: (typeof EXPECTED_FIELDS)[number], value: unknown): unknown =>
  (field === 'startDate' || field === 'endDate') && typeof value === 'string' ? (value === '' ? null : value.slice(0, 10)) : value;

/**
 * The fields the page named whose value is not the one stored now, in EXPECTED_FIELDS' order. Empty: the lesson is as the page saw it.
 * A field the request leaves out is not asked about, and `undefined` is "left out" while `null` is an answer (no room, no first day).
 *
 * `writes` is what the request itself sets. A field it sets to the value that already stands is nothing written over, whatever the page saw: a save
 * that is sent twice, a lock a colleague has just set too, a move made twice (granskaren g515). Without it the second of two equal requests was
 * refused as "somebody else has changed the lesson" for a change it had made itself, and a bulk lock stopped at the first lesson that was locked.
 */
export function changedSince(stored: LessonAsStored, expected: ExpectedLessonDto, writes: ExpectedLessonDto = {}): string[] {
  const now: Record<(typeof EXPECTED_FIELDS)[number], unknown> = {
    dayOfWeek: stored.dayOfWeek,
    startTime: toWallClock(stored.startTime),
    endTime: toWallClock(stored.endTime),
    roomId: stored.roomId,
    teacherId: stored.teacherId,
    coTeacherId: stored.coTeacherId,
    isLocked: stored.isLocked,
    isParked: stored.isParked,
    recurrence: stored.recurrence,
    startDate: dayOf(stored.startDate),
    endDate: dayOf(stored.endDate),
    extraGroupIds: stored.extraGroups.map((entry) => entry.studentGroupId),
    studentIds: stored.participants.map((entry) => entry.studentId),
    exempt: exemptionsOf(stored.exemptFrom),
  };
  return EXPECTED_FIELDS.filter((field) => {
    const saw = expected[field];
    if (saw === undefined) return false;
    const holds = now[field];
    if (same(saw, holds)) return false;
    const sets = writes[field];
    return sets === undefined || !same(asHeld(field, sets), holds);
  });
}

/**
 * The 409 of a lesson that is not as the page saw it. `fields` is the names, comma-joined (a problem forwards flat params and nothing nested):
 * the page reads the lesson again for what it is now and says what happened.
 */
export function lessonChanged(fields: readonly string[]): ConflictException {
  return new ConflictException({
    message: 'Lektionen har ändrats av någon annan sedan sidan läste den. Din ändring gjordes inte.',
    code: LESSON_CHANGED,
    params: { fields: fields.join(',') },
  });
}
