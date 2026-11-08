import type { PersonDay } from '../cover/cover-rules';
import type { PlanLesson } from './exam-plan';
import { buildRequest, realise, type PlanningExam, type PlanningState } from './exam-request';
import type { PlanExamsResponse } from './interfaces/exam-engine.interface';

// 2030-10-08 is a Tuesday; the school is in UTC for these tests.
const TZ = 'UTC';
const at = (date: string, minute: number) => Date.parse(`${date}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00.000Z`);

const exam = (id: string, over: Partial<PlanningExam> = {}): PlanningExam => ({
  id,
  subjectId: 'math',
  lengthMinutes: 60,
  writers: 40,
  windowKind: 'WEEK',
  from: '2030-10-08',
  to: '2030-10-09',
  fixedStart: null,
  earliestStart: null,
  latestEnd: null,
  named: ['g7a'],
  coverOf: new Map([['g7a', new Set(['g7a'])]]),
  closed: new Set(),
  affected: new Set(['g7a']),
  classes: ['g7a'],
  ...over,
});

const lesson = (id: string, date: string, start: number, end: number, group = 'g7a', subjectId = 'swe'): PlanLesson => ({
  id,
  date,
  start,
  end,
  subjectId,
  groupIds: [group],
});

const teacherDay = (userId: string, busy: Array<[string, number, number]> = []): PersonDay => ({
  userId,
  isActiveTeacher: true,
  lessons: busy.map(([date, from, to], index) => ({
    id: `${userId}-${index}`,
    date,
    start: at(date, from),
    end: at(date, to),
    status: 'SCHEDULED' as const,
    studentGroupId: 'other',
    subjectId: 'swe',
  })),
  closures: [],
  preferredFree: [],
  bookings: [],
  absences: [],
  lunch: null,
  minDailyRestMinutes: null,
  pool: { member: false, hasEmployment: true, windows: [] },
});

function state(over: Partial<PlanningState> = {}): PlanningState {
  const dates = ['2030-10-08', '2030-10-09'];
  return {
    today: '2030-10-07',
    timezone: TZ,
    limits: { maxPerClassPerDay: 1, maxPerClassPerWeek: 3, writersPerInvigilator: 30, turnoverMinutes: 10 },
    exams: [exam('e1')],
    lessons: [lesson('l1', '2030-10-08', 480, 540), lesson('l2', '2030-10-09', 480, 540)],
    teacherIds: ['t1', 't2'],
    personDays: new Map(dates.map((date) => [date, new Map([['t1', teacherDay('t1', date === '2030-10-08' ? [['2030-10-08', 480, 540]] : [])], ['t2', teacherDay('t2')]])])),
    prior: new Map([['t2', 120]]),
    rooms: [
      { id: 'r1', seats: 30 },
      { id: 'r2', seats: 30 },
    ],
    roomUses: new Map([['r1', { lessons: [], bookings: [{ start: at('2030-10-09', 470), end: at('2030-10-09', 600) }], closures: [] }]]),
    loan: () => false,
    standing: [],
    ...over,
  };
}

describe('the request the engine is sent', () => {
  it('turns real ids into fresh ones, and offers the slots with who and what is taken at each', () => {
    const { request, maps, slots } = buildRequest(state(), 'req');
    expect(request.requestId).toBe('req');
    const [e] = request.exams;
    expect(slots.get('e1')).toHaveLength(2);
    expect(e.slots.map((s) => [s.day, s.start, s.loss])).toEqual([
      [0, 480, 60],
      [1, 480, 60],
    ]);
    // t1 has a lesson on the first day of the exam's slot; r1 is booked on the second.
    expect(e.teacherBlocks).toEqual([{ id: maps.teachers.get('t1'), slots: [0] }]);
    expect(e.roomBlocks).toEqual([{ id: maps.rooms.get('r1'), slots: [1] }]);
    expect(request.teachers).toEqual([
      { id: maps.teachers.get('t1'), prior: 0 },
      { id: maps.teachers.get('t2'), prior: 120 },
    ]);
    expect(request.rooms).toEqual([
      { id: maps.rooms.get('r1'), seats: 30 },
      { id: maps.rooms.get('r2'), seats: 30 },
    ]);
    // Nothing real crosses: no real id appears in the payload.
    const wire = JSON.stringify(request);
    for (const real of ['e1', 't1', 't2', 'r1', 'r2', 'g7a']) expect(wire).not.toContain(`"${real}"`);
    expect(e.classes).toHaveLength(1);
    expect(e.fixed).toBe(false);
    expect(request.limits.writersPerInvigilator).toBe(30);
    expect(request.search).toBeUndefined();
  });

  it('carries the search budget when the caller sets one, and marks a fixed exam', () => {
    const fixed = exam('e1', { windowKind: 'FIXED', from: '2030-10-08', to: '2030-10-08', fixedStart: 480 });
    const { request } = buildRequest(state({ exams: [fixed], maxTimeSeconds: 12 }));
    expect(request.search).toEqual({ maxTimeSeconds: 12 });
    expect(request.exams[0].fixed).toBe(true);
    expect(request.exams[0].slots).toHaveLength(1);
  });

  it('states what the exams that stand have used of the caps, for the classes asked about', () => {
    const standing = [
      { id: 'x1', date: '2030-10-08', start: 700, end: 760, classes: ['g7a'] },
      { id: 'x2', date: '2030-10-09', start: 700, end: 760, classes: ['g9z'] },
    ];
    const { request, maps } = buildRequest(state({ standing }));
    const asked = request.exams[0].classes[0];
    expect(request.existingDayLoad).toEqual([{ class: asked, day: 0, count: 1 }]);
    expect(request.existingWeekLoad).toEqual([{ class: asked, week: 0, count: 1 }]);
    expect(maps.exams.get('e1')).toBeDefined();
  });

  it('drops a time that lies on an exam that stands for the same class, and says so when none is left', () => {
    const standing = [{ id: 'x1', date: '2030-10-08', start: 470, end: 600, classes: ['g7a'] }];
    const one = buildRequest(state({ standing }));
    expect(one.request.exams[0].slots.map((s) => s.day)).toEqual([1]);
    const both = buildRequest(
      state({ standing: [...standing, { id: 'x2', date: '2030-10-09', start: 470, end: 600, classes: ['g7a'] }] }),
    );
    expect(both.request.exams).toEqual([]);
    expect(both.unplaced).toEqual([{ examId: 'e1', reason: 'EXAM_CLASS_CLASH', params: {} }]);
  });

  it('does not ask about an exam that has no time, and gives the reason itself', () => {
    const closed = exam('e1', { closed: new Set(['2030-10-08', '2030-10-09']) });
    const noLesson = exam('e2', { named: ['gx'], coverOf: new Map([['gx', new Set(['gx'])]]), affected: new Set(['gx']), classes: ['gx'] });
    const { request, unplaced } = buildRequest(state({ exams: [closed, noLesson] }));
    expect(request.exams).toEqual([]);
    expect(unplaced).toEqual([
      { examId: 'e1', reason: 'EXAM_WINDOW_CLOSED', params: {} },
      { examId: 'e2', reason: 'EXAM_NO_LESSON_TO_REPLACE', params: {} },
    ]);
  });

  it('numbers a week index across the days it asks about', () => {
    const { request } = buildRequest(state({ exams: [exam('e1', { from: '2030-10-08', to: '2030-10-16' })], lessons: [lesson('l1', '2030-10-08', 480, 540), lesson('l3', '2030-10-15', 480, 540)] }));
    expect(request.exams[0].slots.map((s) => [s.day, s.week])).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });
});

describe('the answer put back into real ids', () => {
  const built = () => buildRequest(state(), 'req');

  const answer = (b: ReturnType<typeof built>, over: Partial<PlanExamsResponse> = {}): PlanExamsResponse => ({
    requestId: 'req',
    status: 'OPTIMAL',
    placed: [
      {
        exam: b.maps.exams.get('e1')!,
        slot: 1,
        rooms: [{ room: b.maps.rooms.get('r2')!, writers: 40, invigilators: [b.maps.teachers.get('t2')!] }],
      },
    ],
    unplaced: [],
    invigilatorMinutes: [{ teacher: b.maps.teachers.get('t2')!, minutes: 60 }],
    metrics: { placed: 1, unplaced: 0, loss: 60, roomsUsed: 1, invigilatorPasses: 1, maxLoad: 180, minLoad: 0, solveSeconds: 0.2 },
    ...over,
  });

  it('names the exam, the day and time, the room and the invigilators by their real ids', () => {
    const b = built();
    const plan = realise(b, answer(b));
    expect(plan.placed).toEqual([
      { examId: 'e1', date: '2030-10-09', start: 480, end: 540, loss: 60, rooms: [{ roomId: 'r2', writers: 40, teacherIds: ['t2'] }] },
    ]);
    expect([...plan.added]).toEqual([['t2', 60]]);
    expect(plan.status).toBe('OPTIMAL');
  });

  it('carries the gateway’s own reasons beside the engine’s', () => {
    const b = buildRequest(state({ exams: [exam('e1'), exam('e2', { closed: new Set(['2030-10-08', '2030-10-09']) })] }), 'req');
    const out = answer(b, {
      placed: [],
      unplaced: [{ exam: b.maps.exams.get('e1')!, reason: 'EXAM_ROOMS_TAKEN', params: { x: 1 }, message: 'rooms taken' }],
    });
    const plan = realise(b, out);
    expect(plan.unplaced).toEqual([
      { examId: 'e2', reason: 'EXAM_WINDOW_CLOSED', params: {}, message: null },
      { examId: 'e1', reason: 'EXAM_ROOMS_TAKEN', params: { x: 1 }, message: 'rooms taken' },
    ]);
  });

  it('refuses an answer that names an id or a time the request did not carry', () => {
    const b = built();
    expect(() => realise(b, answer(b, { placed: [{ exam: 'nope', slot: 0, rooms: [] }] }))).toThrow('exam the request did not carry');
    expect(() => realise(b, answer(b, { placed: [{ exam: b.maps.exams.get('e1')!, slot: 9, rooms: [] }] }))).toThrow('time the request did not carry');
    expect(() =>
      realise(b, answer(b, { placed: [{ exam: b.maps.exams.get('e1')!, slot: 0, rooms: [{ room: 'nope', writers: 1, invigilators: [] }] }] })),
    ).toThrow('room the request did not carry');
    expect(() =>
      realise(b, answer(b, { placed: [], invigilatorMinutes: [{ teacher: 'nope', minutes: 5 }] })),
    ).toThrow('teacher the request did not carry');
  });
});
