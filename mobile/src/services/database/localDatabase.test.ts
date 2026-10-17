import * as SQLite from 'expo-sqlite';
import {
  clearCachedSchoolData,
  discardRefusedRecords,
  getPendingAttendanceRecords,
  getQueueCounts,
  getRefusedLessons,
  getStudentsByIds,
  initDatabase,
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
  openDatabaseAsync.mockResolvedValue({
    execAsync,
    // initDatabase asserts SQLCipher is actually compiled in before it trusts
    // the store — see the cipher_version check it makes on the connection.
    getFirstAsync,
    getAllAsync,
    runAsync,
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
