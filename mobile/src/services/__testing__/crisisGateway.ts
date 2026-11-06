import type {
  AlarmDetail,
  AlarmSummary,
  CallView,
  FoundHere,
  MyAlarm,
  MyCall,
  MyCrisisResponse,
  OtherPupil,
  PupilStatus,
  PupilView,
} from '../crisis';
import { countPupils } from '../crisis';

/**
 * Krisläge's gateway, stubbed at fetch, for the tests of the screens: the real
 * client, hooks and queue run against it, so what is pinned is what the
 * gateway RECEIVES (route, method, body, bearer) and what the screen shows of
 * what it answers. A handler answers with a status and a body, a promise of
 * one (to hold a request in the air), or 'network' (a request that never got
 * there). `down` is a phone with no coverage at all.
 */

type Answer = { readonly status: number; readonly body?: unknown } | 'network';
type Handler<A extends unknown[] = []> = (...args: A) => Answer | Promise<Answer>;

export interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

const BASE = 'https://api.example.test';

const empty: Handler = () => ({ status: 200, body: {} });

export const gateway = {
  down: false,
  calls: [] as RecordedCall[],
  mine: empty as Handler,
  marks: ((marks: Array<{ id: string }>) => ({ status: 200, body: { stored: marks.length, duplicates: 0, unresolved: [] } })) as Handler<[Array<{ id: string }>]>,
  alarms: (() => ({ status: 200, body: [] })) as Handler,
  /** The search for "found with me": the alarm and the text asked for. */
  pupils: (() => ({ status: 200, body: [] })) as Handler<[string, string]>,
  detail: empty as Handler<[string]>,
  start: empty as Handler<[{ kind: string; mode: string }]>,
  /** The administration's marks on an alarm (POST /alarms/:id/marks). */
  adminMarks: ((_alarm: string, marks: Array<{ id: string }>) => ({ status: 200, body: { stored: marks.length, duplicates: 0, unresolved: [] } })) as Handler<[string, Array<{ id: string }>]>,
  end: empty as Handler<[string]>,
  fetch: jest.fn(),

  /** Calls to one route, in order. */
  to(method: string, path: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === method && call.path === path);
  },

  install(): void {
    process.env['EXPO_PUBLIC_API_BASE_URL'] = BASE;
    Object.defineProperty(global, 'fetch', { value: this.fetch, writable: true, configurable: true });
    this.reset();
  },

  reset(): void {
    this.down = false;
    this.calls = [];
    this.mine = empty;
    this.marks = (marks) => ({ status: 200, body: { stored: marks.length, duplicates: 0, unresolved: [] } });
    this.alarms = () => ({ status: 200, body: [] });
    this.pupils = () => ({ status: 200, body: [] });
    this.detail = empty;
    this.start = empty;
    this.adminMarks = (_alarm, marks) => ({ status: 200, body: { stored: marks.length, duplicates: 0, unresolved: [] } });
    this.end = empty;
    this.fetch.mockReset();
    this.fetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const path = url.replace(BASE, '');
      const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
      this.calls.push({ method, path, body });
      if (this.down) throw new TypeError('Network request failed');
      const answer = await this.route(method, path, body);
      if (answer === 'network') throw new TypeError('Network request failed');
      return {
        ok: answer.status >= 200 && answer.status < 300,
        status: answer.status,
        json: async () => answer.body,
        text: async () => (answer.body === undefined ? '' : JSON.stringify(answer.body)),
      };
    });
  },

  async route(method: string, path: string, body: Record<string, unknown> | undefined): Promise<Answer> {
    if (method === 'GET' && path === '/api/v1/crisis/mine') return this.mine();
    if (method === 'POST' && path === '/api/v1/crisis/mine/marks') return this.marks((body?.['marks'] ?? []) as Array<{ id: string }>);
    if (method === 'POST' && path === '/api/v1/crisis/mine/pupils') return this.pupils(String(body?.['alarmId'] ?? ''), String(body?.['q'] ?? ''));
    if (method === 'GET' && path.startsWith('/api/v1/crisis/alarms?')) return this.alarms();
    if (method === 'POST' && path === '/api/v1/crisis/alarms') return this.start(body as { kind: string; mode: string });
    const adminMarks = /^\/api\/v1\/crisis\/alarms\/([^/]+)\/marks$/.exec(path);
    if (method === 'POST' && adminMarks) return this.adminMarks(decodeURIComponent(adminMarks[1]!), (body?.['marks'] ?? []) as Array<{ id: string }>);
    const end = /^\/api\/v1\/crisis\/alarms\/([^/]+)\/end$/.exec(path);
    if (method === 'POST' && end) return this.end(decodeURIComponent(end[1]!));
    const detail = /^\/api\/v1\/crisis\/alarms\/([^/?]+)$/.exec(path);
    if (method === 'GET' && detail) return this.detail(decodeURIComponent(detail[1]!));
    return { status: 404, body: { message: `no route ${method} ${path}` } };
  },
};

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** 2027-01-12, a Tuesday: 09:05 the alarm begins, the lesson is 09:00–09:50. */
export const DAY = '2027-01-12';
export const at = (hhmm: string): string => `${DAY}T${hhmm}:00.000Z`;

export function pupil(id: string, first: string, last: string, status: PupilStatus = 'UNREPORTED', over: Partial<PupilView> = {}): PupilView {
  return {
    studentId: id,
    firstName: first,
    lastName: last,
    status,
    priorAbsentSource: status === 'ABSENT_BEFORE' ? 'ATTENDANCE' : null,
    markedAt: status === 'FOUND' || status === 'MISSING' ? at('09:07') : null,
    ...over,
  };
}

export function call(id: string, lessonId: string | null, pupils: PupilView[], over: Partial<MyCall> = {}): MyCall {
  return {
    id,
    lessonId,
    basis: 'LESSON',
    groupName: '7A',
    subjectName: 'Matematik',
    roomName: 'B204',
    lessonStartsAt: at('09:00'),
    lessonEndsAt: at('09:50'),
    completedAt: null,
    colleagues: [],
    counts: countPupils(pupils.map((p) => p.status)),
    pupils,
    foundHere: [],
    ...over,
  };
}

/** A pupil of the school on none of the teacher's lists, as the search for "found with me" answers. */
export function other(id: string, first: string, last: string, className: string | null = null): OtherPupil {
  return { studentId: id, firstName: first, lastName: last, className };
}

/** A pupil the gateway holds as found with a teacher of the call. */
export function foundWith(id: string, first: string, last: string, className: string | null = null, markedAt: string = at('09:08')): FoundHere {
  return { studentId: id, firstName: first, lastName: last, className, markedAt };
}

export function alarm(id: string, calls: MyCall[], over: Partial<MyAlarm> = {}): MyAlarm {
  return {
    id,
    kind: 'EVACUATION',
    mode: 'LIVE',
    startedAt: at('09:05'),
    startedBy: 'Rita Rektor',
    endedAt: null,
    endedBy: null,
    autoEnded: false,
    endNote: null,
    guardiansNotifiedAt: null,
    calls,
    foundFree: [],
    ...over,
  };
}

export const mineOf = (alarms: MyAlarm[], asOf = at('09:10')): MyCrisisResponse => ({ asOf, alarms });

/** The class the teacher answers for: two not yet marked, one found, one missing, one absent since before. */
export function sevenA(): MyCall {
  return call('c1', 'l1', [
    pupil('s1', 'Anna', 'Andersson'),
    pupil('s2', 'Bo', 'Berg', 'FOUND'),
    pupil('s3', 'Cia', 'Ceder', 'MISSING'),
    pupil('s4', 'Dan', 'Dahl', 'ABSENT_BEFORE'),
    pupil('s5', 'Eva', 'Ek'),
  ]);
}

export function summary(id: string, over: Partial<AlarmSummary> = {}): AlarmSummary {
  return {
    ...alarm(id, []),
    unlisted: 0,
    calls: 2,
    callsComplete: 1,
    counts: countPupils(['FOUND', 'FOUND', 'MISSING', 'ABSENT_BEFORE', 'UNREPORTED', 'UNREPORTED']),
    teachers: 3,
    teachersAnswered: 2,
    ...over,
  };
}

export function callView(id: string, group: string, pupils: PupilView[], over: Partial<CallView> = {}): CallView {
  return {
    id,
    lessonId: `l-${id}`,
    basis: 'LESSON',
    groupName: group,
    subjectName: 'Matematik',
    roomName: null,
    lessonStartsAt: at('09:00'),
    lessonEndsAt: at('09:50'),
    completedAt: null,
    uncovered: false,
    teachers: [],
    counts: countPupils(pupils.map((p) => p.status)),
    pupils,
    ...over,
  };
}

export const detailOf = (alarmSummary: AlarmSummary, calls: CallView[]): AlarmDetail => ({ alarm: alarmSummary, calls });
