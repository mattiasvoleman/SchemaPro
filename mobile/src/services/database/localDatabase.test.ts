import * as SQLite from 'expo-sqlite';
import {
  clearCachedSchoolData,
  countPendingCrisisMarks,
  deleteCrisisMarks,
  discardRefusedRecords,
  enqueueCrisisMarks,
  getCachedLessonsAround,
  getCrisisHint,
  getCrisisList,
  getPendingAttendanceRecords,
  getPendingCrisisMarks,
  getQueueCounts,
  getRefusedLessons,
  getRegisterAbsentees,
  getStudentsByIds,
  incrementCrisisRetry,
  initDatabase,
  markCrisisMarksSynced,
  purgeSyncedCrisisMarks,
  saveCrisisAlarmHint,
  saveCrisisEndedHint,
  saveCrisisList,
  whenDatabaseReady,
} from './localDatabase';

jest.mock('expo-crypto', () => ({
  getRandomBytesAsync: jest.fn(async () => new Uint8Array(32).fill(7)),
}));

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked',
  getItemAsync: jest.fn(async () => '7'.repeat(64)),
  setItemAsync: jest.fn(async () => undefined),
}));

/**
 * The queries are the thing under test, so the driver is a recorder rather than
 * a real database: what matters is which SQL is sent and with which parameters.
 * An in-memory SQLite would test expo-sqlite, which is not ours.
 */
const rows: unknown[] = [];
const getAllAsync = jest.fn(async () => rows);
const getFirstAsync = jest.fn(async (): Promise<Record<string, unknown>> => ({ cipher_version: '4.5.5 community', count: 0 }));
const execAsync = jest.fn(async () => undefined);
const runAsync = jest.fn(async () => ({ changes: 0, lastInsertRowId: 0 }));
// A transaction runs its body; the SQL it holds is what is read.
const withTransactionAsync = jest.fn(async (body: () => Promise<void>) => body());

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));

const openDatabaseAsync = SQLite.openDatabaseAsync as jest.MockedFunction<
  typeof SQLite.openDatabaseAsync
>;

const lastQuery = () => getAllAsync.mock.calls.at(-1) as unknown as [string, unknown[]?];

beforeEach(async () => {
  rows.length = 0;
  getAllAsync.mockClear();
  getFirstAsync.mockClear();
  execAsync.mockClear();
  runAsync.mockClear();
  withTransactionAsync.mockClear();
  openDatabaseAsync.mockResolvedValue({
    execAsync,
    // initDatabase asserts SQLCipher is actually compiled in before it trusts
    // the store — see the cipher_version check it makes on the connection.
    getFirstAsync,
    getAllAsync,
    runAsync,
    withTransactionAsync,
  } as unknown as SQLite.SQLiteDatabase);
  await initDatabase();
});

describe('the offline attendance queue', () => {
  it('reads only the signed-in teacher’s own rows', async () => {
    // A tablet is shared, and logout leaves this encrypted store keyed with
    // every unsynced row still in it. Draining "the queue" submitted a
    // colleague's records under the next teacher's token, and the server stamps
    // the recorder from the bearer it is given — so an official record about a
    // child was signed by a teacher who was never in the room.
    await getPendingAttendanceRecords('teacher-a');

    const [sql, params] = lastQuery();
    expect(sql).toContain('submitted_by_teacher_id = ?');
    expect(params).toEqual(['teacher-a']);
  });

  it('still only reads what has not been synced', async () => {
    await getPendingAttendanceRecords('teacher-a');

    expect(lastQuery()[0]).toContain('is_synced = 0');
  });

  it('returns the queue oldest first, so a batch replays in the order it was marked', async () => {
    await getPendingAttendanceRecords('teacher-a');

    expect(lastQuery()[0]).toContain('ORDER BY timestamp ASC');
  });
});

describe('the pending badge', () => {
  it('counts only the signed-in teacher’s own rows', async () => {
    // The badge has to agree with what the worker can actually send, and the
    // worker only drains its own teacher's rows. Counting the whole table made
    // the badge stick at a number this teacher could never work off.
    await getQueueCounts('teacher-a', 5);

    const [sql, params] = getFirstAsync.mock.calls.at(-1) as unknown as [string, unknown[]];
    expect(sql).toContain('submitted_by_teacher_id = ?');
    expect(params).toEqual([5, 5, 'teacher-a']);
  });

  it('counts a refused row apart from the pending ones, and nought for an empty queue', async () => {
    // A row the server refused for good is never sent again: counted as
    // pending it would promise a send that never comes.
    getFirstAsync.mockResolvedValueOnce({ pending: 2, refused: 3 });
    await expect(getQueueCounts('teacher-a', 5)).resolves.toEqual({ pending: 2, refused: 3 });
    const [sql] = getFirstAsync.mock.calls.at(-1) as unknown as [string];
    expect(sql).toContain('retry_count < ?');
    expect(sql).toContain('retry_count >= ?');

    getFirstAsync.mockResolvedValueOnce({ pending: null, refused: null });
    await expect(getQueueCounts('teacher-a', 5)).resolves.toEqual({ pending: 0, refused: 0 });
  });
});

describe('refused rows', () => {
  it('names this teacher’s refused rows by lesson, as the phone last saved it', async () => {
    getAllAsync.mockResolvedValueOnce([
      { lesson_id: 'L1', subject_name: 'Matematik', start_time: '2026-10-13T06:00:00.000Z', marked_at: '2026-10-13T06:03:00.000Z', count: 25 },
      // Signing out forgets the lesson cache and keeps the queue: named by when it was marked.
      { lesson_id: 'L2', subject_name: null, start_time: null, marked_at: '2026-10-14T07:01:00.000Z', count: 3 },
    ] as never);

    await expect(getRefusedLessons('teacher-a', 5)).resolves.toEqual([
      { lessonId: 'L1', subjectName: 'Matematik', startTime: '2026-10-13T06:00:00.000Z', markedAt: '2026-10-13T06:03:00.000Z', count: 25 },
      { lessonId: 'L2', subjectName: null, startTime: null, markedAt: '2026-10-14T07:01:00.000Z', count: 3 },
    ]);
    const [sql, params] = lastQuery();
    expect(sql).toContain('retry_count >= ?');
    expect(sql).toContain('LEFT JOIN calendar_lessons');
    expect(params).toEqual(['teacher-a', 5]);
  });

  it('discards only this teacher’s refused rows of the lessons it was shown, and nothing for none', async () => {
    await discardRefusedRecords('teacher-a', 5, ['L1', 'L2']);

    const [sql, params] = runAsync.mock.calls.at(-1) as unknown as [string, unknown[]];
    expect(sql.replace(/\s+/g, ' ').trim()).toBe(
      'DELETE FROM attendance_queue WHERE is_synced = 0 AND submitted_by_teacher_id = ? AND retry_count >= ? AND lesson_id IN (?, ?)',
    );
    expect(params).toEqual(['teacher-a', 5, 'L1', 'L2']);

    runAsync.mockClear();
    await discardRefusedRecords('teacher-a', 5, []);
    expect(runAsync).not.toHaveBeenCalled();
  });
});

describe('signing out of a shared tablet', () => {
  it('forgets the cached roster', async () => {
    // Signing out used to clear three keychain items and nothing else, so the
    // next teacher's app opened holding the previous teacher's pupils by name.
    await clearCachedSchoolData();

    const [sql] = execAsync.mock.calls.at(-1) as unknown as [string];
    expect(sql).toContain('DELETE FROM students');
    expect(sql).toContain('DELETE FROM calendar_lessons');
    expect(sql).toContain('DELETE FROM lesson_students');
  });

  it('forgets the alarm list and when the phone was told of an alarm, which name every pupil of the teacher’s groups', async () => {
    await clearCachedSchoolData();

    const [sql] = execAsync.mock.calls.at(-1) as unknown as [string];
    expect(sql).toContain('DELETE FROM crisis_lists');
    expect(sql).toContain('DELETE FROM crisis_hint');
  });

  it('keeps unsent alarm marks, which may be the only copy of a pupil found or missing', async () => {
    await clearCachedSchoolData();

    const [sql] = execAsync.mock.calls.at(-1) as unknown as [string];
    expect(sql).not.toContain('crisis_queue');
  });

  it('keeps unsent attendance, which may be the only copy', async () => {
    // A legal record about a child. The teacher who signs out at the end of a
    // lesson must find it again when they sign back in — and it is already
    // unreachable by whoever signs in next.
    await clearCachedSchoolData();

    const [sql] = execAsync.mock.calls.at(-1) as unknown as [string];
    expect(sql).not.toContain('attendance_queue');
  });
});

describe('the cached roster', () => {
  it('comes back in Swedish order, not in the order it happened to be cached', async () => {
    // SQLite's own collation is ASCII, so the ORDER BY in the query is not
    // enough: Åkesson would land before Berg. The teacher reads this list while
    // ticking names, and a list in an order they do not expect is how a name
    // gets missed.
    rows.push(
      { id: '1', display_name: 'Öberg Nils', photo_uri: null },
      { id: '2', display_name: 'Berg Alma', photo_uri: null },
      { id: '3', display_name: 'Åkesson Sara', photo_uri: null },
    );

    const students = await getStudentsByIds(['1', '2', '3']);

    expect(students.map((student) => student.displayName)).toEqual([
      'Berg Alma',
      'Åkesson Sara',
      'Öberg Nils',
    ]);
  });

  it('asks for nothing when given no ids', async () => {
    expect(await getStudentsByIds([])).toEqual([]);
    expect(getAllAsync).not.toHaveBeenCalled();
  });
});

describe('the schema', () => {
  it('holds the alarm’s list, queue and hint beside the register’s tables, created only if missing', async () => {
    const schema = (execAsync.mock.calls as unknown as Array<[string]>).map(([sql]) => String(sql)).join('\n');
    for (const table of ['crisis_lists', 'crisis_queue', 'crisis_hint']) {
      expect(schema).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it('keeps the queue’s columns, a mark’s state to two values and its group to a call or a lesson, not both', async () => {
    const schema = (execAsync.mock.calls as unknown as Array<[string]>).map(([sql]) => String(sql)).join('\n');
    const queue = /CREATE TABLE IF NOT EXISTS crisis_queue \(([\s\S]*?)\n  \);/.exec(schema)![1]!;
    for (const column of ['id', 'call_id', 'lesson_id', 'student_id', 'state', 'at', 'teacher_id', 'retry_count', 'is_synced']) {
      expect(queue).toMatch(new RegExp(`\\b${column}\\b`));
    }
    expect(queue).toContain("CHECK(state IN ('FOUND', 'MISSING'))");
    expect(queue).toContain('CHECK ((call_id IS NULL) <> (lesson_id IS NULL))');
  });

  it('says when the database is open, at once if it is, and to a caller that came before it was', async () => {
    await expect(whenDatabaseReady()).resolves.toBeUndefined();

    // A tap that launched the app is handled before the provider that opens the database has finished.
    await jest.isolateModulesAsync(async () => {
      const fresh = require('./localDatabase') as typeof import('./localDatabase');
      let open = false;
      const waiting = fresh.whenDatabaseReady().then(() => {
        open = true;
      });
      await Promise.resolve();
      expect(open).toBe(false);
      await fresh.initDatabase();
      await waiting;
      expect(open).toBe(true);
    });
  });
});

describe('the alarm’s queue', () => {
  const mark = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    callId: 'c1',
    lessonId: null,
    studentId: 's1',
    state: 'FOUND' as const,
    at: '2027-01-12T09:15:00.000Z',
    teacherId: 'teacher-a',
    ...over,
  });

  it('writes every tap in one transaction, a row each, by the phone’s own id', async () => {
    await enqueueCrisisMarks([mark('m1'), mark('m2', { callId: null, lessonId: 'l1', state: 'MISSING' })]);

    expect(withTransactionAsync).toHaveBeenCalledTimes(1);
    const inserts = runAsync.mock.calls as unknown as Array<[string, unknown[]]>;
    expect(inserts).toHaveLength(2);
    expect(inserts[0]![0].replace(/\s+/g, ' ')).toContain('INSERT OR REPLACE INTO crisis_queue');
    expect(inserts[0]![1]).toEqual(['m1', 'c1', null, 's1', 'FOUND', '2027-01-12T09:15:00.000Z', 'teacher-a']);
    expect(inserts[1]![1]).toEqual(['m2', null, 'l1', 's1', 'MISSING', '2027-01-12T09:15:00.000Z', 'teacher-a']);
  });

  it('writes nothing for no taps', async () => {
    await enqueueCrisisMarks([]);
    expect(withTransactionAsync).not.toHaveBeenCalled();
  });

  it('reads only the signed-in teacher’s own unsent rows, oldest tap first', async () => {
    // The gateway stamps the sender from the bearer: a colleague's marks sent under this
    // teacher's token would be signed by someone who was never there.
    rows.push({ id: 'm1', call_id: 'c1', lesson_id: null, student_id: 's1', state: 'FOUND', at: 'x', teacher_id: 'teacher-a', retry_count: 2 });
    const marks = await getPendingCrisisMarks('teacher-a');

    const [sql, params] = lastQuery();
    expect(sql).toContain('is_synced = 0');
    expect(sql).toContain('teacher_id = ?');
    expect(sql).toContain('ORDER BY at ASC');
    expect(params).toEqual(['teacher-a']);
    expect(marks).toEqual([{ id: 'm1', callId: 'c1', lessonId: null, studentId: 's1', state: 'FOUND', at: 'x', teacherId: 'teacher-a', retryCount: 2 }]);
  });

  it('counts only this teacher’s unsent rows', async () => {
    getFirstAsync.mockResolvedValueOnce({ n: 3 });
    await expect(countPendingCrisisMarks('teacher-a')).resolves.toBe(3);
    const [sql, params] = getFirstAsync.mock.calls.at(-1) as unknown as [string, unknown[]];
    expect(sql).toContain('teacher_id = ?');
    expect(sql).toContain('is_synced = 0');
    expect(params).toEqual(['teacher-a']);
    getFirstAsync.mockResolvedValueOnce({ n: null });
    await expect(countPendingCrisisMarks('teacher-a')).resolves.toBe(0);
  });

  it('marks sent rows by id, counts a refusal, deletes the dropped, and forgets old sent rows', async () => {
    await markCrisisMarksSynced(['a', 'b']);
    expect(runAsync).toHaveBeenLastCalledWith('UPDATE crisis_queue SET is_synced = 1 WHERE id IN (?, ?)', ['a', 'b']);
    await incrementCrisisRetry(['a']);
    expect(runAsync).toHaveBeenLastCalledWith('UPDATE crisis_queue SET retry_count = retry_count + 1 WHERE id IN (?)', ['a']);
    await deleteCrisisMarks(['a', 'b', 'c']);
    expect(runAsync).toHaveBeenLastCalledWith('DELETE FROM crisis_queue WHERE id IN (?, ?, ?)', ['a', 'b', 'c']);
    await purgeSyncedCrisisMarks('2027-01-11T00:00:00.000Z');
    expect(runAsync).toHaveBeenLastCalledWith('DELETE FROM crisis_queue WHERE is_synced = 1 AND at < ?', ['2027-01-11T00:00:00.000Z']);

    runAsync.mockClear();
    await markCrisisMarksSynced([]);
    await incrementCrisisRetry([]);
    await deleteCrisisMarks([]);
    expect(runAsync).not.toHaveBeenCalled();
  });
});

describe('the alarm’s list', () => {
  it('is one row per teacher, read and written by teacher', async () => {
    await saveCrisisList('teacher-a', '2027-01-12T09:10:00.000Z', '{"alarms":[]}');
    expect(runAsync).toHaveBeenLastCalledWith(
      'INSERT OR REPLACE INTO crisis_lists (teacher_id, as_of, payload) VALUES (?, ?, ?)',
      ['teacher-a', '2027-01-12T09:10:00.000Z', '{"alarms":[]}'],
    );

    getFirstAsync.mockResolvedValueOnce({ as_of: 'x', payload: 'y' });
    await expect(getCrisisList('teacher-a')).resolves.toEqual({ asOf: 'x', payload: 'y' });
    const [sql, params] = getFirstAsync.mock.calls.at(-1) as unknown as [string, unknown[]];
    expect(sql).toContain('WHERE teacher_id = ?');
    expect(params).toEqual(['teacher-a']);

    getFirstAsync.mockResolvedValueOnce(null as never);
    await expect(getCrisisList('teacher-b')).resolves.toBeNull();
  });
});

describe('when the phone was told of an alarm', () => {
  it('keeps the latest time of each push, in one row', async () => {
    await saveCrisisAlarmHint('2027-01-12T09:15:00.000Z');
    const [alarmSql, alarmParams] = runAsync.mock.calls.at(-1) as unknown as [string, unknown[]];
    expect(alarmSql.replace(/\s+/g, ' ')).toContain('ON CONFLICT(id) DO UPDATE SET alarm_at = CASE WHEN alarm_at IS NULL OR excluded.alarm_at > alarm_at');
    expect(alarmParams).toEqual(['2027-01-12T09:15:00.000Z']);

    await saveCrisisEndedHint('2027-01-12T09:30:00.000Z');
    const [endSql, endParams] = runAsync.mock.calls.at(-1) as unknown as [string, unknown[]];
    expect(endSql.replace(/\s+/g, ' ')).toContain('SET ended_at = CASE WHEN ended_at IS NULL OR excluded.ended_at > ended_at');
    expect(endParams).toEqual(['2027-01-12T09:30:00.000Z']);
  });

  it('reads it, or nothing', async () => {
    getFirstAsync.mockResolvedValueOnce({ alarm_at: 'a', ended_at: null });
    await expect(getCrisisHint()).resolves.toEqual({ alarmAt: 'a', endedAt: null });
    getFirstAsync.mockResolvedValueOnce(null as never);
    await expect(getCrisisHint()).resolves.toBeNull();
  });
});

describe('the list the phone builds', () => {
  it('reads the lessons of a day either side of the moment, with their pupils', async () => {
    getAllAsync
      .mockResolvedValueOnce([{ id: 'l1', start_time: '2027-01-12T09:00:00+00:00', end_time: '2027-01-12T09:50:00+00:00', subject_name: 'Matematik', room_name: 'B204' }] as never)
      .mockResolvedValueOnce([{ lesson_id: 'l1', student_id: 's1' }, { lesson_id: 'l1', student_id: 's2' }] as never);

    const lessons = await getCachedLessonsAround('2027-01-12T09:15:00.000Z');

    const calls = getAllAsync.mock.calls as unknown as Array<[string, unknown[]]>;
    // Both stored forms of a time start with the UTC day, so the window is by date.
    expect(calls[0]![0]).toContain('substr(start_time, 1, 10) BETWEEN ? AND ?');
    expect(calls[0]![1]).toEqual(['2027-01-11', '2027-01-13']);
    expect(calls[1]![1]).toEqual(['l1']);
    expect(lessons).toEqual([
      { id: 'l1', startTime: '2027-01-12T09:00:00+00:00', endTime: '2027-01-12T09:50:00+00:00', subjectName: 'Matematik', roomName: 'B204', studentIds: ['s1', 's2'] },
    ]);
  });

  it('asks for no pupils when it holds no lessons', async () => {
    getAllAsync.mockResolvedValueOnce([] as never);
    await expect(getCachedLessonsAround('2027-01-12T09:15:00.000Z')).resolves.toEqual([]);
    expect(getAllAsync).toHaveBeenCalledTimes(1);
  });

  it('takes the pupils this teacher marked absent from the register by their latest mark, and nothing for none', async () => {
    getAllAsync.mockResolvedValueOnce([
      { lesson_id: 'l1', student_id: 's1', status: 'absent' },
      { lesson_id: 'l1', student_id: 's1', status: 'present' },
      { lesson_id: 'l1', student_id: 's2', status: 'excused' },
      { lesson_id: 'l1', student_id: 's3', status: 'late' },
      { lesson_id: 'l2', student_id: 's4', status: 'present' },
    ] as never);

    const absent = await getRegisterAbsentees('teacher-a', ['l1', 'l2']);

    const [sql, params] = lastQuery();
    expect(sql).toContain('submitted_by_teacher_id = ?');
    expect(params).toEqual(['teacher-a', 'l1', 'l2']);
    expect([...absent.entries()].map(([lesson, pupils]) => [lesson, [...pupils]])).toEqual([['l1', ['s2']]]);

    getAllAsync.mockClear();
    await expect(getRegisterAbsentees('teacher-a', [])).resolves.toEqual(new Map());
    expect(getAllAsync).not.toHaveBeenCalled();
  });
});
