import {
  ENDED_GRACE_MS,
  LOCAL_ALARM_ID,
  LOCAL_CALL_PREFIX,
  adminFailureOf,
  countPupils,
  endAlarm,
  fetchAlarmDetail,
  fetchAlarmList,
  fetchMyCrisis,
  isLocalCall,
  markBody,
  missingPupils,
  openAlarms,
  overlayMarks,
  postMyMarks,
  pupilName,
  silentTeachers,
  startAlarm,
  statusOf,
  stillRelevant,
  teacherBlocks,
  uncoveredCalls,
  unmarkedPupils,
  withSentMarks,
  type AlarmDetail,
  type AlarmSummary,
  type CallView,
  type MyAlarm,
  type MyCall,
  type MyCrisisResponse,
  type PupilStatus,
  type PupilView,
} from './crisis';
import { ApiError } from './api';
import type { PendingCrisisMark } from '../types';

jest.mock('./supabase', () => ({ getAccessToken: jest.fn(async () => 'token'), getSupabase: jest.fn() }));

/**
 * Krisläge's client and the views built on it, through the real gateway
 * client against a stubbed fetch: the routes and bodies the gateway receives
 * (src/crisis/crisis.controller.ts, dto/crisis.dto.ts), the wording keys a
 * refusal becomes, and the pure functions that put the phone's own marks on a
 * list. The shapes here are the CONTRACT with src/crisis/crisis-views.ts.
 */

const BASE = 'https://api.example.test/api/v1/crisis';
const fetchMock = jest.fn();
const answer = (status: number, body?: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
});

beforeEach(() => {
  process.env['EXPO_PUBLIC_API_BASE_URL'] = 'https://api.example.test';
  Object.defineProperty(global, 'fetch', { value: fetchMock, writable: true, configurable: true });
  fetchMock.mockReset();
});

const T0 = Date.parse('2026-10-13T08:00:00.000Z');
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

const pupil = (id: string, status: PupilStatus = 'UNREPORTED', over: Partial<PupilView> = {}): PupilView => ({
  studentId: id,
  firstName: `F${id}`,
  lastName: `L${id}`,
  status,
  priorAbsentSource: status === 'ABSENT_BEFORE' ? 'ATTENDANCE' : null,
  markedAt: status === 'FOUND' || status === 'MISSING' ? iso(1_000) : null,
  ...over,
});

const call = (id: string, lessonId: string | null, pupils: PupilView[], over: Partial<MyCall> = {}): MyCall => ({
  id,
  lessonId,
  basis: 'LESSON',
  groupName: '7A',
  subjectName: 'Matematik',
  roomName: 'B204',
  lessonStartsAt: iso(-10 * 60_000),
  lessonEndsAt: iso(35 * 60_000),
  completedAt: null,
  colleagues: [],
  counts: countPupils(pupils.map((p) => p.status)),
  pupils,
  ...over,
});

const alarm = (id: string, calls: MyCall[], over: Partial<MyAlarm> = {}): MyAlarm => ({
  id,
  kind: 'EVACUATION',
  mode: 'LIVE',
  startedAt: iso(0),
  startedBy: 'Rektor R',
  endedAt: null,
  endedBy: null,
  autoEnded: false,
  endNote: null,
  guardiansNotifiedAt: null,
  calls,
  ...over,
});

const mark = (id: string, over: Partial<PendingCrisisMark> = {}): PendingCrisisMark => ({
  id,
  callId: 'c1',
  lessonId: null,
  studentId: 's1',
  state: 'FOUND',
  at: iso(5_000),
  teacherId: 't1',
  retryCount: 0,
  ...over,
});

describe('the gateway client', () => {
  it('reads the teacher’s list from /crisis/mine with the bearer, and nothing in the URL', async () => {
    fetchMock.mockResolvedValueOnce(answer(200, { asOf: iso(0), alarms: [alarm('a1', [])] }));
    const mine = await fetchMyCrisis();
    expect(mine.alarms.map((a) => a.id)).toEqual(['a1']);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/mine`);
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer token');
  });

  it('reads a gateway older than Krisläge (404 without a code) as no alarm, and any other failure as a failure', async () => {
    fetchMock.mockResolvedValueOnce(answer(404, { message: 'Not Found' }));
    await expect(fetchMyCrisis()).resolves.toMatchObject({ alarms: [] });
    fetchMock.mockResolvedValueOnce(answer(404, { code: 'CRISIS_ALARM_NOT_FOUND', message: 'x' }));
    await expect(fetchMyCrisis()).rejects.toBeInstanceOf(ApiError);
    fetchMock.mockResolvedValueOnce(answer(500, {}));
    await expect(fetchMyCrisis()).rejects.toMatchObject({ status: 500 });
  });

  it('answers an empty body as no alarms', async () => {
    fetchMock.mockResolvedValueOnce(answer(200, {}));
    await expect(fetchMyCrisis()).resolves.toMatchObject({ alarms: [] });
  });

  it('sends marks to /crisis/mine/marks, each naming its group by call OR by lesson, never both', async () => {
    fetchMock.mockResolvedValueOnce(answer(200, { stored: 2, duplicates: 0, unresolved: [] }));
    const result = await postMyMarks([mark('m1'), mark('m2', { callId: null, lessonId: 'l1', studentId: 's2', state: 'MISSING' })]);
    expect(result).toEqual({ stored: 2, duplicates: 0, unresolved: [] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/mine/marks`);
    expect(init.method).toBe('POST');
    // forbidNonWhitelisted: nothing but what the DTO names (the teacher id and the retry count stay on the phone).
    expect(JSON.parse(init.body as string)).toEqual({
      marks: [
        { id: 'm1', callId: 'c1', studentId: 's1', state: 'FOUND', at: iso(5_000) },
        { id: 'm2', lessonId: 'l1', studentId: 's2', state: 'MISSING', at: iso(5_000) },
      ],
    });
    for (const body of (JSON.parse(init.body as string) as { marks: object[] }).marks) {
      expect('callId' in body && 'lessonId' in body).toBe(false);
    }
  });

  it('reads a mark answer that lacks its counts as nothing stored', async () => {
    fetchMock.mockResolvedValueOnce(answer(200, undefined));
    await expect(postMyMarks([mark('m1')])).resolves.toEqual({ stored: 0, duplicates: 0, unresolved: [] });
  });

  it('starts, lists, reads and ends an alarm on the administration’s routes', async () => {
    fetchMock.mockResolvedValue(answer(200, { alarm: {}, calls: [] }));
    await startAlarm('LOCKDOWN', 'DRILL');
    await fetchAlarmDetail('a 1');
    await endAlarm('a1');
    fetchMock.mockResolvedValueOnce(answer(200, [{ id: 'a1' }]));
    await expect(fetchAlarmList(3)).resolves.toEqual([{ id: 'a1' }]);
    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    expect(calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      `POST ${BASE}/alarms`,
      `GET ${BASE}/alarms/a%201`,
      `POST ${BASE}/alarms/a1/end`,
      `GET ${BASE}/alarms?limit=3`,
    ]);
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({ kind: 'LOCKDOWN', mode: 'DRILL' });
  });
});

describe('markBody', () => {
  it('names the call when there is one and the lesson when there is not', () => {
    expect(markBody(mark('m1'))).toEqual({ id: 'm1', callId: 'c1', studentId: 's1', state: 'FOUND', at: iso(5_000) });
    expect(markBody(mark('m1', { callId: null, lessonId: 'l9' }))).toMatchObject({ lessonId: 'l9' });
  });
});

describe('a refusal, as the administrator reads it', () => {
  it.each([
    [403, 'CRISIS_NOT_YOURS', 'NOT_YOURS'],
    [409, 'CRISIS_ALARM_OPEN', 'ALARM_OPEN'],
    [409, 'CRISIS_ALARM_ENDED', 'ENDED'],
    [404, 'CRISIS_ALARM_NOT_FOUND', 'NOT_FOUND'],
    [500, undefined, 'FAILED'],
    [400, 'SOMETHING_ELSE', 'FAILED'],
  ])('%s %s is %s', (status, code, expected) => {
    expect(adminFailureOf(new ApiError(status, 'x', code))).toBe(expected);
  });

  it('reads a request that never reached the gateway as OFFLINE, and anything else as FAILED', () => {
    expect(adminFailureOf(new TypeError('Network request failed'))).toBe('OFFLINE');
    expect(adminFailureOf(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe('OFFLINE');
    expect(adminFailureOf(new Error('boom'))).toBe('FAILED');
  });
});

describe('counting, as the gateway counts', () => {
  it('lets a mark overrule "absent before"', () => {
    expect(statusOf('FOUND', 'ATTENDANCE')).toBe('FOUND');
    expect(statusOf('MISSING', null)).toBe('MISSING');
    expect(statusOf(null, 'REPORTED')).toBe('ABSENT_BEFORE');
    expect(statusOf(null, null)).toBe('UNREPORTED');
  });

  it('counts each status once', () => {
    expect(countPupils(['FOUND', 'FOUND', 'MISSING', 'ABSENT_BEFORE', 'UNREPORTED', 'UNREPORTED'])).toEqual({
      pupils: 6,
      found: 2,
      missing: 1,
      absentBefore: 1,
      unreported: 2,
    });
  });

  it('writes a name as first and last, and nothing for none', () => {
    expect(pupilName({ firstName: 'Alva', lastName: 'Elev' })).toBe('Alva Elev');
    expect(pupilName({ firstName: 'Alva Elev', lastName: '' })).toBe('Alva Elev');
  });
});

describe('overlayMarks: the list with the phone’s own taps on it', () => {
  const list = (): MyAlarm[] => [alarm('a1', [call('c1', 'l1', [pupil('s1'), pupil('s2'), pupil('s3', 'ABSENT_BEFORE')])])];

  it('shows a tap as the pupil’s state at once, counted, and as waiting', () => {
    const { alarms, waiting } = overlayMarks(list(), [mark('m1')]);
    const c = alarms[0]!.calls[0]!;
    expect(c.pupils.find((p) => p.studentId === 's1')).toMatchObject({ status: 'FOUND', markedAt: iso(5_000) });
    expect(c.counts).toEqual({ pupils: 3, found: 1, missing: 0, absentBefore: 1, unreported: 1 });
    expect([...waiting]).toEqual(['c1:s1']);
  });

  it('lets the latest tap of a pupil win, whatever order they were written in', () => {
    const { alarms } = overlayMarks(list(), [
      mark('late', { state: 'MISSING', at: iso(9_000) }),
      mark('early', { state: 'FOUND', at: iso(2_000) }),
    ]);
    expect(alarms[0]!.calls[0]!.pupils[0]).toMatchObject({ status: 'MISSING', markedAt: iso(9_000) });
  });

  it('lets a tap overrule "absent before", as the gateway does', () => {
    const { alarms } = overlayMarks(list(), [mark('m1', { studentId: 's3' })]);
    expect(alarms[0]!.calls[0]!.pupils[2]).toMatchObject({ status: 'FOUND', priorAbsentSource: 'ATTENDANCE' });
    expect(alarms[0]!.calls[0]!.counts.absentBefore).toBe(0);
  });

  it('does not replace a mark the list already holds that is newer than the tap, as the gateway keeps the latest by time', () => {
    const marked = [alarm('a1', [call('c1', 'l1', [pupil('s1', 'MISSING', { markedAt: iso(20_000) })])])];
    const { alarms, waiting } = overlayMarks(marked, [mark('m1', { state: 'FOUND', at: iso(5_000) })]);
    expect(alarms[0]!.calls[0]!.pupils[0]!.status).toBe('MISSING');
    // It is still unsent.
    expect(waiting.has('c1:s1')).toBe(true);
  });

  it('ignores a tap for a call or a pupil the list does not hold', () => {
    const { alarms, waiting } = overlayMarks(list(), [mark('m1', { callId: 'other' }), mark('m2', { studentId: 'nobody' })]);
    expect(alarms).toEqual(list());
    expect(waiting.size).toBe(0);
  });

  it('puts a tap made by lesson on the gateway’s call for that lesson: the local list is replaced without marking again', () => {
    const { alarms, waiting } = overlayMarks(list(), [mark('m1', { callId: null, lessonId: 'l1', studentId: 's2', state: 'MISSING' })]);
    expect(alarms[0]!.calls[0]!.pupils[1]).toMatchObject({ status: 'MISSING' });
    expect([...waiting]).toEqual(['c1:s2']);
  });

  it('puts a tap by lesson on the alarm that had started when it was made, the latest of them', () => {
    const earlier = alarm('a-old', [call('c-old', 'l1', [pupil('s1')])], { startedAt: iso(-3_600_000), endedAt: iso(-1_800_000) });
    const current = alarm('a-new', [call('c-new', 'l1', [pupil('s1')])], { startedAt: iso(0) });
    const { alarms } = overlayMarks([current, earlier], [mark('m1', { callId: null, lessonId: 'l1', at: iso(60_000) })]);
    expect(alarms.find((a) => a.id === 'a-new')!.calls[0]!.pupils[0]!.status).toBe('FOUND');
    expect(alarms.find((a) => a.id === 'a-old')!.calls[0]!.pupils[0]!.status).toBe('UNREPORTED');
    // A tap made before the current alarm began belongs to the earlier one.
    const before = overlayMarks([current, earlier], [mark('m2', { callId: null, lessonId: 'l1', at: iso(-2_000_000) })]);
    expect(before.alarms.find((a) => a.id === 'a-old')!.calls[0]!.pupils[0]!.status).toBe('FOUND');
    expect(before.alarms.find((a) => a.id === 'a-new')!.calls[0]!.pupils[0]!.status).toBe('UNREPORTED');
  });

  it('leaves the list as it is, the very same object, when nothing is put on it', () => {
    const l = list();
    expect(overlayMarks(l, []).alarms).toBe(l);
  });

  it('writes sent marks into a kept list and keeps its time', () => {
    const response: MyCrisisResponse = { asOf: iso(1_000), alarms: list() };
    const kept = withSentMarks(response, [mark('m1')]);
    expect(kept.asOf).toBe(iso(1_000));
    expect(kept.alarms[0]!.calls[0]!.pupils[0]!.status).toBe('FOUND');
  });

  it('marks everyone nobody has marked and nobody expected to be missing', () => {
    const c = call('c1', 'l1', [pupil('s1'), pupil('s2', 'FOUND'), pupil('s3', 'MISSING'), pupil('s4', 'ABSENT_BEFORE'), pupil('s5')]);
    expect(unmarkedPupils(c).map((p) => p.studentId)).toEqual(['s1', 's5']);
  });
});

describe('which alarms a phone still shows', () => {
  const NOW = T0 + 30 * 60_000;
  const live = alarm('a', []);

  it('offers an open alarm, an alarm that ended within the hour, and not one that ended earlier', () => {
    expect(stillRelevant(live, NOW)).toBe(true);
    expect(stillRelevant({ ...live, endedAt: iso(20 * 60_000) }, NOW)).toBe(true);
    expect(stillRelevant({ ...live, endedAt: iso(0) }, T0 + ENDED_GRACE_MS)).toBe(true);
    expect(stillRelevant({ ...live, endedAt: iso(0) }, T0 + ENDED_GRACE_MS + 1)).toBe(false);
  });

  it('drops an alarm the gateway would have ended itself: 12 hours for a real one, 3 for a drill', () => {
    expect(stillRelevant(live, T0 + 12 * 3_600_000 - 1)).toBe(true);
    expect(stillRelevant(live, T0 + 12 * 3_600_000)).toBe(false);
    expect(stillRelevant({ ...live, mode: 'DRILL' }, T0 + 3 * 3_600_000 - 1)).toBe(true);
    expect(stillRelevant({ ...live, mode: 'DRILL' }, T0 + 3 * 3_600_000)).toBe(false);
  });
});

describe('teacherBlocks: what the teacher sees', () => {
  const NOW = T0 + 60_000;
  const base = (alarms: MyAlarm[]): MyCrisisResponse => ({ asOf: iso(30_000), alarms });
  const view = (over: Partial<Parameters<typeof teacherBlocks>[0]> = {}) =>
    teacherBlocks({ response: null, local: [], pending: [], hint: null, now: NOW, ...over });

  it('shows nothing when there is nothing', () => {
    expect(view().blocks).toEqual([]);
  });

  it('puts an open alarm before one that has ended, and the newer first', () => {
    const response = base([
      alarm('ended', [], { startedAt: iso(-1_800_000), endedAt: iso(-900_000) }),
      alarm('older', [], { startedAt: iso(-600_000) }),
      alarm('newer', [], { startedAt: iso(-60_000) }),
    ]);
    expect(view({ response }).blocks.map((b) => [b.key, b.endedAt !== null])).toEqual([
      ['newer', false],
      ['older', false],
      ['ended', true],
    ]);
  });

  it('does not show an alarm from yesterday that the phone has kept', () => {
    const response = base([alarm('yesterday', [], { startedAt: iso(-86_400_000), endedAt: iso(-85_000_000) })]);
    expect(view({ response }).blocks).toEqual([]);
  });

  it('closes an alarm whose end the phone was told of, for the alarms that began before it', () => {
    const response = base([alarm('a', [], { startedAt: iso(-600_000) }), alarm('b', [], { startedAt: iso(30_000) })]);
    const blocks = view({ response, hint: { alarmAt: null, endedAt: T0 + 10_000 } }).blocks;
    expect(blocks.find((b) => b.key === 'a')!.endedAt).toBe(iso(10_000));
    // One that began after the end push is a newer alarm.
    expect(blocks.find((b) => b.key === 'b')!.endedAt).toBeNull();
  });

  it('shows the phone’s own list as an alarm of its own when the push told of one, and not without the push', () => {
    const local = [call(`${LOCAL_CALL_PREFIX}l1`, 'l1', [pupil('s1')], { groupName: '' })];
    expect(view({ local }).blocks).toEqual([]);
    const blocks = view({ local, hint: { alarmAt: T0 + 5_000, endedAt: null } }).blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ key: LOCAL_ALARM_ID, local: true, kind: null, mode: null, endedAt: null, startedAt: iso(5_000) });
    expect(isLocalCall(blocks[0]!.calls[0]!)).toBe(true);
  });

  it('lays the queue over both, and says which pupils wait', () => {
    const local = [call(`${LOCAL_CALL_PREFIX}l1`, 'l1', [pupil('s1'), pupil('s2')], { groupName: '' })];
    const result = view({
      local,
      hint: { alarmAt: T0 + 5_000, endedAt: null },
      pending: [mark('m1', { callId: null, lessonId: 'l1', at: iso(1_000) })],
    });
    expect(result.blocks[0]!.calls[0]!.pupils[0]!.status).toBe('FOUND');
    expect([...result.waiting]).toEqual([`${LOCAL_CALL_PREFIX}l1:s1`]);
  });
});

describe('what the administration reads', () => {
  const callView = (id: string, group: string, over: Partial<CallView> = {}): CallView => ({
    id,
    lessonId: `l-${id}`,
    basis: 'LESSON',
    groupName: group,
    subjectName: 'Matematik',
    roomName: null,
    lessonStartsAt: iso(0),
    lessonEndsAt: iso(2_700_000),
    completedAt: null,
    uncovered: false,
    teachers: [],
    counts: countPupils([]),
    pupils: [],
    ...over,
  });
  const summary = (over: Partial<AlarmSummary> = {}): AlarmSummary => ({
    ...alarm('a1', []),
    calls: 0,
    callsComplete: 0,
    counts: countPupils([]),
    teachers: 0,
    teachersAnswered: 0,
    ...over,
  });

  it('keeps the alarms that are going', () => {
    expect(openAlarms([summary({ id: 'x' }), summary({ id: 'y', endedAt: iso(1) })]).map((a) => a.id)).toEqual(['x']);
  });

  it('lists the pupils marked missing with their group, in the order of the groups', () => {
    const detail: AlarmDetail = {
      alarm: summary(),
      calls: [
        callView('c1', '7A', { pupils: [pupil('s1', 'MISSING'), pupil('s2', 'FOUND')] }),
        callView('c2', '8B', { pupils: [pupil('s3', 'MISSING')] }),
      ],
    };
    expect(missingPupils(detail)).toEqual([
      { studentId: 's1', name: 'Fs1 Ls1', groupName: '7A' },
      { studentId: 's3', name: 'Fs3 Ls3', groupName: '8B' },
    ]);
  });

  it('names the teachers who have not answered, by name with their groups, and not those of a complete group', () => {
    const teacher = (name: string | null, answeredAt: string | null, userId: string | null = 'u') => ({ userId, name, role: 'LEAD' as const, answeredAt });
    const detail: AlarmDetail = {
      alarm: summary(),
      calls: [
        callView('c1', '7A', {
          counts: countPupils(['UNREPORTED']),
          teachers: [teacher('Anna Lind', null), teacher('Bo Berg', iso(1_000)), teacher(null, null, null)],
        }),
        callView('c2', '8B', { counts: countPupils(['UNREPORTED']), teachers: [teacher('Anna Lind', null)] }),
        // Everyone expected has a mark, from anyone: nobody is waited for.
        callView('c3', '9C', { counts: countPupils(['FOUND']), teachers: [teacher('Cia Ceder', null)] }),
      ],
    };
    expect(silentTeachers(detail)).toEqual([{ name: 'Anna Lind', groups: ['7A', '8B'] }]);
  });

  it('finds the groups nobody answers for that still need marks', () => {
    const detail: AlarmDetail = {
      alarm: summary(),
      calls: [
        callView('c1', '7A', { uncovered: true, counts: countPupils(['UNREPORTED']) }),
        callView('c2', '8B', { uncovered: true, counts: countPupils(['FOUND']) }),
        callView('c3', '9C', { counts: countPupils(['UNREPORTED']) }),
      ],
    };
    expect(uncoveredCalls(detail).map((c) => c.id)).toEqual(['c1']);
  });
});
