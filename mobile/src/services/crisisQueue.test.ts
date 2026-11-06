import { SecureTokenStore } from './auth/secureTokenStore';
import { ApiError } from './api';
import { noNetwork } from './network/deviceOffline';
import { getAccessToken } from './supabase';
import { fake, api as database } from './__testing__/crisisDatabase';
import { saveCachedCrisis, readCachedCrisis } from './crisisCache';
import {
  cancelQueuedFound,
  classifyFailure,
  flushCrisisQueue,
  newCrisisMark,
  queueCrisisMarks,
  resetCrisisQueueForTests,
  subscribeCrisisQueue,
  takeUnseenDrops,
  type QueueEvent,
} from './crisisQueue';
import { countPupils, type MyCall, type MyCrisisResponse } from './crisis';
import type { PendingCrisisMark } from '../types';

jest.mock('./database/localDatabase', () => require('./__testing__/crisisDatabase').api);
jest.mock('./auth/secureTokenStore', () => ({ SecureTokenStore: { getTeacherSession: jest.fn() } }));
jest.mock('./supabase', () => ({ getAccessToken: jest.fn(), getSupabase: jest.fn() }));
jest.mock('./network/deviceOffline', () => ({ deviceOffline: jest.fn(), noNetwork: jest.fn() }));
let mockUuid = 0;
jest.mock('expo-crypto', () => ({
  randomUUID: () => `00000000-0000-4000-8000-${String(++mockUuid).padStart(12, '0')}`,
}));

/**
 * The roll call's outbox, through the real gateway client against a stubbed
 * fetch and an in-memory database: a tap is written before anything is sent,
 * it is sent again without harm, a failure that is only about the network
 * keeps it and one about the mark itself drops it (and only it), the queue is
 * the signed-in teacher's own, and one pass at a time.
 */

const T0 = Date.parse('2027-01-12T09:15:00.000Z');
const ALARM = 'a1';
const mine = 't-1';
const colleague = 't-2';

interface Sent {
  readonly url: string;
  readonly marks: Array<{ id: string; callId?: string; lessonId?: string; alarmId?: string; studentId: string; state: string; at: string }>;
  readonly auth: string | undefined;
}
const sent: Sent[] = [];
type Responder = (marks: Sent['marks']) => { status: number; body?: unknown } | 'network' | 'hang';
let respond: Responder;

const okFor: Responder = (marks) => ({ status: 200, body: { stored: marks.length, duplicates: 0, unresolved: [] } });

const fetchMock = jest.fn(async (url: string, init: RequestInit) => {
  const body = JSON.parse(init.body as string) as { marks: Sent['marks'] };
  sent.push({ url, marks: body.marks, auth: (init.headers as Record<string, string>)['Authorization'] });
  const answer = respond(body.marks);
  if (answer === 'network') throw new TypeError('Network request failed');
  if (answer === 'hang') {
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  }
  return {
    ok: answer.status >= 200 && answer.status < 300,
    status: answer.status,
    json: async () => answer.body,
    text: async () => (answer.body === undefined ? '' : JSON.stringify(answer.body)),
  };
});

let n = 0;
const row = (over: Partial<PendingCrisisMark> = {}): Omit<PendingCrisisMark, 'retryCount'> => {
  n++;
  return {
    id: over.id ?? `m-${String(n).padStart(4, '0')}`,
    callId: over.lessonId ? null : 'c1',
    lessonId: null,
    studentId: `s-${n}`,
    state: 'FOUND',
    at: new Date(T0 + n * 1_000).toISOString(),
    teacherId: mine,
    ...over,
  };
};
const enqueue = (...rows: Array<Omit<PendingCrisisMark, 'retryCount'>>) => database.enqueueCrisisMarks(rows);

beforeEach(() => {
  process.env['EXPO_PUBLIC_API_BASE_URL'] = 'https://api.example.test';
  Object.defineProperty(global, 'fetch', { value: fetchMock, writable: true, configurable: true });
  jest.useFakeTimers({
    now: T0,
    doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'performance'],
  });
  fake.reset();
  resetCrisisQueueForTests();
  sent.length = 0;
  n = 0;
  mockUuid = 0;
  fetchMock.mockClear();
  respond = okFor;
  jest.mocked(SecureTokenStore.getTeacherSession).mockResolvedValue({ teacherId: mine, role: 'TEACHER', authId: null });
  jest.mocked(getAccessToken).mockResolvedValue('token');
  jest.mocked(noNetwork).mockResolvedValue(false);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('a tap is written before anything is sent', () => {
  it('is in the queue, and the teacher is told, before the network is asked for anything', async () => {
    jest.mocked(noNetwork).mockResolvedValue(true);
    const events: QueueEvent[] = [];
    const stop = subscribeCrisisQueue((event) => events.push(event));
    await queueCrisisMarks([row({ id: 'tap-1' })]);

    expect(fake.pending(mine).map((r) => r.id)).toEqual(['tap-1']);
    expect(events[0]).toEqual({ type: 'ENQUEUED' });
    const result = await flushCrisisQueue();
    expect(result).toMatchObject({ stopped: 'OFFLINE', remaining: 1, sent: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    stop();
  });

  it('is not lost when the write fails: the teacher is told, and nothing is sent', async () => {
    const broken = jest.spyOn(database, 'enqueueCrisisMarks').mockRejectedValueOnce(new Error('disk full'));
    await expect(queueCrisisMarks([row()])).rejects.toThrow('disk full');
    expect(fetchMock).not.toHaveBeenCalled();
    broken.mockRestore();
  });

  it('is sent straight after, by the tap itself', async () => {
    await queueCrisisMarks([row({ id: 'tap-1' })]);
    await flushCrisisQueue();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.marks.map((m) => m.id)).toEqual(['tap-1']);
    expect(fake.pending(mine)).toEqual([]);
  });

  it('writes all the taps of "Alla finns" or none', async () => {
    const bad = row({ id: 'bad', callId: null, lessonId: null });
    await expect(queueCrisisMarks([row({ id: 'good' }), bad])).rejects.toThrow();
    expect(fake.queue).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('sending', () => {
  it('sends what is queued, oldest tap first, as the gateway takes it, under the bearer, and marks it sent', async () => {
    await enqueue(
      row({ id: 'm-2', at: '2027-01-12T09:15:05.000Z', state: 'MISSING', studentId: 's-b' }),
      row({ id: 'm-1', at: '2027-01-12T09:15:01.000Z', state: 'FOUND', studentId: 's-a' }),
      row({ id: 'm-3', at: '2027-01-12T09:15:09.000Z', callId: null, lessonId: 'l1', studentId: 's-c' }),
    );
    const result = await flushCrisisQueue();

    expect(result).toMatchObject({ stopped: 'DONE', remaining: 0, dropped: [] });
    expect(result.sent.map((m) => m.id)).toEqual(['m-1', 'm-2', 'm-3']);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://api.example.test/api/v1/crisis/mine/marks');
    expect(sent[0]!.auth).toBe('Bearer token');
    expect(sent[0]!.marks).toEqual([
      { id: 'm-1', callId: 'c1', studentId: 's-a', state: 'FOUND', at: '2027-01-12T09:15:01.000Z' },
      { id: 'm-2', callId: 'c1', studentId: 's-b', state: 'MISSING', at: '2027-01-12T09:15:05.000Z' },
      { id: 'm-3', lessonId: 'l1', studentId: 's-c', state: 'FOUND', at: '2027-01-12T09:15:09.000Z' },
    ]);
    expect(fake.pending()).toEqual([]);
  });

  it('sends every tap of a pupil, not only the latest: the protocol is the timeline', async () => {
    await enqueue(row({ studentId: 's-a', state: 'FOUND' }), row({ studentId: 's-a', state: 'MISSING' }), row({ studentId: 's-a', state: 'FOUND' }));
    await flushCrisisQueue();
    expect(sent[0]!.marks.map((m) => m.state)).toEqual(['FOUND', 'MISSING', 'FOUND']);
  });

  it('sends in calls of at most 400', async () => {
    await enqueue(...Array.from({ length: 850 }, () => row()));
    const result = await flushCrisisQueue();
    expect(sent.map((s) => s.marks.length)).toEqual([400, 400, 50]);
    expect(result).toMatchObject({ stopped: 'DONE', remaining: 0 });
    expect(result.sent).toHaveLength(850);
  });

  it('does nothing for an empty queue, and nothing without a sign-in', async () => {
    await expect(flushCrisisQueue()).resolves.toMatchObject({ stopped: 'DONE', sent: [] });
    await enqueue(row());
    jest.mocked(SecureTokenStore.getTeacherSession).mockResolvedValue(null);
    await expect(flushCrisisQueue()).resolves.toMatchObject({ stopped: 'NO_SESSION' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.pending()).toHaveLength(1);
  });

  it('keeps the queue when there is no bearer to send under', async () => {
    await enqueue(row());
    jest.mocked(getAccessToken).mockResolvedValue(null as never);
    await expect(flushCrisisQueue()).resolves.toMatchObject({ stopped: 'RETRY', remaining: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tries a network the phone has not validated: only a phone joined to none is waited for', async () => {
    // noNetwork is true only when the phone says it is connected to nothing (deviceOffline.ts).
    await enqueue(row());
    await flushCrisisQueue();
    expect(sent).toHaveLength(1);
  });

  it('writes what was sent into the kept list, so that it is there offline', async () => {
    const call: MyCall = {
      id: 'c1',
      lessonId: 'l1',
      basis: 'LESSON',
      groupName: '7A',
      subjectName: 'Matematik',
      roomName: null,
      lessonStartsAt: '2027-01-12T09:00:00.000Z',
      lessonEndsAt: '2027-01-12T09:50:00.000Z',
      completedAt: null,
      colleagues: [],
      counts: countPupils(['UNREPORTED']),
      pupils: [{ studentId: 's-1', firstName: 'Alva', lastName: 'Elev', status: 'UNREPORTED', priorAbsentSource: null, markedAt: null }],
      foundHere: [],
    };
    const response: MyCrisisResponse = {
      asOf: '2027-01-12T09:10:00.000Z',
      alarms: [
        {
          id: ALARM, kind: 'EVACUATION', mode: 'LIVE', startedAt: '2027-01-12T09:05:00.000Z', startedBy: null, endedAt: null,
          endedBy: null, autoEnded: false, endNote: null, guardiansNotifiedAt: null, calls: [call], foundFree: [],
        },
      ],
    };
    await saveCachedCrisis(mine, response);
    await enqueue(row({ studentId: 's-1' }));
    await flushCrisisQueue();
    const kept = await readCachedCrisis(mine);
    expect(kept!.asOf).toBe('2027-01-12T09:10:00.000Z');
    expect(kept!.response.alarms[0]!.calls[0]!.pupils[0]!.status).toBe('FOUND');
  });
});

describe('idempotent: the same id is sent again without harm', () => {
  it('sends a call again after an answer that was lost, with the same ids, and takes the gateway’s "already held"', async () => {
    await enqueue(row({ id: 'm-1' }), row({ id: 'm-2' }));
    respond = () => 'network';
    expect(await flushCrisisQueue()).toMatchObject({ stopped: 'RETRY', remaining: 2 });
    // The gateway had stored them and the answer never came back.
    respond = (marks) => ({ status: 200, body: { stored: 0, duplicates: marks.length, unresolved: [] } });
    const again = await flushCrisisQueue();
    expect(again).toMatchObject({ stopped: 'DONE', remaining: 0 });
    expect(sent.map((s) => s.marks.map((m) => m.id))).toEqual([['m-1', 'm-2'], ['m-1', 'm-2']]);
    expect(again.sent.map((m) => m.id)).toEqual(['m-1', 'm-2']);
  });

  it('writes a tap with the same id once in the queue', async () => {
    await enqueue(row({ id: 'same' }), row({ id: 'same' }));
    expect(fake.queue.filter((r) => r.id === 'same')).toHaveLength(1);
  });
});

describe('a failure that is only about the network keeps the marks', () => {
  it.each([
    ['no answer at all', 'network' as const],
    ['a 500', { status: 500, body: { message: 'x' } }],
    ['a 503', { status: 503 }],
    ['a 408', { status: 408 }],
    ['a 401 (the next pass renews the sign-in)', { status: 401, body: { message: 'x' } }],
    ['a 404 without a code (a gateway without the route)', { status: 404, body: { message: 'Not Found' } }],
    ['a 409 that is not "ended"', { status: 409, body: { message: 'x', code: 'SOMETHING_ELSE' } }],
    ['a 409 without a code', { status: 409, body: { message: 'Conflict' } }],
    // The gateway answers two requests that deadlocked with this, and the next one goes through.
    ['a 409 WRITE_CONFLICT (a deadlock at the gateway)', { status: 409, body: { message: 'x', code: 'WRITE_CONFLICT' } }],
    ['a 404 with a code that is not "alarm not found"', { status: 404, body: { message: 'x', code: 'SOMETHING_ELSE' } }],
  ])('keeps them after %s, and sends them again', async (_name, answer) => {
    await enqueue(row({ id: 'm-1' }), row({ id: 'm-2' }));
    respond = () => answer;
    const first = await flushCrisisQueue();
    expect(first).toMatchObject({ stopped: 'RETRY', remaining: 2, sent: [], dropped: [] });
    expect(takeUnseenDrops()).toEqual([]);

    respond = okFor;
    const second = await flushCrisisQueue();
    expect(second).toMatchObject({ stopped: 'DONE', remaining: 0 });
    expect(second.sent.map((m) => m.id)).toEqual(['m-1', 'm-2']);
  });

  it('counts a refusal that came from the gateway, and not a request that never reached it', async () => {
    await enqueue(row({ id: 'm-1' }));
    respond = () => 'network';
    await flushCrisisQueue();
    expect(fake.queue[0]!.retryCount).toBe(0);
    respond = () => ({ status: 503 });
    await flushCrisisQueue();
    expect(fake.queue[0]!.retryCount).toBe(1);
  });

  it('stops at the first failure: a network that is not there is not asked again for the next call', async () => {
    await enqueue(...Array.from({ length: 900 }, () => row()));
    respond = () => 'network';
    await flushCrisisQueue();
    expect(sent).toHaveLength(1);
  });

  it('waits after a 429 and sends again once the wait is over', async () => {
    await enqueue(row({ id: 'm-1' }));
    respond = () => ({ status: 429, body: { message: 'ThrottlerException' } });
    expect(await flushCrisisQueue()).toMatchObject({ stopped: 'WAIT', remaining: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    respond = okFor;
    // Within the wait nothing is asked.
    jest.setSystemTime(T0 + 14_000);
    expect(await flushCrisisQueue()).toMatchObject({ stopped: 'WAIT', remaining: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    jest.setSystemTime(T0 + 15_001);
    expect(await flushCrisisQueue()).toMatchObject({ stopped: 'DONE', remaining: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up on a request that has not answered in 15 seconds and keeps the marks', async () => {
    jest.useFakeTimers({ now: T0 });
    await enqueue(row({ id: 'm-1' }));
    respond = () => 'hang';
    const flushing = flushCrisisQueue();
    await jest.advanceTimersByTimeAsync(15_000);
    expect(await flushing).toMatchObject({ stopped: 'RETRY', remaining: 1 });
  });
});

describe('a conflict is waited out, an ended alarm is not', () => {
  it('keeps a mark across a WRITE_CONFLICT and sends it with the same id when the gateway has let go', async () => {
    await enqueue(row({ id: 'm-1' }));
    respond = () => ({ status: 409, body: { message: 'x', code: 'WRITE_CONFLICT' } });
    const first = await flushCrisisQueue();
    expect(first).toMatchObject({ stopped: 'RETRY', remaining: 1, dropped: [] });
    expect(takeUnseenDrops()).toEqual([]);
    // It was the gateway that answered, so the row's history says so.
    expect(fake.queue[0]!.retryCount).toBe(1);

    respond = okFor;
    const second = await flushCrisisQueue();
    expect(second).toMatchObject({ stopped: 'DONE', remaining: 0 });
    expect(sent.map((s) => s.marks.map((m) => m.id))).toEqual([['m-1'], ['m-1']]);
  });

  it('is not halved and not dropped: a conflict is no verdict on any mark in the call', async () => {
    await enqueue(...Array.from({ length: 6 }, (_, i) => row({ id: `m-${i}` })));
    respond = () => ({ status: 409, body: { message: 'x', code: 'WRITE_CONFLICT' } });
    const result = await flushCrisisQueue();
    expect(sent).toHaveLength(1);
    expect(result).toMatchObject({ remaining: 6, dropped: [] });
  });

  it('drops the marks of an alarm that has ended, and keeps going with the ones after', async () => {
    await enqueue(row({ id: 'm-1' }));
    respond = () => ({ status: 409, body: { message: 'x', code: 'CRISIS_ALARM_ENDED' } });
    expect(await flushCrisisQueue()).toMatchObject({ dropped: [{ reason: 'ENDED', count: 1 }], remaining: 0 });
  });
});

describe('"found with me": a mark for a pupil who is not on the call’s list', () => {
  const foundHere = (id: string, studentId: string) => row({ id, studentId, state: 'FOUND', callId: 'c1' });

  it('is sent as any mark is: the same route and body, FOUND, naming the call', async () => {
    await enqueue(foundHere('m-1', 'off-list-pupil'));
    await flushCrisisQueue();
    expect(sent[0]!.url).toBe('https://api.example.test/api/v1/crisis/mine/marks');
    expect(sent[0]!.marks).toEqual([{ id: 'm-1', callId: 'c1', studentId: 'off-list-pupil', state: 'FOUND', at: expect.any(String) }]);
  });

  it('is dropped, and only it, when the gateway refuses it as CRISIS_MARK_INVALID: the marks beside it are sent', async () => {
    await enqueue(row({ id: 'm-1' }), foundHere('m-2', 'stranger'), row({ id: 'm-3' }));
    respond = (marks) =>
      marks.some((m) => m.studentId === 'stranger')
        ? { status: 400, body: { message: 'Eleven står inte på gruppens lista.', code: 'CRISIS_MARK_INVALID' } }
        : { status: 200, body: { stored: marks.length, duplicates: 0, unresolved: [] } };
    const result = await flushCrisisQueue();
    expect(result.sent.map((m) => m.id).sort()).toEqual(['m-1', 'm-3']);
    expect(result.dropped).toEqual([{ reason: 'INVALID', count: 1 }]);
    expect(fake.pending()).toEqual([]);
    expect(takeUnseenDrops()).toEqual([{ reason: 'INVALID', count: 1 }]);
  });

  it('is written into the kept list by the name it carried, and the list cannot name one that came without', async () => {
    const call: MyCall = {
      id: 'c1', lessonId: 'l1', basis: 'LESSON', groupName: '7A', subjectName: 'Matematik', roomName: null,
      lessonStartsAt: '2027-01-12T09:00:00.000Z', lessonEndsAt: '2027-01-12T09:50:00.000Z', completedAt: null, colleagues: [],
      counts: countPupils(['UNREPORTED']),
      pupils: [{ studentId: 's-1', firstName: 'Alva', lastName: 'Elev', status: 'UNREPORTED', priorAbsentSource: null, markedAt: null }],
      foundHere: [],
    };
    await saveCachedCrisis(mine, {
      asOf: '2027-01-12T09:10:00.000Z',
      alarms: [
        {
          id: ALARM, kind: 'EVACUATION', mode: 'LIVE', startedAt: '2027-01-12T09:05:00.000Z', startedBy: null, endedAt: null,
          endedBy: null, autoEnded: false, endNote: null, guardiansNotifiedAt: null, calls: [call], foundFree: [],
        },
      ],
    });
    const kim = { firstName: 'Kim', lastName: 'Kvist', className: '7C' };
    await enqueue(
      row({ id: 'm-1', studentId: 'known', pupil: kim }),
      row({ id: 'm-2', studentId: 'nameless' }),
      row({ id: 'm-3', studentId: 'free', callId: null, alarmId: ALARM, pupil: { firstName: 'Fri', lastName: 'Elev', className: null } }),
    );
    await flushCrisisQueue();
    const kept = (await readCachedCrisis(mine))!.response.alarms[0]!;
    expect(kept.calls[0]!.foundHere.map((f) => [f.studentId, f.firstName, f.className])).toEqual([['known', 'Kim', '7C']]);
    expect(kept.foundFree.map((f) => [f.studentId, f.firstName])).toEqual([['free', 'Fri']]);
    expect(kept.calls[0]!.pupils[0]!.status).toBe('UNREPORTED');
  });

  it('loses the name of the pupil it carried when the gateway has the mark, and keeps it while the mark waits', async () => {
    await enqueue(row({ id: 'm-1', pupil: { firstName: 'Kim', lastName: 'Kvist', className: '7C' } }));
    respond = () => 'network';
    await flushCrisisQueue();
    expect(fake.pending()[0]!.pupil).toEqual({ firstName: 'Kim', lastName: 'Kvist', className: '7C' });
    respond = okFor;
    await flushCrisisQueue();
    expect(fake.queue.map((r) => [r.id, r.isSynced, r.pupil])).toEqual([['m-1', true, null]]);
  });
});

describe('a teacher with no group: a found pupil is sent with the alarm in place of a call', () => {
  const free = (id: string, studentId: string, over: Partial<PendingCrisisMark> = {}) => row({ id, studentId, callId: null, alarmId: ALARM, ...over });

  it('is sent with `alarmId` and none of `callId` or `lessonId`, in the same route and the same call as any mark', async () => {
    await enqueue(free('m-1', 's-free'), row({ id: 'm-2' }));
    await flushCrisisQueue();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.marks[0]).toEqual({ id: 'm-1', alarmId: ALARM, studentId: 's-free', state: 'FOUND', at: expect.any(String) });
    expect(sent[0]!.marks[1]).toMatchObject({ id: 'm-2', callId: 'c1' });
  });

  it('is the signed-in teacher’s own, like every mark: a colleague’s is neither sent, counted nor dropped', async () => {
    await enqueue(free('m-mine', 's-1'), free('m-theirs', 's-2', { teacherId: colleague }));
    const result = await flushCrisisQueue();
    expect(result.sent.map((m) => m.id)).toEqual(['m-mine']);
    expect(fake.pending(colleague).map((r) => r.id)).toEqual(['m-theirs']);
    // Not dropped either, whatever the gateway says of the teacher’s own.
    respond = () => ({ status: 409, body: { message: 'x', code: 'CRISIS_ALARM_ENDED' } });
    await flushCrisisQueue();
    expect(fake.pending(colleague)).toHaveLength(1);
  });

  it('is written as a row only if it names the alarm and nothing else', async () => {
    await expect(enqueue(row({ id: 'm-x', callId: 'c1', alarmId: ALARM }))).rejects.toThrow('CHECK constraint');
    await expect(enqueue(row({ id: 'm-y', callId: null, alarmId: null }))).rejects.toThrow('CHECK constraint');
    expect(fake.queue).toEqual([]);
  });

  it('is dropped, and only it, when the gateway refuses it as CRISIS_MARK_INVALID', async () => {
    await enqueue(row({ id: 'm-1' }), free('m-2', 'stranger'));
    respond = (marks) =>
      marks.some((m) => m.studentId === 'stranger')
        ? { status: 400, body: { message: 'x', code: 'CRISIS_MARK_INVALID' } }
        : { status: 200, body: { stored: marks.length, duplicates: 0, unresolved: [] } };
    const result = await flushCrisisQueue();
    expect(result.sent.map((m) => m.id)).toEqual(['m-1']);
    expect(result.dropped).toEqual([{ reason: 'INVALID', count: 1 }]);
  });
});

describe('taking a pupil found with me back', () => {
  const found = (id: string, studentId: string, at: number, over: Partial<PendingCrisisMark> = {}) =>
    row({ id, studentId, state: 'FOUND', at: new Date(T0 + at).toISOString(), ...over });
  const back = (id: string, studentId: string, at: number, over: Partial<PendingCrisisMark> = {}) =>
    row({ id, studentId, state: 'RETRACTED', at: new Date(T0 + at).toISOString(), ...over });

  it('is sent as a mark of state RETRACTED, after the found it takes back, naming the same call', async () => {
    await enqueue(found('m-1', 's-x', 1_000), back('m-2', 's-x', 2_000));
    await flushCrisisQueue();
    expect(sent[0]!.marks.map((m) => [m.id, m.state, m.callId, m.studentId])).toEqual([
      ['m-1', 'FOUND', 'c1', 's-x'],
      ['m-2', 'RETRACTED', 'c1', 's-x'],
    ]);
  });

  it('is sent with the alarm, for a pupil found with no group', async () => {
    await enqueue(back('m-1', 's-x', 1_000, { callId: null, alarmId: ALARM }));
    await flushCrisisQueue();
    expect(sent[0]!.marks[0]).toEqual({ id: 'm-1', alarmId: ALARM, studentId: 's-x', state: 'RETRACTED', at: expect.any(String) });
  });

  it('is dropped without a crash when there is nothing of the teacher’s to take back (CRISIS_MARK_INVALID), and the rest are sent', async () => {
    await enqueue(row({ id: 'm-1' }), back('m-2', 'nothing-to-retract', 2_000), row({ id: 'm-3' }));
    respond = (marks) =>
      marks.some((m) => m.state === 'RETRACTED')
        ? { status: 400, body: { message: 'Det finns inget att ta tillbaka.', code: 'CRISIS_MARK_INVALID' } }
        : { status: 200, body: { stored: marks.length, duplicates: 0, unresolved: [] } };
    const result = await flushCrisisQueue();
    expect(result.sent.map((m) => m.id).sort()).toEqual(['m-1', 'm-3']);
    expect(result.dropped).toEqual([{ reason: 'INVALID', count: 1 }]);
    expect(fake.pending()).toEqual([]);
  });

  it('is kept across a WRITE_CONFLICT like any mark', async () => {
    await enqueue(back('m-1', 's-x', 1_000));
    respond = () => ({ status: 409, body: { message: 'x', code: 'WRITE_CONFLICT' } });
    expect(await flushCrisisQueue()).toMatchObject({ stopped: 'RETRY', remaining: 1, dropped: [] });
  });

  describe('a found that has not left the phone', () => {
    it('is deleted with what it was queued with, and nothing is sent about it', async () => {
      await enqueue(found('m-1', 's-x', 1_000, { pupil: { firstName: 'Kim', lastName: 'Kvist', className: null } }), found('m-keep', 's-other', 1_500));
      await expect(cancelQueuedFound(mine, { callId: 'c1' }, 's-x')).resolves.toBe(true);
      expect(fake.queue.map((r) => r.id)).toEqual(['m-keep']);
      await flushCrisisQueue();
      expect(sent.flatMap((s) => s.marks.map((m) => m.id))).toEqual(['m-keep']);
    });

    it('takes a taking-back that was already queued with it, so that no mark is sent for a pupil the gateway never heard of', async () => {
      await enqueue(found('m-1', 's-x', 1_000), back('m-2', 's-x', 2_000), found('m-3', 's-x', 3_000));
      await expect(cancelQueuedFound(mine, { callId: 'c1' }, 's-x')).resolves.toBe(true);
      expect(fake.queue).toEqual([]);
    });

    it('is deleted for the group it was found with and no other, and for the alarm for a pupil found with no group', async () => {
      await enqueue(found('m-1', 's-x', 1_000, { callId: 'c2' }), found('m-2', 's-x', 2_000, { callId: null, alarmId: ALARM }));
      await expect(cancelQueuedFound(mine, { callId: 'c1' }, 's-x')).resolves.toBe(false);
      await expect(cancelQueuedFound(mine, { alarmId: ALARM }, 's-x')).resolves.toBe(true);
      expect(fake.queue.map((r) => r.id)).toEqual(['m-1']);
    });

    it('is never another teacher’s on the same tablet', async () => {
      await enqueue(found('m-1', 's-x', 1_000, { teacherId: colleague }));
      await expect(cancelQueuedFound(mine, { callId: 'c1' }, 's-x')).resolves.toBe(false);
      expect(fake.queue).toHaveLength(1);
    });

    it('is not deleted while a pass is in the air, which may have sent it: the taking-back must go after it', async () => {
      await enqueue(found('m-1', 's-x', 1_000));
      let release!: () => void;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      fetchMock.mockImplementationOnce(async (url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { marks: Sent['marks'] };
        sent.push({ url, marks: body.marks, auth: undefined });
        await gate;
        const answer = JSON.stringify({ stored: 1, duplicates: 0, unresolved: [] });
        return { ok: true, status: 200, json: async () => JSON.parse(answer), text: async () => answer } as never;
      });
      const passing = flushCrisisQueue();
      while (fetchMock.mock.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      await expect(cancelQueuedFound(mine, { callId: 'c1' }, 's-x')).resolves.toBe(false);
      expect(fake.queue.map((r) => r.id)).toEqual(['m-1']);
      release();
      await passing;
    });

    it('says there is nothing to delete when nothing is queued for the pupil', async () => {
      await expect(cancelQueuedFound(mine, { callId: 'c1' }, 's-x')).resolves.toBe(false);
    });

    it('tells the screen, which reads the queue again', async () => {
      await enqueue(found('m-1', 's-x', 1_000));
      const events: QueueEvent[] = [];
      subscribeCrisisQueue((event) => events.push(event));
      await cancelQueuedFound(mine, { callId: 'c1' }, 's-x');
      expect(events).toEqual([{ type: 'ENQUEUED' }]);
    });
  });
});

describe('a refusal about the marks themselves drops them, and only them', () => {
  it.each([
    ['the alarm ended an hour ago', 409, 'CRISIS_ALARM_ENDED', 'ENDED'],
    ['the alarm is gone', 404, 'CRISIS_ALARM_NOT_FOUND', 'NOT_FOUND'],
    ['the group is not theirs', 403, 'CRISIS_NOT_YOURS', 'NOT_YOURS'],
    ['the pupil is not on the list', 400, 'CRISIS_MARK_INVALID', 'INVALID'],
    ['the body is refused', 400, undefined, 'INVALID'],
  ])('%s: the mark is deleted, counted, and told to the teacher once', async (_name, status, code, reason) => {
    await enqueue(row({ id: 'm-1' }));
    respond = () => ({ status, body: { message: 'x', ...(code ? { code } : {}) } });
    const result = await flushCrisisQueue();
    expect(result).toMatchObject({ stopped: 'DONE', remaining: 0, sent: [], dropped: [{ reason, count: 1 }] });
    expect(fake.queue).toEqual([]);
    expect(takeUnseenDrops()).toEqual([{ reason, count: 1 }]);
    // It is told once.
    expect(takeUnseenDrops()).toEqual([]);
    // And never sent again.
    respond = okFor;
    await flushCrisisQueue();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('halves a refused call until the mark that is wrong is found: the others are sent', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => row({ id: `m-${i}` }));
    await enqueue(...rows);
    // The gateway refuses a whole call that has the third mark in it.
    respond = (marks) =>
      marks.some((m) => m.id === 'm-2')
        ? { status: 409, body: { message: 'x', code: 'CRISIS_ALARM_ENDED' } }
        : { status: 200, body: { stored: marks.length, duplicates: 0, unresolved: [] } };
    const result = await flushCrisisQueue();

    expect(result.sent.map((m) => m.id).sort()).toEqual(['m-0', 'm-1', 'm-3', 'm-4', 'm-5', 'm-6']);
    expect(result.dropped).toEqual([{ reason: 'ENDED', count: 1 }]);
    expect(fake.pending()).toEqual([]);
    expect(fake.queue.some((r) => r.id === 'm-2')).toBe(false);
    // 7 -> (4 -> (2 -> 1, 1), 2 -> ok)..: a handful of calls, not one per mark.
    expect(sent.length).toBeLessThan(rows.length + 3);
  });

  it('keeps the order of a pupil’s taps while halving', async () => {
    await enqueue(
      row({ id: 'm-1', studentId: 's-a', state: 'FOUND', at: '2027-01-12T09:15:01.000Z' }),
      row({ id: 'm-2', studentId: 'x', at: '2027-01-12T09:15:02.000Z' }),
      row({ id: 'm-3', studentId: 's-a', state: 'MISSING', at: '2027-01-12T09:15:03.000Z' }),
      row({ id: 'm-4', studentId: 'y', at: '2027-01-12T09:15:04.000Z' }),
    );
    respond = (marks) =>
      marks.length > 1 && marks.some((m) => m.id === 'm-4') ? { status: 400, body: { message: 'x' } } : { status: 200, body: { stored: marks.length, duplicates: 0, unresolved: [] } };
    await flushCrisisQueue();
    const order = sent.filter((_s, i) => i > 0).flatMap((s) => s.marks.map((m) => m.id));
    expect(order.indexOf('m-1')).toBeLessThan(order.indexOf('m-3'));
  });

  it('spends a bounded number of calls on a call full of refusals, and leaves the rest queued for the next pass', async () => {
    await enqueue(...Array.from({ length: 400 }, () => row()));
    respond = () => ({ status: 400, body: { message: 'x' } });
    const result = await flushCrisisQueue();
    expect(sent.length).toBeLessThanOrEqual(60);
    expect(result.stopped).toBe('BUDGET');
    expect(result.dropped[0]).toMatchObject({ reason: 'INVALID' });
    expect(result.remaining).toBeGreaterThan(0);
    expect(result.remaining + result.dropped[0]!.count).toBe(400);
  });

  it('drops the marks the gateway says belong to no alarm of this teacher’s, and takes the rest', async () => {
    await enqueue(row({ id: 'm-1' }), row({ id: 'm-2', callId: null, lessonId: 'l-not-mine' }));
    respond = () => ({ status: 200, body: { stored: 1, duplicates: 0, unresolved: ['m-2'] } });
    const result = await flushCrisisQueue();
    expect(result.sent.map((m) => m.id)).toEqual(['m-1']);
    expect(result.dropped).toEqual([{ reason: 'UNRESOLVED', count: 1 }]);
    expect(fake.queue.map((r) => r.id)).toEqual(['m-1']);
    expect(fake.pending()).toEqual([]);
  });
});

describe('the queue is the signed-in teacher’s own', () => {
  it('never sends, counts or drops a colleague’s marks under this teacher’s bearer', async () => {
    await enqueue(row({ id: 'mine-1' }), row({ id: 'theirs-1', teacherId: colleague }));
    respond = () => ({ status: 409, body: { message: 'x', code: 'CRISIS_ALARM_ENDED' } });
    const result = await flushCrisisQueue();
    expect(sent[0]!.marks.map((m) => m.id)).toEqual(['mine-1']);
    expect(result.dropped).toEqual([{ reason: 'ENDED', count: 1 }]);
    // The colleague's mark is untouched, and theirs to send.
    expect(fake.queue.map((r) => r.id)).toEqual(['theirs-1']);

    respond = okFor;
    jest.mocked(SecureTokenStore.getTeacherSession).mockResolvedValue({ teacherId: colleague, role: 'TEACHER', authId: null });
    const theirs = await flushCrisisQueue();
    expect(theirs.sent.map((m) => m.id)).toEqual(['theirs-1']);
  });
});

describe('one pass at a time', () => {
  it('answers two calls with one pass', async () => {
    await enqueue(row());
    const [a, b] = await Promise.all([flushCrisisQueue(), flushCrisisQueue()]);
    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends a tap that arrives while a pass is in the air in a pass of its own straight after, not at the next timer', async () => {
    await enqueue(row({ id: 'first' }));
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    fetchMock.mockImplementationOnce(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { marks: Sent['marks'] };
      sent.push({ url, marks: body.marks, auth: undefined });
      await gate;
      const answer = JSON.stringify({ stored: 1, duplicates: 0, unresolved: [] });
      return { ok: true, status: 200, json: async () => JSON.parse(answer), text: async () => answer } as never;
    });
    const running = flushCrisisQueue();
    // The first call is in the air: this tap is not in it.
    while (fetchMock.mock.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    await enqueue(row({ id: 'second' }));
    void flushCrisisQueue();
    release();
    const result = await running;
    expect(sent.map((s) => s.marks.map((m) => m.id))).toEqual([['first'], ['second']]);
    expect(result.sent.map((m) => m.id)).toEqual(['first', 'second']);
    expect(fake.pending()).toEqual([]);
  });

  it('waits for the database to open before it reads the queue: a tap on an alarm push can start the app', async () => {
    let open!: () => void;
    const ready = new Promise<void>((done) => {
      open = done;
    });
    const wait = jest.spyOn(database, 'whenDatabaseReady').mockReturnValue(ready);
    const read = jest.spyOn(database, 'getPendingCrisisMarks');
    await enqueue(row({ id: 'first' }));
    const flushing = flushCrisisQueue();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(read).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    open();
    await expect(flushing).resolves.toMatchObject({ stopped: 'DONE', remaining: 0 });
    expect(sent[0]!.marks.map((m) => m.id)).toEqual(['first']);
    wait.mockRestore();
    read.mockRestore();
  });

  it('tells the listeners what a pass did, and a database that fails is a pass that kept the marks', async () => {
    const events: QueueEvent[] = [];
    const stop = subscribeCrisisQueue((event) => events.push(event));
    await enqueue(row());
    await flushCrisisQueue();
    expect(events.at(-1)).toMatchObject({ type: 'FLUSHED', result: { stopped: 'DONE', remaining: 0 } });

    jest.spyOn(database, 'getPendingCrisisMarks').mockRejectedValueOnce(new Error('db closed'));
    await expect(flushCrisisQueue()).resolves.toMatchObject({ stopped: 'RETRY' });
    stop();
  });
});

describe('newCrisisMark', () => {
  const call = { id: 'c1', lessonId: 'l1' };

  it('names the call for a list the gateway gave, and the lesson for one the phone built', () => {
    const server = newCrisisMark({ call, studentId: 's1', state: 'FOUND', teacherId: mine, now: T0 });
    expect(server).toMatchObject({ callId: 'c1', lessonId: null, studentId: 's1', state: 'FOUND', teacherId: mine, at: new Date(T0).toISOString() });
    const local = newCrisisMark({ call: { id: 'local:l1', lessonId: 'l1' }, studentId: 's1', state: 'MISSING', teacherId: mine, now: T0 });
    expect(local).toMatchObject({ callId: null, lessonId: 'l1', state: 'MISSING' });
  });

  it('names the alarm in place of a call for a teacher with no group, with the pupil’s name for the pending row', () => {
    const who = { firstName: 'Kim', lastName: 'Kvist', className: '7C' };
    const mark = newCrisisMark({ alarmId: ALARM, studentId: 's1', state: 'FOUND', teacherId: mine, pupil: who, now: T0 });
    expect(mark).toMatchObject({ callId: null, lessonId: null, alarmId: ALARM, state: 'FOUND', at: new Date(T0).toISOString(), pupil: who });
  });

  it('carries a taking-back as the state RETRACTED, on the call or the alarm of the found it takes back', () => {
    const call = { id: 'c1', lessonId: 'l1' };
    expect(newCrisisMark({ call, studentId: 's1', state: 'RETRACTED', teacherId: mine, now: T0 })).toMatchObject({ callId: 'c1', alarmId: null, state: 'RETRACTED' });
    expect(newCrisisMark({ alarmId: ALARM, studentId: 's1', state: 'RETRACTED', teacherId: mine, now: T0 })).toMatchObject({ callId: null, alarmId: ALARM, state: 'RETRACTED' });
  });

  it('names a call or an alarm, and one of them', () => {
    expect(() => newCrisisMark({ studentId: 's1', state: 'FOUND', teacherId: mine })).toThrow();
    expect(() => newCrisisMark({ call: { id: 'c1', lessonId: 'l1' }, alarmId: ALARM, studentId: 's1', state: 'FOUND', teacherId: mine })).toThrow();
  });

  it('makes an id of its own for each tap, in the shape the gateway takes', () => {
    const a = newCrisisMark({ call, studentId: 's1', state: 'FOUND', teacherId: mine });
    const b = newCrisisMark({ call, studentId: 's1', state: 'FOUND', teacherId: mine });
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.id).not.toBe(b.id);
  });

  it('times a mark by lesson no earlier than the push that began the alarm, and a mark by call by the phone’s clock', () => {
    // The phone's clock trails by two minutes: a mark by lesson would be timed before the alarm and find none.
    const push = T0 + 5_000;
    const local = newCrisisMark({ call: { id: 'local:l1', lessonId: 'l1' }, studentId: 's1', state: 'FOUND', teacherId: mine, now: T0 - 120_000, notBefore: push });
    expect(local.at).toBe(new Date(push).toISOString());
    const server = newCrisisMark({ call, studentId: 's1', state: 'FOUND', teacherId: mine, now: T0 - 120_000, notBefore: push });
    expect(server.at).toBe(new Date(T0 - 120_000).toISOString());
  });
});

describe('classifyFailure', () => {
  it.each([
    ['a request that never reached the gateway', new TypeError('Network request failed'), { kind: 'RETRY', answered: false }],
    ['a client without a base URL', new ApiError(0, 'not configured', 'NOT_CONFIGURED'), { kind: 'RETRY', answered: false }],
    ['a 500', new ApiError(500, 'x'), { kind: 'RETRY', answered: true }],
    ['a 401', new ApiError(401, 'x'), { kind: 'RETRY', answered: true }],
    ['a 429', new ApiError(429, 'x'), { kind: 'WAIT' }],
    // Exactly four refusals are final, by status and code; a 404 or a 409 that is not one of them is not.
    ['an uncoded 404', new ApiError(404, 'x'), { kind: 'RETRY', answered: true }],
    ['an uncoded 409', new ApiError(409, 'x'), { kind: 'RETRY', answered: true }],
    ['a 409 WRITE_CONFLICT', new ApiError(409, 'x', 'WRITE_CONFLICT'), { kind: 'RETRY', answered: true }],
    ['a 404 with another code', new ApiError(404, 'x', 'SOMETHING_ELSE'), { kind: 'RETRY', answered: true }],
    ['a 500 that carries the code of an ended alarm', new ApiError(500, 'x', 'CRISIS_ALARM_ENDED'), { kind: 'RETRY', answered: true }],
    ['a 503', new ApiError(503, 'x'), { kind: 'RETRY', answered: true }],
    ['a 409 CRISIS_ALARM_ENDED', new ApiError(409, 'x', 'CRISIS_ALARM_ENDED'), { kind: 'PERMANENT', reason: 'ENDED' }],
    ['a 404 CRISIS_ALARM_NOT_FOUND', new ApiError(404, 'x', 'CRISIS_ALARM_NOT_FOUND'), { kind: 'PERMANENT', reason: 'NOT_FOUND' }],
    ['a 403 CRISIS_NOT_YOURS', new ApiError(403, 'x', 'CRISIS_NOT_YOURS'), { kind: 'PERMANENT', reason: 'NOT_YOURS' }],
    ['a 400 CRISIS_MARK_INVALID', new ApiError(400, 'x', 'CRISIS_MARK_INVALID'), { kind: 'PERMANENT', reason: 'INVALID' }],
    // Any other 4xx the same call would get again.
    ['a 413', new ApiError(413, 'x'), { kind: 'PERMANENT', reason: 'INVALID' }],
    ['a 422', new ApiError(422, 'x'), { kind: 'PERMANENT', reason: 'INVALID' }],
  ])('%s', (_name, error, expected) => {
    expect(classifyFailure(error)).toEqual(expected);
  });
});
