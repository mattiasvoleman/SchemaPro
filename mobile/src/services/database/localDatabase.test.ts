import * as SQLite from 'expo-sqlite';
import { getPendingAttendanceRecords, getStudentsByIds, initDatabase } from './localDatabase';

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
  openDatabaseAsync.mockResolvedValue({
    execAsync: jest.fn(async () => undefined),
    // initDatabase asserts SQLCipher is actually compiled in before it trusts
    // the store — see the cipher_version check it makes on the connection.
    getFirstAsync: jest.fn(async () => ({ cipher_version: '4.5.5 community' })),
    getAllAsync,
    runAsync: jest.fn(async () => ({ changes: 0, lastInsertRowId: 0 })),
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
