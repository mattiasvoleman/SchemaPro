import { MAX_BREAK_GAP_MS, localCalls } from './crisisLocalList';
import { isLocalCall } from './crisis';
import type { CalendarLesson } from '../types';

/**
 * The list the phone builds when no list came, against the gateway's rule
 * (src/crisis/crisis-calls.ts, and its spec, whose cases are mirrored here by
 * name): the lesson that is going on answers for its pupils, in a break the
 * group goes with the lesson it is going to, and a pupil with no lesson around
 * the moment is on no list. Under TZ=UTC, so the instants read as written.
 */

const at = (hhmm: string, day = '2027-01-12'): Date => new Date(`${day}T${hhmm}:00.000Z`);

function lesson(id: string, from: string, to: string, pupils: string[], over: Partial<CalendarLesson> = {}): CalendarLesson {
  return {
    id,
    startTime: at(from).toISOString(),
    endTime: at(to).toISOString(),
    subjectName: `Ämne ${id}`,
    roomName: `Sal ${id}`,
    studentIds: pupils,
    ...over,
  };
}

const names = new Map(
  ['a', 'b', 'c', 'd'].map((id) => [id, `Elev ${id.toUpperCase()}`] as const),
);

const shape = (calls: ReturnType<typeof localCalls>) => calls.map((call) => [call.lessonId, call.basis, call.pupils.map((p) => p.studentId)]);

describe('localCalls: the lesson that is going on answers for its pupils', () => {
  it('puts the pupils of a running lesson on it, as the lesson as the phone holds it', () => {
    const [call] = localCalls(at('09:30'), [lesson('l1', '09:00', '09:50', ['a', 'b'])], names);
    expect(call).toMatchObject({
      id: 'local:l1',
      lessonId: 'l1',
      basis: 'LESSON',
      subjectName: 'Ämne l1',
      roomName: 'Sal l1',
      lessonStartsAt: at('09:00').toISOString(),
      lessonEndsAt: at('09:50').toISOString(),
      completedAt: null,
      colleagues: [],
      // The cache holds a subject and a room, not the group's name.
      groupName: '',
    });
    expect(isLocalCall(call!)).toBe(true);
    expect(call!.pupils.map((p) => [p.studentId, p.firstName, p.status])).toEqual([
      ['a', 'Elev A', 'UNREPORTED'],
      ['b', 'Elev B', 'UNREPORTED'],
    ]);
    expect(call!.counts).toEqual({ pupils: 2, found: 0, missing: 0, away: 0, absentBefore: 0, unreported: 2 });
  });

  it('counts the start but not the end of a lesson', () => {
    const lessons = [lesson('l1', '09:00', '09:50', ['a']), lesson('l2', '09:50', '10:40', ['a'])];
    expect(localCalls(at('09:00'), lessons, names).map((call) => call.lessonId)).toEqual(['l1']);
    expect(localCalls(at('09:50'), lessons, names).map((call) => call.lessonId)).toEqual(['l2']);
  });

  it('is one call per lesson however many groups are on it, and a pupil on two lessons at once is on the one that sorts first', () => {
    const joint = lesson('joint', '09:00', '09:50', ['a', 'b', 'c']);
    const clash = lesson('clash', '09:00', '09:50', ['c', 'd']);
    expect(shape(localCalls(at('09:10'), [joint, clash], names))).toEqual([
      ['clash', 'LESSON', ['c', 'd']],
      ['joint', 'LESSON', ['a', 'b']],
    ]);
  });

  it('splits a class whose halves are at different lessons into two calls', () => {
    const calls = localCalls(at('13:15'), [lesson('slojd', '13:00', '14:00', ['a', 'b']), lesson('idrott', '13:00', '14:00', ['c', 'd'])], names);
    expect(shape(calls)).toEqual([
      ['idrott', 'LESSON', ['c', 'd']],
      ['slojd', 'LESSON', ['a', 'b']],
    ]);
  });
});

describe('localCalls: in a break the group goes with the lesson it is going to', () => {
  const lessons = [lesson('l1', '08:10', '09:00', ['a', 'b']), lesson('l2', '09:20', '10:10', ['a', 'b'])];

  it('puts a break between two lessons on the next lesson', () => {
    expect(shape(localCalls(at('09:10'), lessons, names))).toEqual([['l2', 'NEXT_LESSON', ['a', 'b']]]);
  });

  it('holds exactly when the previous lesson ended: the first minute of the break is a break', () => {
    expect(localCalls(at('09:00'), lessons, names).map((call) => call.basis)).toEqual(['NEXT_LESSON']);
  });

  it('has no break before the first lesson, after the last, or across a gap longer than a break', () => {
    expect(localCalls(at('08:00'), lessons, names)).toEqual([]);
    expect(localCalls(at('10:20'), lessons, names)).toEqual([]);
    const split = [lesson('m', '08:00', '08:50', ['a']), lesson('late', '12:00', '12:50', ['a'])];
    expect(MAX_BREAK_GAP_MS).toBe(7_200_000);
    expect(localCalls(at('10:00'), split, names)).toEqual([]);
    expect(localCalls(at('10:00'), split, names, new Map(), 4 * 3_600_000).map((call) => call.lessonId)).toEqual(['late']);
  });

  it('allows a gap of exactly two hours (lunch included) and not a minute more', () => {
    const exact = [lesson('m', '08:00', '09:00', ['a']), lesson('after', '11:00', '12:00', ['a'])];
    expect(localCalls(at('10:00'), exact, names).map((call) => call.lessonId)).toEqual(['after']);
    const over = [lesson('m', '08:00', '09:00', ['a']), lesson('after', '11:01', '12:00', ['a'])];
    expect(localCalls(at('10:00'), over, names)).toEqual([]);
  });

  it('judges each pupil by their own lessons, so one class can be in a lesson and in a break at once', () => {
    const calls = localCalls(
      at('09:10'),
      [lesson('l1', '08:10', '09:00', ['a', 'b']), lesson('long', '08:10', '09:30', ['c']), lesson('l2', '09:20', '10:10', ['a', 'b'])],
      names,
    );
    expect(shape(calls)).toEqual([
      ['long', 'LESSON', ['c']],
      ['l2', 'NEXT_LESSON', ['a', 'b']],
    ]);
  });

  it('keeps the same pupils on the same lessons whatever order the lessons come in', () => {
    expect(localCalls(at('09:10'), [...lessons].reverse(), names)).toEqual(localCalls(at('09:10'), lessons, names));
  });
});

describe('localCalls: what the phone holds of the day', () => {
  it('knows nothing of another day: a break needs a lesson before and after it the same day', () => {
    const yesterday = lesson('yesterday', '15:00', '15:50', ['a'], {
      startTime: at('15:00', '2027-01-11').toISOString(),
      endTime: at('15:50', '2027-01-11').toISOString(),
    });
    const today = lesson('today', '09:20', '10:10', ['a']);
    const tomorrow = lesson('tomorrow', '08:00', '08:50', ['a'], {
      startTime: at('08:00', '2027-01-13').toISOString(),
      endTime: at('08:50', '2027-01-13').toISOString(),
    });
    // However long a break may be, the lesson before it is today's.
    expect(localCalls(at('09:00'), [yesterday, today], names, new Map(), 48 * 3_600_000)).toEqual([]);
    // And a lesson that is going on by the clock but on another day is not on today's list.
    expect(localCalls(at('08:10'), [tomorrow], names)).toEqual([]);
  });

  it('shows the pupils the teacher marked absent in the register as absent since before, and everyone else as not marked', () => {
    const absent = new Map([['l1', new Set(['b'])]]);
    const [call] = localCalls(at('09:30'), [lesson('l1', '09:00', '09:50', ['a', 'b', 'c'])], names, absent);
    expect(call!.pupils.map((p) => [p.studentId, p.status, p.priorAbsentSource])).toEqual([
      ['a', 'UNREPORTED', null],
      ['b', 'ABSENT_BEFORE', 'ATTENDANCE'],
      ['c', 'UNREPORTED', null],
    ]);
    expect(call!.counts).toMatchObject({ absentBefore: 1, unreported: 2 });
  });

  it('puts the pupils in Swedish order by name, and keeps a pupil it has no name for', () => {
    const odd = new Map([
      ['a', 'Östen Ö'],
      ['b', 'Åsa Å'],
      ['c', 'Zoe Z'],
    ]);
    const [call] = localCalls(at('09:30'), [lesson('l1', '09:00', '09:50', ['a', 'b', 'c', 'ghost'])], odd);
    expect(call!.pupils.map((p) => p.firstName)).toEqual(['', 'Zoe Z', 'Åsa Å', 'Östen Ö']);
  });

  it('leaves out a room the cache has no name for', () => {
    const [none, dash] = localCalls(at('09:30'), [lesson('l1', '09:00', '09:50', ['a'], { roomName: '' }), lesson('l2', '09:00', '09:50', ['b'], { roomName: '—' })], names);
    expect(none!.roomName).toBeNull();
    expect(dash!.roomName).toBeNull();
  });

  it('ignores a lesson whose times it cannot read', () => {
    const broken = lesson('bad', '09:00', '09:50', ['a'], { startTime: 'not a time' });
    expect(localCalls(at('09:30'), [broken], names)).toEqual([]);
  });

  it('is nothing for no lessons', () => {
    expect(localCalls(at('09:30'), [], names)).toEqual([]);
  });
});
