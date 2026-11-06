import * as Notifications from 'expo-notifications';
import { fake, api as database } from './__testing__/crisisDatabase';
import { readCachedCrisis, saveCachedCrisis, patchCachedCrisis } from './crisisCache';
import {
  HINT_TTL_MS,
  crisisPushOf,
  loadLocalCalls,
  needsLocalList,
  pushTimeMs,
  readAlarmHint,
  rememberCrisisPush,
  rememberPresentedCrisisPushes,
  resetAlarmHintForTests,
} from './crisisOffline';
import { countPupils, type MyAlarm, type MyCall, type MyCrisisResponse } from './crisis';

jest.mock('./database/localDatabase', () => require('./__testing__/crisisDatabase').api);
jest.mock('expo-notifications', () => ({ getPresentedNotificationsAsync: jest.fn() }));

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

  it('lets an alarm push go stale after the longest an alarm can stand open', async () => {
    await rememberCrisisPush(push('CRISIS_ALARM'));
    expect(await readAlarmHint(T0 + HINT_TTL_MS)).not.toBeNull();
    expect(await readAlarmHint(T0 + HINT_TTL_MS + 1)).toBeNull();
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

describe('needsLocalList', () => {
  const alarm = (startedAt: number): MyAlarm => ({
    id: 'a1', kind: 'EVACUATION', mode: 'LIVE', startedAt: new Date(startedAt).toISOString(), startedBy: null, endedAt: null,
    endedBy: null, autoEnded: false, endNote: null, guardiansNotifiedAt: null, calls: [],
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
  };
  const response: MyCrisisResponse = {
    asOf: '2027-01-12T09:10:00.000Z',
    alarms: [
      { id: 'a1', kind: 'EVACUATION', mode: 'LIVE', startedAt: '2027-01-12T09:05:00.000Z', startedBy: null, endedAt: null, endedBy: null, autoEnded: false, endNote: null, guardiansNotifiedAt: null, calls: [call] },
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
