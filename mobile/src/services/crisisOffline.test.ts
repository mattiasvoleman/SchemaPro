import * as Notifications from 'expo-notifications';
import { SecureTokenStore } from './auth/secureTokenStore';
import { fake, api as database } from './__testing__/crisisDatabase';
import { alarm as gatewayAlarm, at, gateway, mineOf, sevenA } from './__testing__/crisisGateway';
import { readCachedCrisis, saveCachedCrisis, patchCachedCrisis } from './crisisCache';
import {
  HINT_TTL_MS,
  TRAY_MAX_AGE_MS,
  crisisPushOf,
  handleCrisisPush,
  loadLocalCalls,
  needsLocalList,
  pushTimeMs,
  readAlarmHint,
  rememberCrisisPush,
  rememberPresentedCrisisPushes,
  resetAlarmHintForTests,
  subscribeAlarmHint,
} from './crisisOffline';
import { countPupils, type MyAlarm, type MyCall, type MyCrisisResponse } from './crisis';

jest.mock('./database/localDatabase', () => require('./__testing__/crisisDatabase').api);
jest.mock('expo-notifications', () => ({ getPresentedNotificationsAsync: jest.fn() }));
jest.mock('./auth/secureTokenStore', () => ({ SecureTokenStore: { getTeacherSession: jest.fn() } }));
jest.mock('./supabase', () => ({ getAccessToken: jest.fn(async () => 'token'), getSupabase: jest.fn() }));

/**
 * What the phone knows of an alarm when the gateway has not told it: the time
 * an alarm push arrived (the one thing a phone with no coverage gets), the
 * list the phone kept, and the list it builds. Under TZ=UTC.
 */

const T0 = Date.parse('2027-01-12T09:15:00.000Z');
const push = (type: string, date: number = T0): unknown => ({ date, request: { content: { data: { notificationId: 'n-1', type } } } });

beforeEach(() => {
  fake.reset();
  resetAlarmHintForTests();
  jest.mocked(Notifications.getPresentedNotificationsAsync).mockReset();
});

describe('when a push arrived', () => {
  it('reads iOS’s seconds and Android’s milliseconds alike', () => {
    expect(pushTimeMs(T0 / 1000)).toBe(T0);
    expect(pushTimeMs(T0)).toBe(T0);
    expect(pushTimeMs(1_800_000_000.5)).toBe(1_800_000_000_500);
  });

  it.each([[undefined], [null], ['2027-01-12'], [0], [-5], [NaN]])('reads %s as no time', (value) => {
    expect(pushTimeMs(value)).toBeNull();
  });

  it('finds the alarm and the end in a notification, and nothing in any other', () => {
    expect(crisisPushOf(push('CRISIS_ALARM'))).toEqual({ type: 'CRISIS_ALARM', at: T0 });
    expect(crisisPushOf(push('CRISIS_ENDED'))).toEqual({ type: 'CRISIS_ENDED', at: T0 });
    for (const other of [push('COVER_REQUESTED'), push('CRISIS_GUARDIAN_AFTER'), null, undefined, {}, { request: {} }]) {
      expect(crisisPushOf(other)).toBeNull();
    }
  });

  it('takes the moment it is handled when the notification has no time', () => {
    const noTime = { request: { content: { data: { type: 'CRISIS_ALARM' } } } };
    expect(crisisPushOf(noTime, 12_345)).toEqual({ type: 'CRISIS_ALARM', at: 12_345 });
  });
});

describe('remembering an alarm push', () => {
  it('keeps the time in memory at once and in the database when it is open', async () => {
    await rememberCrisisPush(push('CRISIS_ALARM'));
    expect(fake.hint).toEqual({ alarmAt: new Date(T0).toISOString(), endedAt: null });
    expect(await readAlarmHint(T0 + 60_000)).toEqual({ alarmAt: T0, endedAt: null });
  });

  it('keeps the latest time of each: a push delivered late does not move it back', async () => {
    await rememberCrisisPush(push('CRISIS_ALARM', T0 + 60_000));
    await rememberCrisisPush(push('CRISIS_ALARM', T0));
    await rememberCrisisPush(push('CRISIS_ENDED', T0 + 600_000));
    expect(await readAlarmHint(T0 + 700_000)).toEqual({ alarmAt: T0 + 60_000, endedAt: T0 + 600_000 });
  });

  it('knows an alarm from memory when the database is not open yet, and writes it when it is', async () => {
    let open!: () => void;
    const ready = new Promise<void>((done) => {
      open = done;
    });
    const wait = jest.spyOn(database, 'whenDatabaseReady').mockReturnValueOnce(ready);
    const remembering = rememberCrisisPush(push('CRISIS_ALARM'));
    // A tap that launched the app is handled before the database is open: the screen still knows.
    jest.spyOn(database, 'getCrisisHint').mockRejectedValueOnce(new Error('not initialized'));
    expect(await readAlarmHint(T0 + 1_000)).toEqual({ alarmAt: T0, endedAt: null });
    expect(fake.hint).toBeNull();
    open();
    await remembering;
    expect(fake.hint?.alarmAt).toBe(new Date(T0).toISOString());
    wait.mockRestore();
  });

  it('ignores a push that is not about an alarm, and a database that cannot be written', async () => {
    await rememberCrisisPush(push('LESSON_CANCELLED'));
    expect(fake.hint).toBeNull();
    jest.spyOn(database, 'saveCrisisAlarmHint').mockRejectedValueOnce(new Error('disk full'));
    await expect(rememberCrisisPush(push('CRISIS_ALARM'))).resolves.toBeUndefined();
    expect((await readAlarmHint(T0 + 1_000))?.alarmAt).toBe(T0);
  });

  it('does not read a banner left in the tray for longer than a quarter of an hour: it may be from an alarm long over', async () => {
    jest.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([push('CRISIS_ALARM', T0)] as never);
    await rememberPresentedCrisisPushes(T0 + TRAY_MAX_AGE_MS + 1);
    expect(await readAlarmHint(T0 + TRAY_MAX_AGE_MS + 1)).toBeNull();
    await rememberPresentedCrisisPushes(T0 + TRAY_MAX_AGE_MS);
    expect((await readAlarmHint(T0 + TRAY_MAX_AGE_MS))?.alarmAt).toBe(T0);
  });

  it('reads the pushes still in the tray, for a teacher who opens the app by hand', async () => {
    jest.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([push('LESSON_CANCELLED'), push('CRISIS_ALARM', T0 + 2_000)] as never);
    await rememberPresentedCrisisPushes();
    expect(await readAlarmHint(T0 + 5_000)).toEqual({ alarmAt: T0 + 2_000, endedAt: null });
  });

  it('is not troubled by a tray it cannot read', async () => {
    jest.mocked(Notifications.getPresentedNotificationsAsync).mockRejectedValue(new Error('no tray'));
    await expect(rememberPresentedCrisisPushes()).resolves.toBeUndefined();
    expect(await readAlarmHint(T0)).toBeNull();
  });
});

describe('what the phone believes, and for how long', () => {
  it('knows nothing before any push', async () => {
    expect(await readAlarmHint(T0)).toBeNull();
  });

  it('believes an alarm push for as long as an alarm can stand, twelve hours, so that an evacuation with no coverage keeps its list', async () => {
    expect(HINT_TTL_MS).toBe(12 * 60 * 60_000);
    await rememberCrisisPush(push('CRISIS_ALARM'));
    expect(await readAlarmHint(T0 + HINT_TTL_MS)).not.toBeNull();
    expect(await readAlarmHint(T0 + HINT_TTL_MS + 1)).toBeNull();
  });

  it('dates a hint by the push\'s own time, not by when the phone looked at it', async () => {
    // A push with a time of its own is dated by it.
    await rememberCrisisPush(push('CRISIS_ALARM', T0), T0 + 30 * 60_000);
    expect(await readAlarmHint(T0 + 30 * 60_000)).toEqual({ alarmAt: T0, endedAt: null });
    // One without a time of its own is dated by the moment it is handled.
    resetAlarmHintForTests();
    fake.reset();
    await rememberCrisisPush({ request: { content: { data: { type: 'CRISIS_ALARM' } } } }, T0 + 30 * 60_000);
    expect(await readAlarmHint(T0 + 31 * 60_000)).toEqual({ alarmAt: T0 + 30 * 60_000, endedAt: null });
  });

  it('keeps a stored time of the database when memory is empty (the app was started again)', async () => {
    fake.hint = { alarmAt: new Date(T0).toISOString(), endedAt: new Date(T0 + 60_000).toISOString() };
    expect(await readAlarmHint(T0 + 120_000)).toEqual({ alarmAt: T0, endedAt: T0 + 60_000 });
  });

  it('holds an end push alone, to close a list the phone kept', async () => {
    await rememberCrisisPush(push('CRISIS_ENDED'));
    expect(await readAlarmHint(T0 + 1_000)).toEqual({ alarmAt: null, endedAt: T0 });
  });
});

describe('handleCrisisPush: a push is put to the gateway before it is believed', () => {
  const sent = (date: number = T0): unknown => push('CRISIS_ALARM', date);
  const reads = () => gateway.to('GET', '/api/v1/crisis/mine').length;
  const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };

  beforeEach(() => {
    // A little after the push: the phone was off for half a minute.
    jest.useFakeTimers({ now: T0 + 30_000, doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'performance'] });
    gateway.install();
    jest.mocked(SecureTokenStore.getTeacherSession).mockResolvedValue({ teacherId: 't-1', role: 'TEACHER', authId: null });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('remembers the alarm when the gateway says it is going, and keeps the list it gave for the phone that loses its network', async () => {
    gateway.mine = () => ({ status: 200, body: mineOf([gatewayAlarm('a1', [sevenA()])], at('09:15')) });
    await expect(handleCrisisPush(sent())).resolves.toBe('GOING');
    expect(reads()).toBe(1);
    expect(fake.hint).toEqual({ alarmAt: new Date(T0).toISOString(), endedAt: null });
    const kept = await readCachedCrisis('t-1');
    expect(kept?.response.alarms.map((a) => a.id)).toEqual(['a1']);
    expect(kept?.asOf).toBe(at('09:15'));
  });

  it('does not replace a list the phone kept later than the one the gateway just gave', async () => {
    await saveCachedCrisis('t-1', mineOf([gatewayAlarm('newer', [])], at('09:16')));
    gateway.mine = () => ({ status: 200, body: mineOf([gatewayAlarm('a1', [sevenA()])], at('09:15')) });
    await handleCrisisPush(sent());
    expect((await readCachedCrisis('t-1'))?.response.alarms.map((a) => a.id)).toEqual(['newer']);
  });

  it('believes nothing of a late push whose alarm has ended: no hint, so no list built from it, and the alarm shown as the gateway shows it', async () => {
    gateway.mine = () => ({ status: 200, body: mineOf([gatewayAlarm('a1', [sevenA()], { endedAt: at('09:12') })], at('09:15')) });
    await expect(handleCrisisPush(sent())).resolves.toBe('OVER');
    expect(fake.hint).toBeNull();
    expect(await readAlarmHint(T0 + 30_000)).toBeNull();
  });

  it('believes nothing of a late push when the gateway knows of no alarm at all', async () => {
    gateway.mine = () => ({ status: 200, body: mineOf([], at('09:15')) });
    await expect(handleCrisisPush(sent())).resolves.toBe('OVER');
    expect(await readAlarmHint(T0 + 30_000)).toBeNull();
  });

  it('forgets what an earlier push made it believe, but not what a later push did', async () => {
    gateway.mine = () => ({ status: 200, body: mineOf([], at('09:15')) });
    await rememberCrisisPush(push('CRISIS_ALARM', T0 - 60_000));
    await handleCrisisPush(sent());
    expect(await readAlarmHint(T0 + 30_000)).toBeNull();

    // Another alarm's push, sent after this one: the answer was not about it.
    await rememberCrisisPush(push('CRISIS_ALARM', T0 + 60_000));
    await handleCrisisPush(sent(T0 + 1_000));
    expect(await readAlarmHint(T0 + 90_000)).toEqual({ alarmAt: T0 + 60_000, endedAt: null });
  });

  it('keeps the end it was told of when it forgets the alarm', async () => {
    gateway.mine = () => ({ status: 200, body: mineOf([], at('09:15')) });
    await rememberCrisisPush(push('CRISIS_ENDED', T0 - 5_000));
    await handleCrisisPush(sent());
    expect(fake.hint).toEqual({ alarmAt: null, endedAt: new Date(T0 - 5_000).toISOString() });
  });

  it('does as it always did when the gateway cannot be reached: believes the push, while it is fresh', async () => {
    gateway.down = true;
    await expect(handleCrisisPush(sent())).resolves.toBe('UNKNOWN');
    expect(await readAlarmHint(T0 + 14 * 60_000)).toEqual({ alarmAt: T0, endedAt: null });
    // Still there an hour in, with no coverage: the evacuation is the case this is for. And not past the twelve hours an alarm can stand.
    expect(await readAlarmHint(T0 + 60 * 60_000)).toEqual({ alarmAt: T0, endedAt: null });
    expect(await readAlarmHint(T0 + HINT_TTL_MS + 1)).toBeNull();
  });

  it.each([
    ['a 500', { status: 500, body: { message: 'x' } }],
    ['a refused bearer', { status: 401, body: { message: 'x' } }],
  ])('treats %s as a gateway that could not say', async (_name, answer) => {
    gateway.mine = () => answer;
    await expect(handleCrisisPush(sent())).resolves.toBe('UNKNOWN');
    expect((await readAlarmHint(T0 + 60_000))?.alarmAt).toBe(T0);
  });

  it('goes on after five seconds without an answer, and lets the answer correct it when it comes', async () => {
    const slow = deferred<{ status: number; body: unknown }>();
    gateway.mine = () => slow.promise as never;
    const handling = handleCrisisPush(sent());
    await jest.advanceTimersByTimeAsync(4_999);
    expect(fake.hint).toBeNull();
    await jest.advanceTimersByTimeAsync(1);
    await expect(handling).resolves.toBe('UNKNOWN');
    // Remembered, as for a phone with no network.
    expect((await readAlarmHint(T0 + 60_000))?.alarmAt).toBe(T0);

    // The gateway answers after all: the alarm is over, and the hint goes.
    slow.resolve({ status: 200, body: mineOf([], at('09:15')) });
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(0);
    expect(await readAlarmHint(T0 + 60_000)).toBeNull();
  });

  it('asks about a push once, however many ways it comes to the phone', async () => {
    gateway.mine = () => ({ status: 200, body: mineOf([gatewayAlarm('a1', [sevenA()])], at('09:15')) });
    await handleCrisisPush(sent());
    await expect(handleCrisisPush(sent())).resolves.toBe('GOING');
    expect(reads()).toBe(1);
    // A push sent at another time is another push.
    await handleCrisisPush(sent(T0 + 60_000));
    expect(reads()).toBe(2);
  });

  it('asks again about a push the gateway could not say anything of', async () => {
    gateway.down = true;
    await handleCrisisPush(sent());
    gateway.down = false;
    gateway.mine = () => ({ status: 200, body: mineOf([], at('09:15')) });
    await expect(handleCrisisPush(sent())).resolves.toBe('OVER');
    expect(await readAlarmHint(T0 + 60_000)).toBeNull();
  });

  it('asks nothing of the gateway for an administrator’s phone, or one nobody is signed in on, and remembers the push as before', async () => {
    jest.mocked(SecureTokenStore.getTeacherSession).mockResolvedValueOnce({ teacherId: 'a-1', role: 'SCHOOL_ADMIN', authId: null });
    await expect(handleCrisisPush(sent())).resolves.toBe('UNKNOWN');
    jest.mocked(SecureTokenStore.getTeacherSession).mockResolvedValueOnce(null);
    await expect(handleCrisisPush(sent(T0 + 1_000))).resolves.toBe('UNKNOWN');
    expect(reads()).toBe(0);
    expect((await readAlarmHint(T0 + 60_000))?.alarmAt).toBe(T0 + 1_000);
  });

  it('remembers an end at once and asks nothing: it only closes an alarm that began before it', async () => {
    await expect(handleCrisisPush(push('CRISIS_ENDED'))).resolves.toBeNull();
    expect(reads()).toBe(0);
    expect(await readAlarmHint(T0 + 1_000)).toEqual({ alarmAt: null, endedAt: T0 });
  });

  it('has nothing to do with a push that is not about an alarm', async () => {
    await expect(handleCrisisPush(push('COVER_REQUESTED'))).resolves.toBeNull();
    await expect(handleCrisisPush(null)).resolves.toBeNull();
    expect(reads()).toBe(0);
    expect(fake.hint).toBeNull();
  });

  it('puts the alarm push still in the tray to the gateway too, and not again at every glance at the tray', async () => {
    jest.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([sent()] as never);
    gateway.mine = () => ({ status: 200, body: mineOf([], at('09:15')) });
    await rememberPresentedCrisisPushes();
    expect(reads()).toBe(1);
    expect(await readAlarmHint(T0 + 60_000)).toBeNull();
    await rememberPresentedCrisisPushes();
    expect(reads()).toBe(1);
  });

  it('tells the screen that the hint changed, when it was remembered and when it was forgotten', async () => {
    const heard = jest.fn();
    const stop = subscribeAlarmHint(heard);
    gateway.mine = () => ({ status: 200, body: mineOf([gatewayAlarm('a1', [sevenA()])], at('09:15')) });
    await handleCrisisPush(sent());
    expect(heard).toHaveBeenCalledTimes(1);
    gateway.mine = () => ({ status: 200, body: mineOf([], at('09:16')) });
    await handleCrisisPush(sent(T0 + 20_000));
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
    await handleCrisisPush(sent(T0 + 40_000));
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('is not troubled by a database that cannot be written', async () => {
    gateway.mine = () => ({ status: 200, body: mineOf([], at('09:15')) });
    jest.spyOn(database, 'clearCrisisAlarmHint').mockRejectedValueOnce(new Error('disk full'));
    await expect(handleCrisisPush(sent())).resolves.toBe('OVER');
  });
});

describe('needsLocalList', () => {
  const alarm = (startedAt: number): MyAlarm => ({
    id: 'a1', kind: 'EVACUATION', mode: 'LIVE', startedAt: new Date(startedAt).toISOString(), startedBy: null, endedAt: null,
    endedBy: null, autoEnded: false, endNote: null, guardiansNotifiedAt: null, calls: [], others: [],
  });
  const list = (asOf: number, ...alarms: MyAlarm[]): MyCrisisResponse => ({ asOf: new Date(asOf).toISOString(), alarms });
  const told = { alarmAt: T0, endedAt: null };

  it('is no when the phone was told of nothing, or of an end after the alarm', () => {
    expect(needsLocalList(null, null)).toBe(false);
    expect(needsLocalList({ alarmAt: null, endedAt: T0 }, null)).toBe(false);
    expect(needsLocalList({ alarmAt: T0, endedAt: T0 + 1 }, null)).toBe(false);
    // An end older than the alarm is another alarm's.
    expect(needsLocalList({ alarmAt: T0, endedAt: T0 - 1 }, null)).toBe(true);
  });

  it('is yes when an alarm was told of and no list was ever read, or one read before it began', () => {
    expect(needsLocalList(told, null)).toBe(true);
    expect(needsLocalList(told, list(T0 - 600_000))).toBe(true);
    // An old alarm in the kept list is not this one.
    expect(needsLocalList(told, list(T0 - 600_000, alarm(T0 - 3_600_000)))).toBe(true);
  });

  it('is no when a list holds an alarm that began around the time of the push', () => {
    expect(needsLocalList(told, list(T0 - 1, alarm(T0 - 30_000)))).toBe(false);
    expect(needsLocalList(told, list(T0 - 1, alarm(T0 + 30_000)))).toBe(false);
    expect(needsLocalList(told, list(T0 - 1, alarm(T0 - 14 * 60_000)))).toBe(false);
    expect(needsLocalList(told, list(T0 - 1, alarm(T0 - 16 * 60_000)))).toBe(true);
  });

  it('is no when a list was read after the push: the gateway knew of the alarm then, and its answer, even an empty one, stands', () => {
    expect(needsLocalList(told, list(T0))).toBe(false);
    expect(needsLocalList(told, list(T0 + 5_000))).toBe(false);
  });
});

describe('loadLocalCalls: the list from what the phone holds', () => {
  it('builds it from the cached lessons and pupils, and shows who the teacher marked absent in the register', async () => {
    fake.lessons = [
      { id: 'l1', startTime: '2027-01-12T09:00:00.000Z', endTime: '2027-01-12T09:50:00.000Z', subjectName: 'Matematik', roomName: 'B204', studentIds: ['s1', 's2'] },
    ];
    fake.names.set('s1', 'Alva Elev');
    fake.names.set('s2', 'Bo Berg');
    fake.register.set('t-1', new Map([['l1', new Set(['s2'])]]));
    fake.register.set('t-2', new Map([['l1', new Set(['s1'])]]));

    const calls = await loadLocalCalls(T0, 't-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ id: 'local:l1', lessonId: 'l1', basis: 'LESSON' });
    // This teacher's register, not a colleague's.
    expect(calls[0]!.pupils.map((p) => [p.firstName, p.status])).toEqual([
      ['Alva Elev', 'UNREPORTED'],
      ['Bo Berg', 'ABSENT_BEFORE'],
    ]);
  });

  it('is nothing for a phone that holds no lesson', async () => {
    await expect(loadLocalCalls(T0, 't-1')).resolves.toEqual([]);
  });
});

describe('the kept list', () => {
  const call: MyCall = {
    id: 'c1', lessonId: 'l1', basis: 'LESSON', groupName: '7A', subjectName: 'Matematik', roomName: null,
    lessonStartsAt: '2027-01-12T09:00:00.000Z', lessonEndsAt: '2027-01-12T09:50:00.000Z', completedAt: null, colleagues: [],
    counts: countPupils(['UNREPORTED']),
    pupils: [{ studentId: 's1', firstName: 'Alva', lastName: 'Elev', status: 'UNREPORTED', priorAbsentSource: null, markedAt: null }],
    foundHere: [],
  };
  const response: MyCrisisResponse = {
    asOf: '2027-01-12T09:10:00.000Z',
    alarms: [
      { id: 'a1', kind: 'EVACUATION', mode: 'LIVE', startedAt: '2027-01-12T09:05:00.000Z', startedBy: null, endedAt: null, endedBy: null, autoEnded: false, endNote: null, guardiansNotifiedAt: null, calls: [call], others: [] },
    ],
  };

  it('is one list per teacher: a colleague’s pupils are not shown to the next person', async () => {
    await saveCachedCrisis('t-1', response);
    expect((await readCachedCrisis('t-1'))?.response).toEqual(response);
    expect((await readCachedCrisis('t-1'))?.asOf).toBe(response.asOf);
    expect(await readCachedCrisis('t-2')).toBeNull();
  });

  it('is read only once the database is open', async () => {
    await saveCachedCrisis('t-1', response);
    let open!: () => void;
    const ready = new Promise<void>((done) => {
      open = done;
    });
    const wait = jest.spyOn(database, 'whenDatabaseReady').mockReturnValueOnce(ready);
    const reading = readCachedCrisis('t-1');
    let settled = false;
    void reading.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    open();
    expect((await reading)?.response).toEqual(response);
    wait.mockRestore();
  });

  it('reads a list kept before "found with me" with neither `foundHere` nor `others` as lists that are empty', async () => {
    const before = JSON.parse(JSON.stringify(response)) as { alarms: Array<{ others?: unknown; calls: Array<{ foundHere?: unknown }> }> };
    delete before.alarms[0]!.others;
    delete before.alarms[0]!.calls[0]!.foundHere;
    fake.lists.set('t-1', { asOf: response.asOf, payload: JSON.stringify(before) });
    const kept = await readCachedCrisis('t-1');
    expect(kept?.response.alarms[0]!.others).toEqual([]);
    expect(kept?.response.alarms[0]!.calls[0]!.foundHere).toEqual([]);
  });

  it('keeps the alarm’s other pupils and the pupils found here with the list, for the picker without a network', async () => {
    const withOthers: MyCrisisResponse = {
      ...response,
      alarms: [
        {
          ...response.alarms[0]!,
          calls: [{ ...call, foundHere: [{ studentId: 's7', firstName: 'Maj', lastName: 'Moa', className: '7B', markedAt: '2027-01-12T09:08:00.000Z' }] }],
          others: Array.from({ length: 1000 }, (_, i) => ({ studentId: `o${i}`, firstName: `Elev${i}`, lastName: 'Test', className: `${(i % 9) + 1}A` })),
        },
      ],
    };
    await saveCachedCrisis('t-1', withOthers);
    expect((await readCachedCrisis('t-1'))?.response).toEqual(withOthers);
    // A school of a thousand is some hundred kilobytes of JSON, written once per answer.
    expect(fake.lists.get('t-1')!.payload.length).toBeLessThan(150_000);
  });

  it('is none, not a crash, when what is kept cannot be read', async () => {
    for (const payload of ['not json', '{"asOf":5}', '{"asOf":"x","alarms":"no"}', 'null']) {
      fake.lists.set('t-1', { asOf: 'x', payload });
      expect(await readCachedCrisis('t-1')).toBeNull();
    }
  });

  it('takes marks the gateway has accepted, and keeps when it was read', async () => {
    await saveCachedCrisis('t-1', response);
    await patchCachedCrisis('t-1', [
      { id: 'm1', callId: 'c1', lessonId: null, studentId: 's1', state: 'MISSING', at: '2027-01-12T09:11:00.000Z', teacherId: 't-1', retryCount: 0 },
    ]);
    const kept = await readCachedCrisis('t-1');
    expect(kept?.asOf).toBe('2027-01-12T09:10:00.000Z');
    expect(kept?.response.alarms[0]!.calls[0]!.pupils[0]).toMatchObject({ status: 'MISSING', markedAt: '2027-01-12T09:11:00.000Z' });
    // Nothing kept, nothing to patch.
    await expect(patchCachedCrisis('t-9', [])).resolves.toBeUndefined();
    expect(await readCachedCrisis('t-9')).toBeNull();
  });
});
