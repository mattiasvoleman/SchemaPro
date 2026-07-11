import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import type { AttendanceStatus, CalendarLesson, PendingAttendanceRecord, Student } from '../../types';

// ─────────────────────────────────────────────────────────────────────────────
// The database is encrypted at rest with SQLCipher (compiled in via the
// `expo-sqlite` plugin `useSQLCipher` option in app.json). SQLCipher only
// encrypts once a key is supplied, so `initDatabase` derives a random 256-bit
// key, stores it in the OS keychain via expo-secure-store, and applies it with
// `PRAGMA key` as the FIRST statement on the connection (required by SQLCipher,
// before WAL / any table access). WAL mode is enabled for concurrent reads and
// foreign keys are enforced at the connection level.
// ─────────────────────────────────────────────────────────────────────────────

const DB_NAME = 'schemapro.db';
const DB_KEY_ID = 'sp_sqlcipher_key';
const DB_KEY_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
let _db: SQLite.SQLiteDatabase | null = null;

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
    `SELECT id, display_name, photo_uri FROM students WHERE id IN (${placeholders})`,
    [...ids],
  );
  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    photoUri: r.photo_uri,
  }));
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

export async function getPendingAttendanceRecords(): Promise<PendingAttendanceRecord[]> {
  const db = getDb();
  const rows = await db.getAllAsync<{
    id: string;
    lesson_id: string;
    student_id: string;
    status: AttendanceStatus;
    timestamp: string;
    submitted_by_teacher_id: string;
    retry_count: number;
  }>('SELECT * FROM attendance_queue WHERE is_synced = 0 ORDER BY timestamp ASC');

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

export async function getPendingQueueCount(): Promise<number> {
  const db = getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM attendance_queue WHERE is_synced = 0',
  );
  return row?.count ?? 0;
}
