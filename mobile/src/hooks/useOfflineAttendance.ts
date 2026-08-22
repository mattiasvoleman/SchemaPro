import { useCallback, useState } from 'react';
import * as ExpoCrypto from 'expo-crypto';
import { SecureTokenStore } from '../services/auth/secureTokenStore';
import {
  enqueueAttendanceRecord,
  getPendingAttendanceRecords,
} from '../services/database/localDatabase';
import type { AttendanceStatus, PendingAttendanceRecord } from '../types';

interface UseOfflineAttendanceReturn {
  readonly pendingRecords: PendingAttendanceRecord[];
  readonly isSubmitting: boolean;
  /**
   * Writes an attendance record to the local SQLite queue.
   * The SyncWorker will automatically push it to the API when online.
   */
  readonly enqueue: (
    lessonId: string,
    studentId: string,
    status: AttendanceStatus,
    teacherId: string,
  ) => Promise<void>;
  /** Re-reads the queue from SQLite and refreshes local state. */
  readonly refreshQueue: () => Promise<void>;
}

/**
 * Offline-first hook for writing attendance records.
 * All writes go to the local SQLite queue first; sync is handled separately
 * by AttendanceSyncWorker (managed in SyncContext).
 */
export function useOfflineAttendance(): UseOfflineAttendanceReturn {
  const [pendingRecords, setPendingRecords] = useState<PendingAttendanceRecord[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const refreshQueue = useCallback(async (): Promise<void> => {
    // This teacher's own queue. A shared tablet keeps a colleague's unsynced
    // rows in the same encrypted store, and they are not this teacher's to see
    // or to send.
    const session = await SecureTokenStore.getTeacherSession();
    setPendingRecords(session ? await getPendingAttendanceRecords(session.teacherId) : []);
  }, []);

  const enqueue = useCallback(
    async (
      lessonId: string,
      studentId: string,
      status: AttendanceStatus,
      teacherId: string,
    ): Promise<void> => {
      setIsSubmitting(true);
      try {
        const record: Omit<PendingAttendanceRecord, 'retryCount'> = {
          id: ExpoCrypto.randomUUID(),
          lessonId,
          studentId,
          status,
          timestamp: new Date().toISOString(),
          submittedByTeacherId: teacherId,
        };
        await enqueueAttendanceRecord(record);
        await refreshQueue();
      } finally {
        setIsSubmitting(false);
      }
    },
    [refreshQueue],
  );

  return { pendingRecords, isSubmitting, enqueue, refreshQueue };
}
