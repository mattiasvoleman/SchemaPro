import type { CalendarLesson, PendingCrisisMark } from '../../types';

/**
 * The Krisläge half of services/database/localDatabase.ts, in memory, for the
 * tests that are about what the queue, the cache and the screen DO with it
 * rather than about its SQL (localDatabase.test.ts reads the SQL). It keeps
 * the rules the SQL keeps: a row is its id, the queue is owned and read by
 * teacher, oldest tap first, sent rows are not pending, and the hint keeps the
 * latest time. Used as
 *
 *   jest.mock('../database/localDatabase', () => require('../__testing__/crisisDatabase').api);
 *
 * and read back through `fake`.
 */

interface Row extends PendingCrisisMark {
  isSynced: boolean;
}

export const fake = {
  lists: new Map<string, { asOf: string; payload: string }>(),
  queue: [] as Row[],
  hint: null as { alarmAt: string | null; endedAt: string | null } | null,
  lessons: [] as CalendarLesson[],
  names: new Map<string, string>(),
  /** teacher id -> lesson id -> pupils marked absent in the register. */
  register: new Map<string, Map<string, Set<string>>>(),
  reset(): void {
    this.lists.clear();
    this.queue = [];
    this.hint = null;
    this.lessons = [];
    this.names.clear();
    this.register.clear();
  },
  /** The rows still to send, in the order the database reads them. */
  pending(teacherId?: string): Row[] {
    return this.queue.filter((row) => !row.isSynced && (teacherId === undefined || row.teacherId === teacherId));
  },
};

const later = (a: string | null, b: string): string => (a === null || b > a ? b : a);

export const api = {
  whenDatabaseReady: async (): Promise<void> => undefined,
  getCrisisList: async (teacherId: string) => fake.lists.get(teacherId) ?? null,
  saveCrisisList: async (teacherId: string, asOf: string, payload: string): Promise<void> => {
    fake.lists.set(teacherId, { asOf, payload });
  },
  // All or none, as the transaction is: a row the CHECK refuses writes nothing.
  enqueueCrisisMarks: async (marks: readonly Omit<PendingCrisisMark, 'retryCount'>[]): Promise<void> => {
    if (marks.some((mark) => (mark.callId === null) === (mark.lessonId === null))) {
      throw new Error('CHECK constraint failed: a mark names a call or a lesson');
    }
    for (const mark of marks) {
      fake.queue = [...fake.queue.filter((row) => row.id !== mark.id), { ...mark, retryCount: 0, isSynced: false }];
    }
  },
  getPendingCrisisMarks: async (teacherId: string): Promise<PendingCrisisMark[]> =>
    fake
      .pending(teacherId)
      .map(({ isSynced: _synced, ...mark }) => mark)
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)),
  markCrisisMarksSynced: async (ids: readonly string[]): Promise<void> => {
    for (const row of fake.queue) if (ids.includes(row.id)) row.isSynced = true;
  },
  incrementCrisisRetry: async (ids: readonly string[]): Promise<void> => {
    fake.queue = fake.queue.map((row) => (ids.includes(row.id) ? { ...row, retryCount: row.retryCount + 1 } : row));
  },
  deleteCrisisMarks: async (ids: readonly string[]): Promise<void> => {
    fake.queue = fake.queue.filter((row) => !ids.includes(row.id));
  },
  purgeSyncedCrisisMarks: async (beforeIso: string): Promise<void> => {
    fake.queue = fake.queue.filter((row) => !(row.isSynced && row.at < beforeIso));
  },
  countPendingCrisisMarks: async (teacherId: string): Promise<number> => fake.pending(teacherId).length,
  getCrisisHint: async () => fake.hint,
  saveCrisisAlarmHint: async (atIso: string): Promise<void> => {
    fake.hint = { alarmAt: later(fake.hint?.alarmAt ?? null, atIso), endedAt: fake.hint?.endedAt ?? null };
  },
  clearCrisisAlarmHint: async (atIso: string): Promise<void> => {
    if (fake.hint?.alarmAt && fake.hint.alarmAt <= atIso) fake.hint = { alarmAt: null, endedAt: fake.hint.endedAt };
  },
  saveCrisisEndedHint: async (atIso: string): Promise<void> => {
    fake.hint = { alarmAt: fake.hint?.alarmAt ?? null, endedAt: later(fake.hint?.endedAt ?? null, atIso) };
  },
  getCachedLessonsAround: async (): Promise<CalendarLesson[]> => fake.lessons,
  getRegisterAbsentees: async (teacherId: string, lessonIds: readonly string[]): Promise<Map<string, Set<string>>> => {
    const mine = fake.register.get(teacherId) ?? new Map<string, Set<string>>();
    return new Map([...mine].filter(([lessonId]) => lessonIds.includes(lessonId)));
  },
  getStudentsByIds: async (ids: readonly string[]) =>
    ids.filter((id) => fake.names.has(id)).map((id) => ({ id, displayName: fake.names.get(id) as string, photoUri: null })),
};
