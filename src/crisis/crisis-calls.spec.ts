import { callsAt, MAX_BREAK_GAP_MS, priorAbsences, withoutList, type DayLesson } from './crisis-calls';

const at = (hhmm: string): Date => new Date(`2027-01-12T${hhmm}:00.000Z`);

function lesson(id: string, from: string, to: string, pupils: string[], teachers: string[] = ['t-' + id]): DayLesson {
  return {
    id,
    startsAt: at(from),
    endsAt: at(to),
    roster: new Set(pupils),
    teachers: teachers.map((teacherId, index) => ({ teacherId, role: index === 0 ? 'LEAD' : 'ASSISTANT' })),
  };
}

describe('callsAt: the lesson that is going on answers for its pupils', () => {
  it('puts the pupils of a running lesson on it, with its teachers', () => {
    const calls = callsAt(at('09:30'), [lesson('l1', '09:00', '09:50', ['a', 'b'], ['anna', 'bo'])], new Set());
    expect(calls).toEqual([
      {
        lessonId: 'l1',
        basis: 'LESSON',
        teachers: [
          { teacherId: 'anna', role: 'LEAD' },
          { teacherId: 'bo', role: 'ASSISTANT' },
        ],
        pupilIds: ['a', 'b'],
      },
    ]);
  });

  it('counts the start but not the end of a lesson', () => {
    const lessons = [lesson('l1', '09:00', '09:50', ['a']), lesson('l2', '09:50', '10:40', ['a'])];
    expect(callsAt(at('09:00'), lessons, new Set()).map((call) => call.lessonId)).toEqual(['l1']);
    expect(callsAt(at('09:50'), lessons, new Set()).map((call) => call.lessonId)).toEqual(['l2']);
  });

  it('is one call per lesson however many groups are on it, and a pupil on two lessons at once is on the one that sorts first', () => {
    const joint = lesson('joint', '09:00', '09:50', ['a', 'b', 'c']);
    const clash = lesson('clash', '09:00', '09:50', ['c', 'd']);
    const calls = callsAt(at('09:10'), [joint, clash], new Set());
    expect(calls.map((call) => [call.lessonId, call.pupilIds])).toEqual([
      ['clash', ['c', 'd']],
      ['joint', ['a', 'b']],
    ]);
  });

  it('splits a class whose halves are at different lessons into two calls with their own teachers', () => {
    const calls = callsAt(
      at('13:15'),
      [lesson('slojd', '13:00', '14:00', ['a', 'b'], ['sara']), lesson('idrott', '13:00', '14:00', ['c', 'd'], ['ivar'])],
      new Set(),
    );
    expect(calls.map((call) => [call.lessonId, call.teachers.map((t) => t.teacherId), call.pupilIds])).toEqual([
      ['idrott', ['ivar'], ['c', 'd']],
      ['slojd', ['sara'], ['a', 'b']],
    ]);
  });

  it('takes the vikarie the calendar names, not the absent teacher: the calendar row is the truth', () => {
    // The cover board (or D4's first yes) has already replaced the absent teacher's row with the vikarie's.
    const calls = callsAt(at('09:10'), [lesson('l1', '09:00', '09:50', ['a'], ['vikarie'])], new Set(['sjuk']));
    expect(calls[0]!.teachers).toEqual([{ teacherId: 'vikarie', role: 'LEAD' }]);
  });

  it('leaves out a teacher who is away right now, so an uncovered lesson has nobody on the list', () => {
    const calls = callsAt(at('09:10'), [lesson('l1', '09:00', '09:50', ['a'], ['sjuk'])], new Set(['sjuk']));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.teachers).toEqual([]);
    expect(calls[0]!.pupilIds).toEqual(['a']);
  });

  it('lets the replacement lesson of an activity answer for the class all day', () => {
    // D3 sets the ordinary lessons off (CANCELLED: they are not passed in) and adds one lesson per class and day.
    const replacement = lesson('activity', '08:00', '15:00', ['a', 'b', 'c'], ['lead', 'assistant']);
    const calls = callsAt(at('11:20'), [replacement], new Set());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ lessonId: 'activity', basis: 'LESSON', pupilIds: ['a', 'b', 'c'] });
    expect(calls[0]!.teachers.map((t) => t.teacherId)).toEqual(['lead', 'assistant']);
  });
});

describe('callsAt: in a break the group goes with the lesson it is going to', () => {
  const lessons = [lesson('l1', '08:10', '09:00', ['a', 'b']), lesson('l2', '09:20', '10:10', ['a', 'b'], ['vikarie'])];

  it('puts a break between two lessons on the next lesson, with its teacher', () => {
    const calls = callsAt(at('09:10'), lessons, new Set());
    expect(calls).toEqual([
      { lessonId: 'l2', basis: 'NEXT_LESSON', teachers: [{ teacherId: 'vikarie', role: 'LEAD' }], pupilIds: ['a', 'b'] },
    ]);
  });

  it('holds exactly when the previous lesson ended: the first minute of the break is a break', () => {
    expect(callsAt(at('09:00'), lessons, new Set()).map((call) => call.basis)).toEqual(['NEXT_LESSON']);
  });

  it('has no break before the first lesson, after the last, or across a gap longer than a break', () => {
    expect(callsAt(at('08:00'), lessons, new Set())).toEqual([]);
    expect(callsAt(at('10:20'), lessons, new Set())).toEqual([]);
    const split = [lesson('m', '08:00', '08:50', ['a']), lesson('late', '12:00', '12:50', ['a'])];
    expect(MAX_BREAK_GAP_MS).toBe(7_200_000);
    expect(callsAt(at('10:00'), split, new Set())).toEqual([]);
    expect(callsAt(at('10:00'), split, new Set(), 4 * 3_600_000).map((call) => call.lessonId)).toEqual(['late']);
  });

  it('judges each pupil by their own lessons, so one class can be in a lesson and in a break at once', () => {
    const calls = callsAt(
      at('09:10'),
      [
        lesson('l1', '08:10', '09:00', ['a', 'b']),
        lesson('long', '08:10', '09:30', ['c']),
        lesson('l2', '09:20', '10:10', ['a', 'b']),
      ],
      new Set(),
    );
    expect(calls.map((call) => [call.lessonId, call.basis, call.pupilIds])).toEqual([
      ['long', 'LESSON', ['c']],
      ['l2', 'NEXT_LESSON', ['a', 'b']],
    ]);
  });

  it('keeps the same pupils on the same lessons whatever order the lessons come in', () => {
    const forward = callsAt(at('09:10'), lessons, new Set());
    const backward = callsAt(at('09:10'), [...lessons].reverse(), new Set());
    expect(backward).toEqual(forward);
  });
});

describe('priorAbsences: who was absent before the alarm', () => {
  const now = at('10:00');
  const mark = (studentId: string, status: 'PRESENT' | 'LATE' | 'ABSENT' | 'EXCUSED', from: string) => ({
    studentId,
    status,
    lessonStartsAt: at(from),
  });

  it('takes the latest mark of the day, not the first', () => {
    const result = priorAbsences(now, [mark('a', 'ABSENT', '08:10'), mark('a', 'PRESENT', '09:00'), mark('b', 'PRESENT', '08:10'), mark('b', 'EXCUSED', '09:00')], []);
    expect([...result]).toEqual([['b', 'ATTENDANCE']]);
  });

  it('counts late as present and excused as absent', () => {
    const result = priorAbsences(now, [mark('a', 'LATE', '08:10'), mark('b', 'EXCUSED', '08:10')], []);
    expect(result.has('a')).toBe(false);
    expect(result.get('b')).toBe('ATTENDANCE');
  });

  it('lets the register speak before a report does: a pupil marked present is expected even if a guardian reported them', () => {
    const result = priorAbsences(now, [mark('a', 'PRESENT', '09:00')], [{ studentId: 'a', startsAt: null, endsAt: null }]);
    expect(result.size).toBe(0);
  });

  it('falls back to a report that covers the moment, a whole day or a span', () => {
    const result = priorAbsences(
      now,
      [],
      [
        { studentId: 'whole', startsAt: null, endsAt: null },
        { studentId: 'span', startsAt: at('08:00'), endsAt: at('12:00') },
        { studentId: 'over', startsAt: at('08:00'), endsAt: at('09:00') },
        { studentId: 'later', startsAt: at('10:30'), endsAt: at('12:00') },
      ],
    );
    expect([...result.keys()].sort()).toEqual(['span', 'whole']);
    expect(result.get('whole')).toBe('REPORTED');
  });
});

describe('withoutList', () => {
  // The review's day: three pupils of a school of five stand on no list at 10:00 and are still in the building.
  const day = [
    lesson('L1', '08:00', '09:00', ['early', 'gap', 'ends']),
    lesson('L2', '09:00', '10:30', ['early', 'ends']),
    lesson('L3', '13:00', '14:00', ['gap']),
    lesson('L4', '11:00', '12:00', ['canceled-later']),
  ];

  it('is every pupil that no call has: before the first lesson, after the last, a gap longer than a break', () => {
    const everyone = ['early', 'gap', 'ends', 'canceled-later', 'club', 'after'];
    // At 07:30 nobody has begun; at 10:00 two are in L2, 'gap' has 4 h to L3, 'canceled-later' has nothing earlier to be between.
    expect(withoutList(everyone, callsAt(at('07:30'), day, new Set()))).toEqual(['after', 'canceled-later', 'club', 'early', 'ends', 'gap']);
    const at10 = callsAt(at('10:00'), day, new Set());
    expect(at10.flatMap((call) => call.pupilIds).sort()).toEqual(['early', 'ends']);
    expect(withoutList(everyone, at10)).toEqual(['after', 'canceled-later', 'club', 'gap']);
  });

  it('counts a pupil once, sorts them, and leaves nobody out for being absent', () => {
    expect(withoutList(['b', 'a', 'b'], [])).toEqual(['a', 'b']);
    expect(withoutList([], [{ pupilIds: ['a'] }])).toEqual([]);
    expect(withoutList(['a', 'b'], [{ pupilIds: ['a'] }])).toEqual(['b']);
  });
});
