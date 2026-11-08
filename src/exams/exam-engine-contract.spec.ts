import type { PersonDay } from '../cover/cover-rules';
import { buildRequest, type PlanningExam, type PlanningState } from './exam-request';
import type { PlanExamsRequest } from './interfaces/exam-engine.interface';

/**
 * The exam planner's wire contract, pinned from the gateway's side.
 *
 * The mirror is optimization-engine/tests/test_exams.py
 * (test_the_wire_contract_is_exactly_what_the_gateway_sends_and_reads). The
 * engine's models forbid extra fields, so one name here the engine has not
 * heard of is a 422 for the whole proposal: change both lists in the commit
 * that deploys the engine, engine first. A field added later is optional on
 * the engine's side and sent only when it says something. The two routes the
 * generator and the room optimisation use (ai-engine-contract.spec.ts,
 * room-optimization.service.spec.ts) are untouched by this one.
 *
 * And the privacy half: nothing crosses but opaque ids minted for the request,
 * integers and booleans. Every string in the payload is a fresh v4 uuid that is
 * none of the school's real ids; no name, no date, no room code.
 */

const REQUEST_FIELDS = ['exams', 'existingDayLoad', 'existingWeekLoad', 'limits', 'requestId', 'rooms', 'teachers'];
/** Sent only when the caller sets a budget. */
const OPTIONAL_REQUEST_FIELDS = ['search', 'weights'];
const EXAM_FIELDS = ['classes', 'fixed', 'id', 'length', 'roomBlocks', 'slots', 'teacherBlocks', 'writers'];
const SLOT_FIELDS = ['day', 'loss', 'start', 'week'];
const BLOCK_FIELDS = ['id', 'slots'];
const ROOM_FIELDS = ['id', 'seats'];
const TEACHER_FIELDS = ['id', 'prior'];
const LIMIT_FIELDS = ['maxPerClassPerDay', 'maxPerClassPerWeek', 'turnoverMinutes', 'writersPerInvigilator'];
const DAY_LOAD_FIELDS = ['class', 'count', 'day'];
const WEEK_LOAD_FIELDS = ['class', 'count', 'week'];
/** What the gateway reads back; the engine's PlanExamsResponse and its parts. */
export const RESPONSE_FIELDS = ['invigilatorMinutes', 'metrics', 'placed', 'requestId', 'status', 'unplaced'];
export const PLACED_FIELDS = ['exam', 'rooms', 'slot'];
export const PLACED_ROOM_FIELDS = ['invigilators', 'room', 'writers'];
export const UNPLACED_FIELDS = ['exam', 'message', 'params', 'reason'];
export const MINUTES_FIELDS = ['minutes', 'teacher'];
export const METRICS_FIELDS = ['invigilatorPasses', 'loss', 'maxLoad', 'minLoad', 'placed', 'roomsUsed', 'solveSeconds', 'unplaced'];

const REAL = ['exam-1', 'g7a', 'r1', 'r2', 't1', 't2'];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const at = (date: string, minute: number) =>
  Date.parse(`${date}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00.000Z`);

const exam: PlanningExam = {
  id: 'exam-1',
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
};

const teacher = (userId: string, busy: boolean): PersonDay => ({
  userId,
  isActiveTeacher: true,
  lessons: busy ? [{ id: 'x', date: '2030-10-08', start: at('2030-10-08', 480), end: at('2030-10-08', 540), status: 'SCHEDULED', studentGroupId: 'other', subjectId: 's' }] : [],
  closures: [],
  preferredFree: [],
  bookings: [],
  absences: [],
  lunch: null,
  minDailyRestMinutes: null,
  pool: { member: false, hasEmployment: true, windows: [] },
});

function request(withSearch: boolean): PlanExamsRequest {
  const state: PlanningState = {
    today: '2030-10-07',
    timezone: 'UTC',
    limits: { maxPerClassPerDay: 1, maxPerClassPerWeek: 3, writersPerInvigilator: 30, turnoverMinutes: 10 },
    exams: [exam],
    lessons: [
      { id: 'l1', date: '2030-10-08', start: 480, end: 540, subjectId: 'swe', groupIds: ['g7a'] },
      { id: 'l2', date: '2030-10-09', start: 480, end: 540, subjectId: 'swe', groupIds: ['g7a'] },
    ],
    teacherIds: ['t1', 't2'],
    personDays: new Map([
      ['2030-10-08', new Map([['t1', teacher('t1', true)], ['t2', teacher('t2', false)]])],
      ['2030-10-09', new Map([['t1', teacher('t1', false)], ['t2', teacher('t2', false)]])],
    ]),
    prior: new Map([['t1', 60]]),
    rooms: [{ id: 'r1', seats: 30 }, { id: 'r2', seats: 60 }],
    roomUses: new Map([['r1', { lessons: [], bookings: [{ start: at('2030-10-09', 470), end: at('2030-10-09', 600) }], closures: [] }]]),
    loan: () => false,
    standing: [{ id: 'x', date: '2030-10-08', start: 700, end: 760, classes: ['g7a'] }],
    ...(withSearch ? { maxTimeSeconds: 12 } : {}),
  };
  return buildRequest(state).request;
}

const keys = (value: object): string[] => Object.keys(value).sort();

describe('the exam planner’s wire contract', () => {
  it('sends exactly the fields the engine reads, and no others', () => {
    const sent = request(false);
    expect(keys(sent)).toEqual([...REQUEST_FIELDS].sort());
    expect(keys(sent.exams[0])).toEqual(EXAM_FIELDS);
    expect(keys(sent.exams[0].slots[0])).toEqual(SLOT_FIELDS);
    expect(keys(sent.exams[0].roomBlocks[0])).toEqual(BLOCK_FIELDS);
    expect(keys(sent.exams[0].teacherBlocks[0])).toEqual(BLOCK_FIELDS);
    expect(keys(sent.rooms[0])).toEqual(ROOM_FIELDS);
    expect(keys(sent.teachers[0])).toEqual(TEACHER_FIELDS);
    expect(keys(sent.limits)).toEqual(LIMIT_FIELDS);
    expect(keys(sent.existingDayLoad[0])).toEqual(DAY_LOAD_FIELDS);
    expect(keys(sent.existingWeekLoad[0])).toEqual(WEEK_LOAD_FIELDS);
  });

  it('sends a search budget only when the caller sets one, and never a weight (the engine’s defaults are the school’s)', () => {
    expect(keys(request(true))).toEqual([...REQUEST_FIELDS, 'search'].sort());
    expect(OPTIONAL_REQUEST_FIELDS).toEqual(['search', 'weights']);
    expect(request(true).search).toEqual({ maxTimeSeconds: 12 });
  });

  it('lets nothing cross but fresh ids and numbers', () => {
    const sent = request(true);
    const strings: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'string') strings.push(`${path}=${value}`);
      else if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${path}[${index}]`));
      else if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) walk(inner, `${path}.${key}`);
    };
    walk(sent, 'request');
    expect(strings.length).toBeGreaterThan(0);
    for (const entry of strings) {
      const value = entry.slice(entry.indexOf('=') + 1);
      // Every string is an id minted for this request: a v4 uuid that is none of the real ones.
      expect(value).toMatch(UUID_V4);
      expect(REAL).not.toContain(value);
    }
    // And a second request mints other ids for the same school.
    expect(request(false).exams[0].id).not.toBe(sent.exams[0].id);
  });

  it('pins the names it reads back, for the engine’s mirror to hold', () => {
    expect(RESPONSE_FIELDS).toEqual(['invigilatorMinutes', 'metrics', 'placed', 'requestId', 'status', 'unplaced']);
    expect(PLACED_FIELDS).toEqual(['exam', 'rooms', 'slot']);
    expect(PLACED_ROOM_FIELDS).toEqual(['invigilators', 'room', 'writers']);
    expect(UNPLACED_FIELDS).toEqual(['exam', 'message', 'params', 'reason']);
    expect(MINUTES_FIELDS).toEqual(['minutes', 'teacher']);
    expect(METRICS_FIELDS).toEqual(['invigilatorPasses', 'loss', 'maxLoad', 'minLoad', 'placed', 'roomsUsed', 'solveSeconds', 'unplaced']);
  });
});
