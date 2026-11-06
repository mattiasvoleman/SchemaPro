import * as Crypto from 'expo-crypto';
import { sortByDisplayName } from '../../utils/sorting';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import type { AttendanceStatus, CalendarLesson, PendingAttendanceRecord, PendingCrisisMark, Student } from '../../types';

// ─────────────────────────────────────────────────────────────────────────────
// The database is encrypted at rest with SQLCipher (compiled in via the
// `expo-sqlite` plugin `useSQLCipher` option in app.json). SQLCipher only
// encrypts once a key is supplied, so `initDatabase` derives a random 256-bit
// key, stores it in the OS keychain via expo-secure-store, and applies it with
// `PRAGMA key` as the FIRST statement on the connection (required by SQLCipher,
// before WAL / any table access). WAL mode is enabled for concurrent reads and
// foreign keys are enforced at the connection level.
// ─────────────────────────────────────────────────────────────────────────────

// The product's name before it was renamed Rastra. It names the file the
// attendance queue lives in: renamed in a later build of the same app, the
// queue a teacher had not yet sent would be left behind in the old file.
const DB_NAME = 'schemapro.db';
const DB_KEY_ID = 'sp_sqlcipher_key';
const DB_KEY_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
let _db: SQLite.SQLiteDatabase | null = null;
let _ready: { promise: Promise<void>; resolve: () => void } | null = null;

/**
 * Resolves once initDatabase has opened and keyed the store. A tap on an alarm
 * push can launch the app and be handled before the provider that opens the
 * database has finished (services/crisisOffline.ts remembers the alarm's time
 * from it), so a caller that must not lose the write waits here rather than
 * fail on getDb.
 */
export function whenDatabaseReady(): Promise<void> {
  if (_db) return Promise.resolve();
  if (!_ready) {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    _ready = { promise, resolve };
  }
  return _ready.promise;
}

/**
 * Returns the raw 64-hex-char (256-bit) SQLCipher key, generating and
 * persisting one in the device keychain on first use.
 */
async function getOrCreateDbKey(): Promise<string> {
  const existing = await SecureStore.getItemAsync(DB_KEY_ID, DB_KEY_STORE_OPTIONS);
  if (existing && existing.length === 64) {
    return existing;
  }
  const bytes = await Crypto.getRandomBytesAsync(32);
  const key = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  await SecureStore.setItemAsync(DB_KEY_ID, key, DB_KEY_STORE_OPTIONS);
  return key;
}

function getDb(): SQLite.SQLiteDatabase {
  if (!_db) {
    throw new Error('[LocalDatabase] Database is not initialized. Call initDatabase() first.');
  }
  return _db;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS students (
    id         TEXT PRIMARY KEY NOT NULL,
    display_name TEXT NOT NULL,
    photo_uri  TEXT
  );

  CREATE TABLE IF NOT EXISTS calendar_lessons (
    id           TEXT PRIMARY KEY NOT NULL,
    start_time   TEXT NOT NULL,
    end_time     TEXT NOT NULL,
    subject_name TEXT NOT NULL,
    room_name    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lesson_students (
    lesson_id  TEXT NOT NULL,
    student_id TEXT NOT NULL,
    PRIMARY KEY (lesson_id, student_id),
    FOREIGN KEY (lesson_id)  REFERENCES calendar_lessons(id) ON DELETE CASCADE,
    FOREIGN KEY (student_id) REFERENCES students(id)         ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS attendance_queue (
    id                       TEXT    PRIMARY KEY NOT NULL,
    lesson_id                TEXT    NOT NULL,
    student_id               TEXT    NOT NULL,
    status                   TEXT    NOT NULL
      CHECK(status IN ('present', 'absent', 'late', 'excused')),
    timestamp                TEXT    NOT NULL,
    submitted_by_teacher_id  TEXT    NOT NULL,
    retry_count              INTEGER NOT NULL DEFAULT 0,
    is_synced                INTEGER NOT NULL DEFAULT 0
  );

  -- Krisläge (F2). The last list the gateway gave each teacher, kept as the
  -- JSON it came as: the phone shows it again when the network is gone, and
  -- one row per teacher so a shared tablet never shows a colleague's pupils.
  CREATE TABLE IF NOT EXISTS crisis_lists (
    teacher_id TEXT PRIMARY KEY NOT NULL,
    as_of      TEXT NOT NULL,
    payload    TEXT NOT NULL
  );

  -- The roll call's own offline queue: every tap is written here first and
  -- sent when the network allows. A mark names its group by call OR by lesson
  -- (the gateway refuses both and neither), so the same rule is held here.
  CREATE TABLE IF NOT EXISTS crisis_queue (
    id          TEXT    PRIMARY KEY NOT NULL,
    call_id     TEXT,
    lesson_id   TEXT,
    student_id  TEXT    NOT NULL,
    state       TEXT    NOT NULL CHECK(state IN ('FOUND', 'MISSING')),
    at          TEXT    NOT NULL,
    teacher_id  TEXT    NOT NULL,
    retry_count INTEGER NOT NULL DEFAULT 0,
    is_synced   INTEGER NOT NULL DEFAULT 0,
    CHECK ((call_id IS NULL) <> (lesson_id IS NULL))
  );
  CREATE INDEX IF NOT EXISTS crisis_queue_unsent ON crisis_queue (teacher_id, is_synced, at);

  -- When the phone was told that an alarm began and that it ended (the time a
  -- push arrived), for the list it builds itself when no list ever came. One
  -- row: the alarm is the school's, not a teacher's.
  CREATE TABLE IF NOT EXISTS crisis_hint (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    alarm_at TEXT,
    ended_at TEXT
  );
`;

export async function initDatabase(): Promise<void> {
  const key = await getOrCreateDbKey();
  _db = await SQLite.openDatabaseAsync(DB_NAME);
  // PRAGMA key MUST be the first statement executed, before WAL or any table
  // access, or SQLCipher will not key the database.
  await _db.execAsync(`PRAGMA key = "x'${key}'";`);
  // Fail loudly if the build lacks SQLCipher (cipher_version is empty on plain
  // SQLite) so we never silently fall back to writing PII in plaintext.
  const cipher = await _db.getFirstAsync<{ cipher_version: string | null }>(
    'PRAGMA cipher_version;',
  );
  if (!cipher?.cipher_version) {
    throw new Error(
      '[LocalDatabase] SQLCipher is not active — refusing to store data unencrypted.',
    );
  }
  await _db.execAsync(SCHEMA_SQL);
  _ready?.resolve();
}

// ─── Students ─────────────────────────────────────────────────────────────────

export async function upsertStudents(students: readonly Student[]): Promise<void> {
  const db = getDb();
  await db.withTransactionAsync(async () => {
    for (const s of students) {
      await db.runAsync(
        'INSERT OR REPLACE INTO students (id, display_name, photo_uri) VALUES (?, ?, ?)',
        [s.id, s.displayName, s.photoUri ?? null],
      );
    }
  });
}

export async function getStudentsByIds(ids: readonly string[]): Promise<Student[]> {
  if (ids.length === 0) return [];
  const db = getDb();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await db.getAllAsync<{
    id: string;
    display_name: string;
    photo_uri: string | null;
  }>(
    // ORDER BY on the way out too: without it SQLite returns rows in whatever
    // order it stored them, so the roster changed shape between syncs. The
    // Swedish order is applied below — SQLite's own collation is ASCII.
    `SELECT id, display_name, photo_uri FROM students WHERE id IN (${placeholders}) ORDER BY display_name`,
    [...ids],
  );
  return sortByDisplayName(
    rows.map((r) => ({
      id: r.id,
      displayName: r.display_name,
      photoUri: r.photo_uri,
    })),
  );
}

// ─── Calendar Lessons ─────────────────────────────────────────────────────────

export async function upsertCalendarLesson(lesson: CalendarLesson): Promise<void> {
  const db = getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `INSERT OR REPLACE INTO calendar_lessons
         (id, start_time, end_time, subject_name, room_name)
       VALUES (?, ?, ?, ?, ?)`,
      [lesson.id, lesson.startTime, lesson.endTime, lesson.subjectName, lesson.roomName],
    );

    // Replace junction rows so the student list stays in sync.
    await db.runAsync('DELETE FROM lesson_students WHERE lesson_id = ?', [lesson.id]);
    for (const studentId of lesson.studentIds) {
      await db.runAsync(
        'INSERT OR IGNORE INTO lesson_students (lesson_id, student_id) VALUES (?, ?)',
        [lesson.id, studentId],
      );
    }
  });
}

export async function getCalendarLesson(lessonId: string): Promise<CalendarLesson | null> {
  const db = getDb();

  const lesson = await db.getFirstAsync<{
    id: string;
    start_time: string;
    end_time: string;
    subject_name: string;
    room_name: string;
  }>('SELECT * FROM calendar_lessons WHERE id = ?', [lessonId]);

  if (!lesson) return null;

  const studentRows = await db.getAllAsync<{ student_id: string }>(
    'SELECT student_id FROM lesson_students WHERE lesson_id = ?',
    [lessonId],
  );

  return {
    id: lesson.id,
    startTime: lesson.start_time,
    endTime: lesson.end_time,
    subjectName: lesson.subject_name,
    roomName: lesson.room_name,
    studentIds: studentRows.map((r) => r.student_id),
  };
}

// ─── Attendance Queue ──────────────────────────────────────────────────────────

export async function enqueueAttendanceRecord(
  record: Omit<PendingAttendanceRecord, 'retryCount'>,
): Promise<void> {
  const db = getDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO attendance_queue
       (id, lesson_id, student_id, status, timestamp, submitted_by_teacher_id, retry_count, is_synced)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0)`,
    [
      record.id,
      record.lessonId,
      record.studentId,
      record.status,
      record.timestamp,
      record.submittedByTeacherId,
    ],
  );
}

/**
 * The queue belonging to one teacher, and never anyone else's.
 *
 * A tablet is shared. Logout clears the keychain but not this database — the
 * encrypted store stays keyed and every unsynced row with it — so the next
 * teacher to sign in used to drain their colleague's queue under their own
 * token. The server stamps `recordedById` from the bearer it is given, so the
 * record ended up officially attributed to a teacher who was never in the room.
 *
 * The owner was written all along; nobody asked. Passing it is required rather
 * than optional so a new caller cannot quietly inherit the old behaviour.
 */
export async function getPendingAttendanceRecords(
  teacherId: string,
): Promise<PendingAttendanceRecord[]> {
  const db = getDb();
  const rows = await db.getAllAsync<{
    id: string;
    lesson_id: string;
    student_id: string;
    status: AttendanceStatus;
    timestamp: string;
    submitted_by_teacher_id: string;
    retry_count: number;
  }>(
    'SELECT * FROM attendance_queue WHERE is_synced = 0 AND submitted_by_teacher_id = ? ORDER BY timestamp ASC',
    [teacherId],
  );

  return rows.map((r) => ({
    id: r.id,
    lessonId: r.lesson_id,
    studentId: r.student_id,
    status: r.status,
    timestamp: r.timestamp,
    submittedByTeacherId: r.submitted_by_teacher_id,
    retryCount: r.retry_count,
  }));
}

export async function markAttendanceRecordSynced(id: string): Promise<void> {
  const db = getDb();
  await db.runAsync('UPDATE attendance_queue SET is_synced = 1 WHERE id = ?', [id]);
}

export async function incrementRetryCount(id: string): Promise<void> {
  const db = getDb();
  await db.runAsync(
    'UPDATE attendance_queue SET retry_count = retry_count + 1 WHERE id = ?',
    [id],
  );
}

/**
 * How many rows THIS teacher still has to send, and how many the server
 * refused for good (maxRetries permanent refusals), which are never sent again.
 *
 * The badge this feeds must agree with what the sync worker can actually
 * drain, and the worker only ever drains its own teacher's rows. Counting the
 * whole table made the badge stick at a number the signed-in teacher could
 * never work off — their colleague's unsent attendance, invisible to them and
 * unreachable by them. A count nobody can act on is worse than no count. So
 * a refused row is not pending either: the banner names it apart, and lets
 * the teacher see its lesson and discard it.
 */
export async function getQueueCounts(teacherId: string, maxRetries: number): Promise<{ pending: number; refused: number }> {
  const db = getDb();
  const row = await db.getFirstAsync<{ pending: number | null; refused: number | null }>(
    `SELECT SUM(CASE WHEN retry_count < ? THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN retry_count >= ? THEN 1 ELSE 0 END) AS refused
       FROM attendance_queue WHERE is_synced = 0 AND submitted_by_teacher_id = ?`,
    [maxRetries, maxRetries, teacherId],
  );
  return { pending: row?.pending ?? 0, refused: row?.refused ?? 0 };
}

/**
 * This teacher's refused rows by lesson, with the lesson as this phone last
 * saved it (null when it no longer holds it): what the banner names, so the
 * teacher knows which lesson to look at.
 */
export async function getRefusedLessons(
  teacherId: string,
  maxRetries: number,
): Promise<Array<{ lessonId: string; subjectName: string | null; startTime: string | null; markedAt: string; count: number }>> {
  const db = getDb();
  const rows = await db.getAllAsync<{
    lesson_id: string;
    subject_name: string | null;
    start_time: string | null;
    marked_at: string;
    count: number;
  }>(
    `SELECT q.lesson_id, l.subject_name, l.start_time, MIN(q.timestamp) AS marked_at, COUNT(*) AS count
       FROM attendance_queue q LEFT JOIN calendar_lessons l ON l.id = q.lesson_id
      WHERE q.is_synced = 0 AND q.submitted_by_teacher_id = ? AND q.retry_count >= ?
      GROUP BY q.lesson_id, l.subject_name, l.start_time
      ORDER BY MIN(q.timestamp) ASC`,
    [teacherId, maxRetries],
  );
  return rows.map((row) => ({
    lessonId: row.lesson_id,
    subjectName: row.subject_name,
    startTime: row.start_time,
    markedAt: row.marked_at,
    count: row.count,
  }));
}

/**
 * Forgets this teacher's refused rows of these lessons, once the teacher has
 * said so: the server will never take them, and the banner names them until
 * they go. Only the lessons the teacher was shown: a row refused meanwhile,
 * of another lesson, stays to be named.
 */
export async function discardRefusedRecords(teacherId: string, maxRetries: number, lessonIds: readonly string[]): Promise<void> {
  if (lessonIds.length === 0) return;
  const db = getDb();
  await db.runAsync(
    `DELETE FROM attendance_queue
      WHERE is_synced = 0 AND submitted_by_teacher_id = ? AND retry_count >= ?
        AND lesson_id IN (${lessonIds.map(() => '?').join(', ')})`,
    [teacherId, maxRetries, ...lessonIds],
  );
}

/**
 * Forgets the cached roster and timetable, and keeps the queue.
 *
 * A tablet is shared. Signing out used to clear three keychain items and
 * nothing else: the encrypted store stayed keyed, so the next teacher's app
 * opened holding the previous teacher's pupils by name. Those tables are a
 * cache — they come back on the next sync — so dropping them costs a refetch
 * and returns the device to a teacher who has not seen the class.
 *
 * `attendance_queue` is deliberately NOT touched. Unsynced attendance is a
 * legal record about a child and this device may hold the only copy; a teacher
 * who signs out at the end of a lesson must find it again when they sign back
 * in. It is already scoped by owner on read, on send and now on count, so it
 * is neither visible nor sendable by whoever signs in next.
 */
export async function clearCachedSchoolData(): Promise<void> {
  const db = getDb();
  // lesson_students cascades from calendar_lessons, but say it anyway: the
  // cascade depends on PRAGMA foreign_keys, which a future connection could
  // open without.
  //
  // The alarm list (crisis_lists) and when the phone was told of an alarm
  // (crisis_hint) are cache too: the list names every pupil of the teacher's
  // groups, and the next person to sign in must not read it. crisis_queue is
  // deliberately NOT touched, for the reason above: an unsent mark of a pupil
  // found or missing may be the only copy, and it is owned and scoped by its
  // teacher, so it is neither shown nor sent to whoever signs in next.
  await db.execAsync(
    'DELETE FROM lesson_students; DELETE FROM calendar_lessons; DELETE FROM students; DELETE FROM crisis_lists; DELETE FROM crisis_hint;',
  );
}

// ─── Krisläge: the list, the queue and the hint ────────────────────────────────

/** The list the gateway last gave this teacher, as the JSON it came as; null when the phone holds none. */
export async function getCrisisList(teacherId: string): Promise<{ asOf: string; payload: string } | null> {
  const db = getDb();
  const row = await db.getFirstAsync<{ as_of: string; payload: string }>(
    'SELECT as_of, payload FROM crisis_lists WHERE teacher_id = ?',
    [teacherId],
  );
  return row ? { asOf: row.as_of, payload: row.payload } : null;
}

/** Replaces this teacher's list. One row per teacher: a colleague's is a row of their own. */
export async function saveCrisisList(teacherId: string, asOf: string, payload: string): Promise<void> {
  const db = getDb();
  await db.runAsync('INSERT OR REPLACE INTO crisis_lists (teacher_id, as_of, payload) VALUES (?, ?, ?)', [
    teacherId,
    asOf,
    payload,
  ]);
}

/**
 * Writes taps to the queue, all or none. Each tap is a row of its own with the
 * phone's id, so a tap written twice is one row and one mark at the gateway.
 */
export async function enqueueCrisisMarks(marks: readonly Omit<PendingCrisisMark, 'retryCount'>[]): Promise<void> {
  if (marks.length === 0) return;
  const db = getDb();
  await db.withTransactionAsync(async () => {
    for (const mark of marks) {
      await db.runAsync(
        `INSERT OR REPLACE INTO crisis_queue
           (id, call_id, lesson_id, student_id, state, at, teacher_id, retry_count, is_synced)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`,
        [mark.id, mark.callId, mark.lessonId, mark.studentId, mark.state, mark.at, mark.teacherId],
      );
    }
  });
}

/**
 * The marks THIS teacher has not sent, oldest tap first so a pupil's marks
 * replay in the order they were made (the gateway keeps the latest by time).
 * Owner-scoped for the reason getPendingAttendanceRecords is: a tablet is
 * shared, and the gateway stamps the sender from the bearer it is given.
 */
export async function getPendingCrisisMarks(teacherId: string): Promise<PendingCrisisMark[]> {
  const db = getDb();
  const rows = await db.getAllAsync<{
    id: string;
    call_id: string | null;
    lesson_id: string | null;
    student_id: string;
    state: 'FOUND' | 'MISSING';
    at: string;
    teacher_id: string;
    retry_count: number;
  }>('SELECT * FROM crisis_queue WHERE is_synced = 0 AND teacher_id = ? ORDER BY at ASC, rowid ASC', [teacherId]);
  return rows.map((row) => ({
    id: row.id,
    callId: row.call_id,
    lessonId: row.lesson_id,
    studentId: row.student_id,
    state: row.state,
    at: row.at,
    teacherId: row.teacher_id,
    retryCount: row.retry_count,
  }));
}

const placeholders = (ids: readonly string[]): string => ids.map(() => '?').join(', ');

/** The marks the gateway has taken (stored, or already held): kept a while as sent, never sent again. */
export async function markCrisisMarksSynced(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = getDb();
  await db.runAsync(`UPDATE crisis_queue SET is_synced = 1 WHERE id IN (${placeholders(ids)})`, [...ids]);
}

/** Marks the gateway answered with something that is not about the network, counted so a row's history is visible. */
export async function incrementCrisisRetry(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = getDb();
  await db.runAsync(`UPDATE crisis_queue SET retry_count = retry_count + 1 WHERE id IN (${placeholders(ids)})`, [...ids]);
}

/** Forgets marks the gateway will never take (the alarm ended, the group is not theirs). */
export async function deleteCrisisMarks(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = getDb();
  await db.runAsync(`DELETE FROM crisis_queue WHERE id IN (${placeholders(ids)})`, [...ids]);
}

/** Sent rows older than `beforeIso` go: they were kept only to be read as sent for a while. */
export async function purgeSyncedCrisisMarks(beforeIso: string): Promise<void> {
  const db = getDb();
  await db.runAsync('DELETE FROM crisis_queue WHERE is_synced = 1 AND at < ?', [beforeIso]);
}

/** How many marks THIS teacher still has to send. */
export async function countPendingCrisisMarks(teacherId: string): Promise<number> {
  const db = getDb();
  const row = await db.getFirstAsync<{ n: number | null }>(
    'SELECT COUNT(*) AS n FROM crisis_queue WHERE is_synced = 0 AND teacher_id = ?',
    [teacherId],
  );
  return row?.n ?? 0;
}

/** The push times the phone knows of: when an alarm began and when it ended. Null where it was never told. */
export async function getCrisisHint(): Promise<{ alarmAt: string | null; endedAt: string | null } | null> {
  const db = getDb();
  const row = await db.getFirstAsync<{ alarm_at: string | null; ended_at: string | null }>(
    'SELECT alarm_at, ended_at FROM crisis_hint WHERE id = 1',
  );
  return row ? { alarmAt: row.alarm_at, endedAt: row.ended_at } : null;
}

/** An alarm push arrived at `atIso`. The latest time wins: a push delivered late must not move it back. */
export async function saveCrisisAlarmHint(atIso: string): Promise<void> {
  const db = getDb();
  await db.runAsync(
    `INSERT INTO crisis_hint (id, alarm_at, ended_at) VALUES (1, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET alarm_at = CASE WHEN alarm_at IS NULL OR excluded.alarm_at > alarm_at THEN excluded.alarm_at ELSE alarm_at END`,
    [atIso],
  );
}

/**
 * The gateway says no alarm is open, so a hint of an alarm push sent at or before `atIso` is not about
 * one going: the time is forgotten. A push sent later is another alarm's, and stays.
 */
export async function clearCrisisAlarmHint(atIso: string): Promise<void> {
  const db = getDb();
  await db.runAsync('UPDATE crisis_hint SET alarm_at = NULL WHERE id = 1 AND alarm_at <= ?', [atIso]);
}

/** An end push arrived at `atIso`. */
export async function saveCrisisEndedHint(atIso: string): Promise<void> {
  const db = getDb();
  await db.runAsync(
    `INSERT INTO crisis_hint (id, alarm_at, ended_at) VALUES (1, NULL, ?)
     ON CONFLICT(id) DO UPDATE SET ended_at = CASE WHEN ended_at IS NULL OR excluded.ended_at > ended_at THEN excluded.ended_at ELSE ended_at END`,
    [atIso],
  );
}

/**
 * The lessons this phone holds around a moment, with their pupils, for the
 * list it builds when no list ever came. Only the lessons the teacher has
 * opened for attendance (services/roster.ts) or the gateway has broadcast are
 * here. The window is the stored dates (both ISO forms start with the UTC
 * day), a day either side of `dayIso`, and the caller applies the real times.
 */
export async function getCachedLessonsAround(dayIso: string): Promise<CalendarLesson[]> {
  const db = getDb();
  const day = new Date(dayIso).getTime();
  const iso = (offset: number): string => new Date(day + offset * 86_400_000).toISOString().slice(0, 10);
  const lessons = await db.getAllAsync<{
    id: string;
    start_time: string;
    end_time: string;
    subject_name: string;
    room_name: string;
  }>('SELECT * FROM calendar_lessons WHERE substr(start_time, 1, 10) BETWEEN ? AND ? ORDER BY start_time', [iso(-1), iso(1)]);
  if (lessons.length === 0) return [];
  const pupils = await db.getAllAsync<{ lesson_id: string; student_id: string }>(
    `SELECT lesson_id, student_id FROM lesson_students WHERE lesson_id IN (${placeholders(lessons.map((l) => l.id))})`,
    lessons.map((l) => l.id),
  );
  const byLesson = new Map<string, string[]>();
  for (const pupil of pupils) byLesson.set(pupil.lesson_id, [...(byLesson.get(pupil.lesson_id) ?? []), pupil.student_id]);
  return lessons.map((lesson) => ({
    id: lesson.id,
    startTime: lesson.start_time,
    endTime: lesson.end_time,
    subjectName: lesson.subject_name,
    roomName: lesson.room_name,
    studentIds: byLesson.get(lesson.id) ?? [],
  }));
}

/**
 * The pupils THIS teacher has marked absent (or excused) in the register of
 * these lessons, by lesson: the latest mark of each pupil decides. The
 * attendance queue keeps its rows after they are sent, so this is also what the
 * teacher took at the start of the lesson the alarm interrupted.
 */
export async function getRegisterAbsentees(teacherId: string, lessonIds: readonly string[]): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  if (lessonIds.length === 0) return result;
  const db = getDb();
  const rows = await db.getAllAsync<{ lesson_id: string; student_id: string; status: AttendanceStatus }>(
    `SELECT lesson_id, student_id, status FROM attendance_queue
      WHERE submitted_by_teacher_id = ? AND lesson_id IN (${placeholders(lessonIds)})
      ORDER BY timestamp ASC, rowid ASC`,
    [teacherId, ...lessonIds],
  );
  // Rows come oldest first, so the last one a pupil has in a lesson is the one that stands.
  const latest = new Map<string, Map<string, AttendanceStatus>>();
  for (const row of rows) {
    const pupils = latest.get(row.lesson_id) ?? new Map<string, AttendanceStatus>();
    pupils.set(row.student_id, row.status);
    latest.set(row.lesson_id, pupils);
  }
  for (const [lessonId, pupils] of latest) {
    const absent = [...pupils].filter(([, status]) => status === 'absent' || status === 'excused').map(([studentId]) => studentId);
    if (absent.length > 0) result.set(lessonId, new Set(absent));
  }
  return result;
}
