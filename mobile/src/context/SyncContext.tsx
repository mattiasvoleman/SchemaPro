import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { initDatabase, upsertCalendarLesson } from '../services/database/localDatabase';
import { AttendanceSyncWorker } from '../services/sync/attendance_sync_worker';
import { WebSocketClient } from '../services/sync/websocket_client';
import { useAuth } from './AuthContext';
import type {
  CalendarLesson,
  CalendarLessonUpdatedPayload,
  SyncProblem,
  SyncState,
  SyncStatus,
} from '../types';

interface SyncContextValue {
  readonly syncState: SyncState;
  /** The lesson currently being taken. Set this from the lesson picker. */
  readonly activeLesson: CalendarLesson | null;
  readonly setActiveLesson: (lesson: CalendarLesson | null) => void;
  /** Request an immediate sync cycle (e.g. after queuing new records). */
  readonly triggerManualSync: () => Promise<void>;
}

const SyncContext = createContext<SyncContextValue | null>(null);

/**
 * Bootstraps the SQLite database, starts the background sync worker, and
 * opens the WebSocket connection once the teacher is authenticated.
 *
 * When a `calendar_lesson_updated` event arrives the active lesson state is
 * refreshed immediately — no manual reload required.
 */
export function SyncProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const { authState } = useAuth();

  const [syncState, setSyncState] = useState<SyncState>({
    status: 'offline',
    lastSyncedAt: null,
    pendingCount: 0,
    problem: null,
  });
  const [activeLesson, setActiveLesson] = useState<CalendarLesson | null>(null);
  const [isDbReady, setIsDbReady] = useState(false);

  const workerRef = useRef<AttendanceSyncWorker | null>(null);
  const wsRef = useRef<WebSocketClient | null>(null);

  // ── Database initialisation (once) ──────────────────────────────────────
  useEffect(() => {
    void initDatabase().then(() => setIsDbReady(true));
  }, []);

  // ── Worker + WebSocket (only when authenticated and DB is ready) ─────────
  useEffect(() => {
    if (!isDbReady || !authState.isAuthenticated) return;

    const worker = new AttendanceSyncWorker(
      (status: SyncStatus, pendingCount: number, problem: SyncProblem | null) => {
        setSyncState((prev) => ({
          ...prev,
          status,
          pendingCount,
          problem,
          lastSyncedAt:
            status === 'connected' && pendingCount === 0
              ? new Date().toISOString()
              : prev.lastSyncedAt,
        }));
      },
    );

    const wsClient = new WebSocketClient(
      (payload: CalendarLessonUpdatedPayload) => {
        // Persist to SQLite cache and refresh UI state atomically.
        void upsertCalendarLesson(payload.updatedLesson).then(() => {
          setActiveLesson((prev) =>
            prev?.id === payload.lessonId ? payload.updatedLesson : prev,
          );
        });
      },
      (connected: boolean) => {
        setSyncState((prev) => ({
          ...prev,
          status: connected ? 'connected' : 'offline',
        }));
      },
    );

    workerRef.current = worker;
    wsRef.current = wsClient;

    worker.start();
    void wsClient.connect();

    return () => {
      worker.stop();
      wsClient.disconnect();
      workerRef.current = null;
      wsRef.current = null;
    };
  }, [isDbReady, authState.isAuthenticated]);

  const triggerManualSync = useCallback(async (): Promise<void> => {
    if (workerRef.current) {
      await workerRef.current.runSyncCycle();
    }
  }, []);

  return (
    <SyncContext.Provider value={{ syncState, activeLesson, setActiveLesson, triggerManualSync }}>
      {children}
    </SyncContext.Provider>
  );
}

export function useSync(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error('useSync must be used inside <SyncProvider>');
  return ctx;
}
