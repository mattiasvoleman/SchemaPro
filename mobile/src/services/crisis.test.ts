import {
  ENDED_GRACE_MS,
  LOCAL_ALARM_ID,
  LOCAL_CALL_PREFIX,
  SEARCH_LIMIT,
  SEARCH_MIN_CHARS,
  adminFailureOf,
  countPupils,
  endAlarm,
  fetchAlarmDetail,
  fetchAlarmList,
  fetchMyCrisis,
  foundHereSorted,
  isLocalCall,
  markBody,
  missingPupils,
  normalizeAlarms,
  openAlarms,
  overlayMarks,
  postMyMarks,
  pupilName,
  searchOtherPupils,
  markAway,
  silentTeachers,
  startAlarm,
  statusOf,
  stillRelevant,
  teacherBlocks,
  uncoveredCalls,
  unmarkedPupils,
  waitingKey,
  foundPlace,
  withSentMarks,
  type AlarmDetail,
  type AlarmSummary,
  type CallView,
  type FoundHere,
  type MyAlarm,
  type MyCall,
  type MyCrisisResponse,
  type OtherPupil,
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
  foundHere: [],
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
  foundFree: [],
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
    await expect(fetchAlarmList(3)).resolves.toMatchObject([{ id: 'a1' }]);
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
      away: 0,
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
    expect(c.counts).toEqual({ pupils: 3, found: 1, missing: 0, away: 0, absentBefore: 1, unreported: 1 });
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
    unlisted: 0,
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
      { studentId: 's1', name: 'Fs1 Ls1', groupName: '7A', basis: 'LESSON', callId: 'c1' },
      { studentId: 's3', name: 'Fs3 Ls3', groupName: '8B', basis: 'LESSON', callId: 'c2' },
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

// ─── Found with me: a pupil who is on none of the teacher's lists ────────────

const other = (id: string, first: string, last: string, className: string | null = null): OtherPupil => ({
  studentId: id,
  firstName: first,
  lastName: last,
  className,
});
const foundWith = (id: string, first: string, last: string, markedAt = iso(3_000)): FoundHere => ({
  studentId: id,
  firstName: first,
  lastName: last,
  className: null,
  markedAt,
});

describe('reading a list from a gateway before and after "found with me" and "not in the building"', () => {
  const old = (): unknown => ({
    asOf: iso(0),
    alarms: [
      {
        id: 'a1', kind: 'EVACUATION', mode: 'LIVE', startedAt: iso(0), startedBy: null, endedAt: null, endedBy: null, autoEnded: false, endNote: null,
        guardiansNotifiedAt: null,
        calls: [{ id: 'c1', lessonId: 'l1', basis: 'LESSON', groupName: '7A', subjectName: 'Matematik', roomName: null, lessonStartsAt: iso(0), lessonEndsAt: iso(1),
          completedAt: null, colleagues: [], counts: { pupils: 3, found: 1, missing: 1, absentBefore: 0, unreported: 1 }, pupils: [] }],
      },
    ],
  });

  it('reads a list from a gateway that has no `foundHere`, no `foundFree` and no `away` as lists that are empty and a figure that is nought', async () => {
    fetchMock.mockResolvedValueOnce(answer(200, old()));
    const mine = await fetchMyCrisis();
    expect(mine.alarms[0]!.foundFree).toEqual([]);
    expect(mine.alarms[0]!.calls[0]!.foundHere).toEqual([]);
    expect(mine.alarms[0]!.calls[0]!.counts).toEqual({ pupils: 3, found: 1, missing: 1, away: 0, absentBefore: 0, unreported: 1 });
  });

  it('reads both from a gateway that has them, and keeps the figure of pupils not in the building', async () => {
    const response = old() as { alarms: Array<{ foundFree?: unknown; calls: Array<{ foundHere?: unknown; counts: Record<string, number> }> }> };
    response.alarms[0]!.foundFree = [foundWith('s8', 'Åke', 'Ek')];
    response.alarms[0]!.calls[0]!.foundHere = [foundWith('s7', 'Maj', 'Moa')];
    response.alarms[0]!.calls[0]!.counts['away'] = 2;
    fetchMock.mockResolvedValueOnce(answer(200, response));
    const mine = await fetchMyCrisis();
    expect(mine.alarms[0]!.foundFree).toEqual([foundWith('s8', 'Åke', 'Ek')]);
    expect(mine.alarms[0]!.calls[0]!.foundHere).toEqual([foundWith('s7', 'Maj', 'Moa')]);
    expect(mine.alarms[0]!.calls[0]!.counts.away).toBe(2);
  });

  it('lets go of the pupils of the whole school that an earlier build kept with the list (`others`)', () => {
    const [read] = normalizeAlarms([{ ...alarm('a1', [call('c1', 'l1', [])]), others: [{ studentId: 's1', firstName: 'A', lastName: 'B', className: '7A' }] }]);
    expect(read).not.toHaveProperty('others');
    expect(read!.foundFree).toEqual([]);
  });

  it('leaves out an entry it cannot read rather than fail, and reads a blank class as none', () => {
    const [read] = normalizeAlarms([
      {
        ...alarm('a1', [call('c1', 'l1', [])]),
        foundFree: [foundWith('s1', 'Ok', 'Ok'), { firstName: 'No id' }, null, 'text', { studentId: 's2', firstName: 'No time' }],
        calls: [{ ...call('c1', 'l1', []), foundHere: [{ studentId: 's2', firstName: 'No time' }, null, { ...foundWith('s3', 'Fine', 'Fin'), className: '' }] }],
      },
    ]);
    expect(read!.foundFree).toEqual([foundWith('s1', 'Ok', 'Ok')]);
    expect(read!.calls[0]!.foundHere).toEqual([foundWith('s3', 'Fine', 'Fin')]);
  });

  it('reads an alarm with no calls, a list that is not a list, and a basis it does not know without failing', () => {
    const odd = { ...alarm('a1', []), calls: undefined, foundFree: 'many' } as unknown;
    expect(normalizeAlarms([odd])[0]).toMatchObject({ calls: [], foundFree: [] });
    const future = { ...call('c1', 'l1', []), basis: 'SOMETHING_NEW' } as unknown as MyCall;
    expect(normalizeAlarms([alarm('a1', [future])])[0]!.calls[0]!.basis).toBe('SOMETHING_NEW');
  });

  it('takes the group of pupils on no lesson (NO_LESSON) as any other, with no lesson of its own', async () => {
    const nobody = call('c9', null, [pupil('s1')], { basis: 'NO_LESSON', groupName: 'Utan lektion', subjectName: 'Ej i lektion', lessonStartsAt: iso(0), lessonEndsAt: iso(0) });
    fetchMock.mockResolvedValueOnce(answer(200, { asOf: iso(0), alarms: [alarm('a1', [nobody])] }));
    const mine = await fetchMyCrisis();
    expect(mine.alarms[0]!.calls[0]).toMatchObject({ basis: 'NO_LESSON', lessonId: null });
    const marks = overlayMarks(mine.alarms, [mark('m1', { callId: 'c9', studentId: 's1' })]);
    expect(marks.alarms[0]!.calls[0]!.pupils[0]!.status).toBe('FOUND');
  });

  it('asks with the signal it is given, so that a slow gateway can be given up on', async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(answer(200, old()));
    await fetchMyCrisis({ signal: controller.signal });
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].signal).toBe(controller.signal);
  });

  it('reads the administration’s figures from a gateway without `away` and `unlisted` as nought, and keeps them from one that has them', async () => {
    const summaryOf = (over: object) => ({ ...alarm('a1', []), calls: 2, callsComplete: 1, counts: { pupils: 4, found: 1, missing: 1, absentBefore: 1, unreported: 1 }, teachers: 1, teachersAnswered: 1, ...over });
    fetchMock.mockResolvedValueOnce(answer(200, [summaryOf({})]));
    const [older] = await fetchAlarmList();
    expect(older!.counts.away).toBe(0);
    expect(older!.unlisted).toBe(0);

    fetchMock.mockResolvedValueOnce(answer(200, [summaryOf({ unlisted: 6, counts: { pupils: 7, found: 1, missing: 0, away: 5, absentBefore: 0, unreported: 1 } })]));
    const [newer] = await fetchAlarmList();
    expect(newer!.counts.away).toBe(5);
    expect(newer!.unlisted).toBe(6);

    fetchMock.mockResolvedValueOnce(answer(200, { alarm: summaryOf({}), calls: [{ id: 'c1', counts: { pupils: 1, found: 0, missing: 1, absentBefore: 0, unreported: 0 }, pupils: [] }] }));
    const detail = await fetchAlarmDetail('a1');
    expect(detail.alarm.counts.away).toBe(0);
    expect(detail.calls[0]!.counts.away).toBe(0);
  });

  it('puts the missing-pupil list of the administration in words for the group of pupils on no lesson, with the call to mark them on', () => {
    const detail: AlarmDetail = {
      alarm: { ...alarm('a1', []), unlisted: 1, calls: 1, callsComplete: 0, counts: countPupils(['MISSING']), teachers: 0, teachersAnswered: 0 },
      calls: [
        {
          id: 'c9', lessonId: null, basis: 'NO_LESSON', groupName: 'Utan lektion', subjectName: 'Ej i lektion', roomName: null, lessonStartsAt: iso(0),
          lessonEndsAt: iso(0), completedAt: null, uncovered: true, teachers: [], counts: countPupils(['MISSING']), pupils: [pupil('s1', 'MISSING')],
        },
      ],
    };
    expect(missingPupils(detail)).toEqual([{ studentId: 's1', name: 'Fs1 Ls1', groupName: 'Utan lektion', basis: 'NO_LESSON', callId: 'c9' }]);
  });
});

describe('a pupil not in the building', () => {
  it('is a status of its own, counted for itself and never as found', () => {
    expect(countPupils(['FOUND', 'AWAY', 'AWAY', 'MISSING', 'ABSENT_BEFORE', 'UNREPORTED'])).toEqual({
      pupils: 6, found: 1, missing: 1, away: 2, absentBefore: 1, unreported: 1,
    });
    expect(statusOf('AWAY', null)).toBe('AWAY');
    expect(statusOf('AWAY', 'ATTENDANCE')).toBe('AWAY');
  });

  it('is not marked by "Alla finns", which asks for the pupils nobody has marked', () => {
    const c = call('c1', 'l1', [pupil('s1'), pupil('s2', 'AWAY'), pupil('s3', 'MISSING')]);
    expect(unmarkedPupils(c).map((p) => p.studentId)).toEqual(['s1']);
  });

  it('can still be found by a teacher who sees them: a mark overrules it, as it does "absent before"', () => {
    const list = [alarm('a1', [call('c1', 'l1', [pupil('s1', 'AWAY', { markedAt: iso(1_000) })])])];
    const { alarms } = overlayMarks(list, [mark('m1', { at: iso(5_000) })]);
    expect(alarms[0]!.calls[0]!.pupils[0]!.status).toBe('FOUND');
    expect(alarms[0]!.calls[0]!.counts).toMatchObject({ found: 1, away: 0 });
  });

  it('is said by the administration on the pupil’s own group, live, as a mark of state AWAY', async () => {
    fetchMock.mockResolvedValueOnce(answer(200, { stored: 1, duplicates: 0, unresolved: [] }));
    const result = await markAway({ id: 'a1', startedAt: iso(-60_000) }, 'c1', 's1', 'mark-1');
    expect(result).toEqual({ stored: 1, duplicates: 0, unresolved: [] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/alarms/a1/marks`);
    expect(init.method).toBe('POST');
    const { marks } = JSON.parse(init.body as string) as { marks: Array<Record<string, string>> };
    expect(marks).toEqual([{ id: 'mark-1', callId: 'c1', studentId: 's1', state: 'AWAY', at: expect.any(String) }]);
  });

  it('is never timed before the alarm began, whatever the phone’s clock says', async () => {
    fetchMock.mockResolvedValueOnce(answer(200, { stored: 1, duplicates: 0, unresolved: [] }));
    await markAway({ id: 'a1', startedAt: new Date(Date.now() + 3_600_000).toISOString() }, 'c1', 's1', 'mark-2');
    const { marks } = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as { marks: Array<{ at: string }> };
    expect(Date.parse(marks[0]!.at)).toBeGreaterThanOrEqual(Date.now() + 3_599_000);
  });
});

describe('markBody: exactly one of the call, the lesson and the alarm', () => {
  it('names the alarm for a teacher with no group, and says what a found with no group says', () => {
    expect(markBody(mark('m1', { callId: null, alarmId: 'a1' }))).toEqual({ id: 'm1', alarmId: 'a1', studentId: 's1', state: 'FOUND', at: iso(5_000) });
  });

  it('prefers the call, then the lesson, and carries a taking-back as the state RETRACTED', () => {
    expect(markBody(mark('m1', { state: 'RETRACTED' }))).toEqual({ id: 'm1', callId: 'c1', studentId: 's1', state: 'RETRACTED', at: iso(5_000) });
    expect(markBody(mark('m2', { callId: null, lessonId: 'l1' }))).toMatchObject({ lessonId: 'l1' });
    expect(markBody(mark('m2', { callId: null, lessonId: 'l1' }))).not.toHaveProperty('callId');
  });

  it('sends a mark of a pupil picked in the search without the name that only the pending row needs', async () => {
    fetchMock.mockResolvedValueOnce(answer(200, { stored: 1, duplicates: 0, unresolved: [] }));
    await postMyMarks([mark('m1', { callId: null, alarmId: 'a1', pupil: { firstName: 'Åsa', lastName: 'Lind', className: '7B' } })]);
    const { marks } = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as { marks: Array<Record<string, unknown>> };
    expect(Object.keys(marks[0]!).sort()).toEqual(['alarmId', 'at', 'id', 'state', 'studentId']);
  });
});

describe('the search for a pupil who is on none of the teacher’s lists', () => {
  it('asks the gateway with a POST, the alarm and the text in a JSON body and nothing in the URL, with the bearer', async () => {
    fetchMock.mockResolvedValueOnce(answer(200, [other('s20', 'Åsa', 'Lind', '7B')]));
    const found = await searchOtherPupils('a-1', 'Åsa L');
    expect(found).toEqual([other('s20', 'Åsa', 'Lind', '7B')]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // A pupil’s name is personal data: the gateway logs and echoes URLs, so none of it is in one.
    expect(url).toBe(`${BASE}/mine/pupils`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ alarmId: 'a-1', q: 'Åsa L' });
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer token');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('trims the text, asks with the signal it is given, and reads nothing of an answer that is not a list', async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(answer(200, { not: 'a list' }));
    await expect(searchOtherPupils('a-1', '  an  ', { signal: controller.signal })).resolves.toEqual([]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/mine/pupils`);
    expect(JSON.parse(init.body as string)).toEqual({ alarmId: 'a-1', q: 'an' });
    expect(init.signal).toBe(controller.signal);
  });

  it('leaves out an entry it cannot read, and reads at most as many as the gateway gives', async () => {
    const many = Array.from({ length: 40 }, (_, i) => other(`s${i}`, `F${i}`, 'L'));
    fetchMock.mockResolvedValueOnce(answer(200, [{ firstName: 'No id' }, null, ...many]));
    const found = await searchOtherPupils('a-1', 'f');
    expect(SEARCH_MIN_CHARS).toBe(2);
    expect(SEARCH_LIMIT).toBe(25);
    expect(found).toHaveLength(25);
    expect(found[0]!.studentId).toBe('s0');
  });

  it('fails as any request does: a refusal is an ApiError, and no network a failure of the phone’s own', async () => {
    fetchMock.mockResolvedValueOnce(answer(404, { message: 'x', code: 'CRISIS_ALARM_NOT_FOUND' }));
    await expect(searchOtherPupils('a-1', 'an')).rejects.toBeInstanceOf(ApiError);
    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
    await expect(searchOtherPupils('a-1', 'an')).rejects.toBeInstanceOf(TypeError);
  });
});

describe('overlayMarks: "found with me"', () => {
  const list = (over: Partial<MyAlarm> = {}): MyAlarm[] => [alarm('a1', [call('c1', 'l1', [pupil('s1'), pupil('s2')])], over)];
  const asPicked = (id: string, first: string, last: string, className: string | null = null) => ({ studentId: id, pupil: { firstName: first, lastName: last, className } });

  it('puts a FOUND mark for a pupil who is not on the list under the call as found here, by the name the mark carries, waiting', () => {
    const { alarms, waiting } = overlayMarks(list(), [mark('m1', asPicked('s20', 'Åsa', 'Lind', '7B'))]);
    const c = alarms[0]!.calls[0]!;
    expect(c.foundHere).toEqual([{ studentId: 's20', firstName: 'Åsa', lastName: 'Lind', className: '7B', markedAt: iso(5_000) }]);
    expect([...waiting]).toEqual(['c1:s20']);
    // They count on their own list, not on this one.
    expect(c.counts).toEqual({ pupils: 2, found: 0, missing: 0, away: 0, absentBefore: 0, unreported: 2 });
    expect(c.pupils.map((p) => p.status)).toEqual(['UNREPORTED', 'UNREPORTED']);
  });

  it('puts a teacher’s pupil found with no group under the alarm, where the pending row finds them', () => {
    const { alarms, waiting } = overlayMarks(list(), [mark('m1', { callId: null, alarmId: 'a1', ...asPicked('s20', 'Åsa', 'Lind', '7B') })]);
    expect(alarms[0]!.foundFree).toEqual([{ studentId: 's20', firstName: 'Åsa', lastName: 'Lind', className: '7B', markedAt: iso(5_000) }]);
    expect(alarms[0]!.calls[0]!.foundHere).toEqual([]);
    expect([...waiting]).toEqual(['alarm:a1:s20']);
    expect(waitingKey(foundPlace('a1', null), 's20')).toBe('alarm:a1:s20');
    expect(waitingKey(foundPlace('a1', { id: 'c1' }), 's20')).toBe('c1:s20');
  });

  it('draws nothing for a found that carries no name and that no group of the teacher’s can name', () => {
    const { alarms, waiting } = overlayMarks(list(), [mark('m1', { studentId: 'nobody-knows' })]);
    expect(alarms[0]!.calls[0]!.foundHere).toEqual([]);
    expect(waiting.size).toBe(0);
  });

  it('never draws MISSING for a pupil who is not on the list: the gateway refuses it', () => {
    const { alarms, waiting } = overlayMarks(list(), [mark('m1', { ...asPicked('s20', 'Åsa', 'Lind'), state: 'MISSING' })]);
    expect(alarms).toEqual(list());
    expect(waiting.size).toBe(0);
  });

  it('shows a pupil once, whatever the number of taps', () => {
    const twice = overlayMarks(list(), [mark('m1', { ...asPicked('s20', 'Åsa', 'Lind'), at: iso(1_000) }), mark('m2', { ...asPicked('s20', 'Åsa', 'Lind'), at: iso(2_000) })]);
    expect(twice.alarms[0]!.calls[0]!.foundHere).toHaveLength(1);
    expect(twice.alarms[0]!.calls[0]!.foundHere[0]!.markedAt).toBe(iso(2_000));
  });

  it('leaves the gateway’s own entry as it is, and only says the mark waits', () => {
    const held = list();
    const withHeld = [{ ...held[0]!, calls: [{ ...held[0]!.calls[0]!, foundHere: [foundWith('s20', 'Åsa', 'Lind', iso(1_000))] }] }];
    const { alarms, waiting } = overlayMarks(withHeld, [mark('m1', asPicked('s20', 'Åsa', 'Lind'))]);
    expect(alarms[0]!.calls[0]!.foundHere).toEqual([foundWith('s20', 'Åsa', 'Lind', iso(1_000))]);
    expect(waiting.has('c1:s20')).toBe(true);
  });

  it('names a pupil of another of the teacher’s groups from that group’s list', () => {
    const two = [alarm('a1', [call('c1', 'l1', [pupil('s1')]), call('c2', 'l2', [pupil('s5')])])];
    const { alarms } = overlayMarks(two, [mark('m1', { callId: 'c1', studentId: 's5' })]);
    expect(alarms[0]!.calls[0]!.foundHere).toMatchObject([{ studentId: 's5', firstName: 'Fs5', lastName: 'Ls5', className: null }]);
  });

  it('writes a sent mark into the kept list, so that the pupil is there when the network is gone', () => {
    const kept = withSentMarks({ asOf: iso(1_000), alarms: list() }, [
      mark('m1', asPicked('s21', 'Kalle', 'Lund', '7C')),
      mark('m2', { callId: null, alarmId: 'a1', ...asPicked('s22', 'Maja', 'Moa') }),
    ]);
    expect(kept.alarms[0]!.calls[0]!.foundHere.map((f) => f.studentId)).toEqual(['s21']);
    expect(kept.alarms[0]!.foundFree.map((f) => f.studentId)).toEqual(['s22']);
    expect(kept.asOf).toBe(iso(1_000));
  });

  it('lets a mark for a call or an alarm the list does not hold change nothing', () => {
    const lonely = list();
    expect(overlayMarks(lonely, [mark('m1', { callId: 'elsewhere', ...asPicked('s20', 'Åsa', 'Lind') })]).alarms).toBe(lonely);
    expect(overlayMarks(lonely, [mark('m3', { callId: null, alarmId: 'elsewhere', ...asPicked('s20', 'Åsa', 'Lind') })]).alarms).toBe(lonely);
  });

  it('sorts the pupils found here by name, Swedish order', () => {
    const found = [foundWith('a', 'Örjan', 'Berg'), foundWith('b', 'Åsa', 'Berg'), foundWith('c', 'Anna', 'Berg')];
    expect(foundHereSorted(found).map((f) => f.firstName)).toEqual(['Anna', 'Åsa', 'Örjan']);
  });
});

describe('overlayMarks: taking a pupil found with me back', () => {
  const held = (): MyAlarm[] => [
    alarm('a1', [call('c1', 'l1', [pupil('s1')], { foundHere: [foundWith('s20', 'Åsa', 'Lind')] })], { foundFree: [foundWith('s30', 'Nils', 'Ek')] }),
  ];

  it('removes a pupil the gateway holds from the call at once, and from the alarm for one found with no group', () => {
    const { alarms } = overlayMarks(held(), [
      mark('r1', { studentId: 's20', state: 'RETRACTED', at: iso(6_000) }),
      mark('r2', { callId: null, alarmId: 'a1', studentId: 's30', state: 'RETRACTED', at: iso(6_000) }),
    ]);
    expect(alarms[0]!.calls[0]!.foundHere).toEqual([]);
    expect(alarms[0]!.foundFree).toEqual([]);
  });

  it('is nothing to draw for a pupil the gateway does not hold, and takes a found that is waiting out again', () => {
    const none = [alarm('a1', [call('c1', 'l1', [pupil('s1')])])];
    const found = mark('m1', { studentId: 's9', pupil: { firstName: 'Ny', lastName: 'Elev', className: null }, at: iso(1_000) });
    const back = mark('r1', { studentId: 's9', state: 'RETRACTED', at: iso(2_000) });
    const { alarms, waiting } = overlayMarks(none, [found, back]);
    expect(alarms[0]!.calls[0]!.foundHere).toEqual([]);
    expect(waiting.size).toBe(0);
  });

  it('keeps the order of the taps: found, taken back, found again is found', () => {
    const asPupil = { pupil: { firstName: 'Åsa', lastName: 'Lind', className: null } };
    const { alarms, waiting } = overlayMarks(held(), [
      mark('r1', { studentId: 's20', state: 'RETRACTED', at: iso(6_000) }),
      mark('f2', { studentId: 's20', state: 'FOUND', at: iso(7_000), ...asPupil }),
    ]);
    expect(alarms[0]!.calls[0]!.foundHere.map((f) => f.studentId)).toEqual(['s20']);
    expect(waiting.has('c1:s20')).toBe(true);
  });

  it('is nothing to a pupil of the list: only the pupils found with the teacher can be taken back', () => {
    const list = [alarm('a1', [call('c1', 'l1', [pupil('s1', 'FOUND')])])];
    const { alarms } = overlayMarks(list, [mark('r1', { studentId: 's1', state: 'RETRACTED' })]);
    expect(alarms[0]!.calls[0]!.pupils[0]!.status).toBe('FOUND');
    expect(alarms).toBe(list);
  });

  it('writes a sent taking-back into the kept list, so that the pupil stays gone offline', () => {
    const kept = withSentMarks({ asOf: iso(1_000), alarms: held() }, [mark('r1', { studentId: 's20', state: 'RETRACTED' })]);
    expect(kept.alarms[0]!.calls[0]!.foundHere).toEqual([]);
    expect(kept.alarms[0]!.foundFree).toHaveLength(1);
  });
});

describe('teacherBlocks and the pupils found with no group', () => {
  it('carries the alarm’s foundFree, and none for a list the phone built', () => {
    const response: MyCrisisResponse = { asOf: iso(0), alarms: [alarm('a1', [], { foundFree: [foundWith('s9', 'Nils', 'Ek')] })] };
    const local = [call(`${LOCAL_CALL_PREFIX}l7`, 'l7', [pupil('s2')])];
    const { blocks } = teacherBlocks({ response, local, pending: [], hint: { alarmAt: T0, endedAt: null }, now: T0 + 60_000 });
    expect(blocks.map((b) => [b.key, b.foundFree.length])).toEqual([['a1', 1], [LOCAL_ALARM_ID, 0]]);
  });

  it('shows an alarm in which the teacher has no group, with the pupils they found in it', () => {
    const response: MyCrisisResponse = { asOf: iso(0), alarms: [alarm('a1', [])] };
    const pending = [mark('m1', { callId: null, alarmId: 'a1', studentId: 's9', pupil: { firstName: 'Nils', lastName: 'Ek', className: '8A' } })];
    const { blocks, waiting } = teacherBlocks({ response, local: [], pending, hint: null, now: T0 + 60_000 });
    expect(blocks[0]!.calls).toEqual([]);
    expect(blocks[0]!.foundFree.map((f) => [f.studentId, f.className])).toEqual([['s9', '8A']]);
    expect(waiting.has('alarm:a1:s9')).toBe(true);
  });
});
