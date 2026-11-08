import {
  LESSON_MOVE_ALREADY_ON_TARGET,
  LESSON_MOVE_HAS_ATTENDANCE,
  LESSON_MOVE_LESSON_NOT_HELD,
  LESSON_MOVE_LESSON_OVER,
  LESSON_MOVE_NOT_ALLOWED,
  LESSON_MOVE_NOT_FOUND,
  LESSON_MOVE_NOT_PARALLEL,
  LESSON_MOVE_REPLACED_BY_ACTIVITY,
  SQLSTATE_TO_CODE,
  conflictCodeOf,
  crowdedWarning,
  doubleBooks,
  isHeld,
  isOver,
  isReplacedByActivity,
  overlaps,
  refusalOf,
  type MoveLesson,
} from './lesson-move-rules';

const at = (hhmm: string) => new Date(`2026-11-10T${hhmm}:00.000Z`);
// Before every lesson of the file, so that none is over unless a test says so.
const NOW = at('08:00');
const lesson = (id: string, from: string, to: string, extra: Partial<MoveLesson> = {}): MoveLesson => ({
  id,
  status: 'SCHEDULED',
  cancelCause: null,
  startsAt: at(from),
  endsAt: at(to),
  ...extra,
});

describe('overlaps', () => {
  it('is true for lessons that share a minute, whichever starts first', () => {
    expect(overlaps(lesson('a', '09:00', '10:00'), lesson('b', '09:30', '10:30'))).toBe(true);
    expect(overlaps(lesson('b', '09:30', '10:30'), lesson('a', '09:00', '10:00'))).toBe(true);
    expect(overlaps(lesson('a', '09:00', '10:00'), lesson('b', '09:15', '09:45'))).toBe(true);
  });

  it('is false for lessons that only touch: a lesson ending at ten does not overlap one starting at ten', () => {
    expect(overlaps(lesson('a', '09:00', '10:00'), lesson('b', '10:00', '11:00'))).toBe(false);
    expect(overlaps(lesson('a', '09:00', '10:00'), lesson('b', '11:00', '12:00'))).toBe(false);
  });
});

describe('isOver', () => {
  it('is true for a lesson whose end has passed, and for one that ends exactly now', () => {
    expect(isOver(lesson('a', '08:00', '09:00'), at('09:01'))).toBe(true);
    expect(isOver(lesson('a', '08:00', '09:00'), at('09:00'))).toBe(true);
  });

  it('is false for a lesson that is running or has not started: the day is not the hour, but neither is the start', () => {
    expect(isOver(lesson('a', '08:00', '09:00'), at('08:59'))).toBe(false);
    expect(isOver(lesson('a', '09:00', '10:00'), at('08:00'))).toBe(false);
  });
});

describe('isHeld and isReplacedByActivity', () => {
  it('holds the statuses the delivered time counts, and no other', () => {
    expect(isHeld({ status: 'SCHEDULED' })).toBe(true);
    expect(isHeld({ status: 'COMPLETED' })).toBe(true);
    expect(isHeld({ status: 'CANCELLED' })).toBe(false);
    expect(isHeld({ status: 'RESCHEDULED' })).toBe(false);
  });

  it('calls a lesson replaced only when it is cancelled with the cause EVENT', () => {
    expect(isReplacedByActivity({ status: 'CANCELLED', cancelCause: 'EVENT' })).toBe(true);
    expect(isReplacedByActivity({ status: 'CANCELLED', cancelCause: 'MANUAL' })).toBe(false);
    expect(isReplacedByActivity({ status: 'SCHEDULED', cancelCause: 'EVENT' })).toBe(false);
  });
});

describe('refusalOf: why the pupil cannot go there', () => {
  const origin = lesson('x', '09:00', '10:00');

  it('lets a held lesson that overlaps the pupil’s own', () => {
    expect(refusalOf(origin, lesson('y', '09:00', '10:00'), NOW)).toBeNull();
    expect(refusalOf(origin, lesson('z', '09:30', '10:30'), NOW)).toBeNull();
  });

  it('names a lesson that does not overlap', () => {
    expect(refusalOf(origin, lesson('w', '11:00', '12:00'), NOW)).toEqual({ code: LESSON_MOVE_NOT_PARALLEL });
    expect(refusalOf(origin, lesson('w', '10:00', '11:00'), NOW)).toEqual({ code: LESSON_MOVE_NOT_PARALLEL });
  });

  it('names a lesson that is the pupil’s own', () => {
    expect(refusalOf(origin, origin, NOW)).toEqual({ code: LESSON_MOVE_NOT_PARALLEL });
  });

  it('names a cancelled or rescheduled target, and says it is the target', () => {
    expect(refusalOf(origin, lesson('c', '09:00', '10:00', { status: 'CANCELLED', cancelCause: 'MANUAL' }), NOW)).toEqual({
      code: LESSON_MOVE_LESSON_NOT_HELD,
      side: 'TO',
    });
    expect(refusalOf(origin, lesson('r', '09:00', '10:00', { status: 'RESCHEDULED' }), NOW)).toEqual({ code: LESSON_MOVE_LESSON_NOT_HELD, side: 'TO' });
  });

  it('names a lesson an activity has replaced, before it names a cancelled lesson', () => {
    expect(refusalOf(origin, lesson('e', '09:00', '10:00', { status: 'CANCELLED', cancelCause: 'EVENT' }), NOW)).toEqual({
      code: LESSON_MOVE_REPLACED_BY_ACTIVITY,
      side: 'TO',
    });
  });

  it('names a source that is over, as the source, before anything else about the lessons', () => {
    expect(refusalOf(origin, lesson('y', '09:00', '10:00'), at('10:00'))).toEqual({ code: LESSON_MOVE_LESSON_OVER, side: 'FROM' });
    expect(refusalOf(origin, lesson('y', '09:00', '10:00'), at('09:59'))).toBeNull();
    // The database's door asks before its trigger, so an over source that is also cancelled is over.
    expect(refusalOf(lesson('x', '09:00', '10:00', { status: 'CANCELLED', cancelCause: 'MANUAL' }), lesson('y', '09:00', '10:00'), at('10:30'))).toEqual({
      code: LESSON_MOVE_LESSON_OVER,
      side: 'FROM',
    });
    // The target being over is not the source's reason: the pupil's mark is on the source.
    expect(refusalOf(lesson('x', '09:00', '11:00'), lesson('y', '09:00', '10:00'), at('10:30'))).toBeNull();
  });

  it('asks no clock of a pupil who is being corrected: the database knows who may correct a move after the end', () => {
    // Without a clock (a pupil a move has put on another lesson) an origin that is over is not a reason of the gateway's.
    expect(refusalOf(origin, lesson('y', '09:00', '10:00'))).toBeNull();
    expect(refusalOf(origin, lesson('y', '09:00', '10:00'), undefined)).toBeNull();
    // ... but what is wrong with the lessons is: the parallel rules stay.
    expect(refusalOf(origin, lesson('w', '11:00', '12:00'))).toEqual({ code: LESSON_MOVE_NOT_PARALLEL });
  });

  it('names a source that is cancelled or replaced, as the source', () => {
    expect(refusalOf(lesson('x', '09:00', '10:00', { status: 'CANCELLED', cancelCause: 'MANUAL' }), lesson('y', '09:00', '10:00'), NOW)).toEqual({
      code: LESSON_MOVE_LESSON_NOT_HELD,
      side: 'FROM',
    });
    expect(refusalOf(lesson('x', '09:00', '10:00', { status: 'CANCELLED', cancelCause: 'EVENT' }), lesson('y', '09:00', '10:00'), NOW)).toEqual({
      code: LESSON_MOVE_REPLACED_BY_ACTIVITY,
      side: 'FROM',
    });
  });
});

describe('doubleBooks', () => {
  const target = lesson('t', '09:30', '10:30');
  const except = new Set(['x', 'y']);

  it('finds another held lesson of the pupil that overlaps the target', () => {
    expect(doubleBooks(target, [lesson('x', '09:00', '10:00'), lesson('n', '10:00', '11:00')], except)?.id).toBe('n');
  });

  it('leaves out the lesson they leave, the one they are on and the target itself', () => {
    expect(doubleBooks(target, [lesson('x', '09:00', '10:00'), lesson('y', '09:00', '10:00'), target], except)).toBeNull();
  });

  it('does not count a cancelled lesson, or one that only touches the target', () => {
    expect(doubleBooks(target, [lesson('c', '10:00', '11:00', { status: 'CANCELLED' }), lesson('t2', '10:30', '11:30')], except)).toBeNull();
  });
});

describe('crowdedWarning', () => {
  it('warns when the pupil would take the room over its capacity, and counts the pupil in', () => {
    expect(crowdedWarning(24, 24)).toEqual({ code: 'TARGET_ROOM_OVER_CAPACITY', headcount: 25, capacity: 24 });
    expect(crowdedWarning(23, 24)).toBeNull();
  });

  it('says nothing about a room whose capacity the school never wrote', () => {
    expect(crowdedWarning(40, null)).toBeNull();
    expect(crowdedWarning(40, 0)).toBeNull();
  });
});

describe('the database’s refusals', () => {
  it('answers every SQLSTATE of the door with a code', () => {
    expect(SQLSTATE_TO_CODE['LM403']).toBe(LESSON_MOVE_NOT_ALLOWED);
    expect(SQLSTATE_TO_CODE['LM404']).toBe(LESSON_MOVE_NOT_FOUND);
    expect(SQLSTATE_TO_CODE['LM412']).toBe(LESSON_MOVE_NOT_PARALLEL);
    expect(SQLSTATE_TO_CODE['LM415']).toBe(LESSON_MOVE_HAS_ATTENDANCE);
    expect(SQLSTATE_TO_CODE['LM416']).toBe(LESSON_MOVE_LESSON_OVER);
    expect(Object.keys(SQLSTATE_TO_CODE).sort()).toEqual(['LM403', 'LM404', 'LM410', 'LM412', 'LM413', 'LM414', 'LM415', 'LM416']);
  });

  it('reads the code a conflict carries in its message', () => {
    expect(conflictCodeOf('LESSON_MOVE_ALREADY_ON_TARGET: eleven står redan på mållektionen')).toBe(LESSON_MOVE_ALREADY_ON_TARGET);
    expect(conflictCodeOf('something else')).toBeNull();
  });
});
