import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as ExpoCrypto from 'expo-crypto';
import { useFocusEffect } from 'expo-router';
import { useSync } from '../context/SyncContext';
import {
  adminFailureOf,
  endAlarm,
  fetchAlarmDetail,
  fetchAlarmList,
  isTransportFailure,
  markAway,
  openAlarms,
  startAlarm,
  type AdminFailure,
  type AlarmDetail,
  type CrisisKind,
  type CrisisMode,
} from '../services/crisis';
import { noNetwork } from '../services/network/deviceOffline';

/**
 * The administrator's view of an alarm (Krisläge, F2): start it, watch the
 * roll call, end it. Everything here is live: an alarm is started and ended
 * now or not at all, so nothing is queued, and a phone with no network is told
 * so (a start or an end that was delayed would be a different alarm).
 *
 * READ AGAIN. When the tab is shown, when the app returns to the front, when the
 * gateway says an alarm began or ended (crisis_updated), by a pull, and every
 * POLL_MS while an alarm is going: the counts, the teachers who have not
 * answered and the pupils marked missing are the roll call as it is now.
 * Every read asks for the school's open alarms and then each one's detail.
 *
 * ONE ACTION AT A TIME. A start, an end and a pupil marked "inte i huset" are
 * single-flight: while one is in the air the buttons are disabled, and a second
 * tap that gets in before the render is dropped by the ref.
 *
 * NOT IN THE BUILDING. The administration alone can say a pupil is not in the
 * building (state AWAY, on the pupil's own group): a pupil nobody has seen. It
 * is live like everything here, never queued, and the pupil is then counted for
 * themselves, never as found.
 */

/** How often the roll call is read while an alarm is going. */
export const POLL_MS = 5_000;

export type AdminAction =
  | { readonly kind: 'START'; readonly mode: CrisisMode }
  | { readonly kind: 'END'; readonly alarmId: string }
  | { readonly kind: 'AWAY'; readonly alarmId: string; readonly studentId: string };

export interface AdminFailureNote {
  readonly action: 'START' | 'END' | 'AWAY';
  readonly code: AdminFailure;
  /** For a start refused because one is going: which mode. */
  readonly mode?: CrisisMode;
}

export interface CrisisAdminState {
  readonly isLoading: boolean;
  readonly isRefreshing: boolean;
  /** The alarms going now, with every group, teacher and pupil. */
  readonly details: readonly AlarmDetail[];
  /** Why the last read failed; what is shown is then the last one read. */
  readonly problem: 'OFFLINE' | 'FAILED' | null;
  readonly hasLoaded: boolean;
  /** When the roll call shown was read. */
  readonly updatedAt: string | null;
  readonly busy: AdminAction | null;
  readonly failure: AdminFailureNote | null;
  readonly refresh: () => void;
  readonly start: (kind: CrisisKind, mode: CrisisMode) => Promise<void>;
  readonly end: (alarmId: string) => Promise<void>;
  /** Says a pupil is not in the building, on the pupil's own group. */
  readonly away: (alarm: { readonly id: string; readonly startedAt: string }, callId: string, studentId: string) => Promise<void>;
  readonly dismissFailure: () => void;
}

export function useCrisisAdmin(enabled: boolean): CrisisAdminState {
  const { crisisUpdate } = useSync();
  const [details, setDetails] = useState<readonly AlarmDetail[]>([]);
  const [problem, setProblem] = useState<'OFFLINE' | 'FAILED' | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(enabled);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState<AdminAction | null>(null);
  const [failure, setFailure] = useState<AdminFailureNote | null>(null);

  const newest = useRef(0);
  const alive = useRef(true);
  const acting = useRef(false);
  const going = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    const mine = ++newest.current;
    const current = (): boolean => alive.current && mine === newest.current;
    try {
      const open = openAlarms(await fetchAlarmList());
      const next = await Promise.all(open.map((alarm) => fetchAlarmDetail(alarm.id)));
      if (!current()) return;
      going.current = next.length > 0;
      setDetails(next);
      setUpdatedAt(new Date().toISOString());
      setHasLoaded(true);
      setProblem(null);
    } catch (error) {
      const why = isTransportFailure(error) || (await noNetwork()) ? 'OFFLINE' : 'FAILED';
      if (current()) setProblem(why);
    } finally {
      if (current()) {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (!enabled) return;
      void load();
      const timer = setInterval(() => {
        if (going.current) void load();
      }, POLL_MS);
      const subscription = AppState.addEventListener('change', (next) => {
        if (next === 'active') void load();
      });
      return () => {
        clearInterval(timer);
        subscription.remove();
      };
    }, [enabled, load]),
  );

  const lastUpdate = useRef(crisisUpdate);
  useEffect(() => {
    if (crisisUpdate === lastUpdate.current) return;
    lastUpdate.current = crisisUpdate;
    if (enabled && crisisUpdate) void load();
  }, [enabled, crisisUpdate, load]);

  const refresh = useCallback((): void => {
    setIsRefreshing(true);
    void load();
  }, [load]);

  const start = useCallback(
    async (kind: CrisisKind, mode: CrisisMode): Promise<void> => {
      if (acting.current) return;
      acting.current = true;
      setBusy({ kind: 'START', mode });
      setFailure(null);
      try {
        await startAlarm(kind, mode);
        if (alive.current) await load();
      } catch (error) {
        const code = adminFailureOf(error);
        if (alive.current) setFailure({ action: 'START', code, mode });
        // One is already going: show it.
        if (code === 'ALARM_OPEN' && alive.current) await load();
      } finally {
        acting.current = false;
        if (alive.current) setBusy(null);
      }
    },
    [load],
  );

  const end = useCallback(
    async (alarmId: string): Promise<void> => {
      if (acting.current) return;
      acting.current = true;
      setBusy({ kind: 'END', alarmId });
      setFailure(null);
      try {
        await endAlarm(alarmId);
        if (alive.current) await load();
      } catch (error) {
        const code = adminFailureOf(error);
        if (alive.current) setFailure({ action: 'END', code });
        // Over already, or gone: the list is not what it was.
        if ((code === 'ENDED' || code === 'NOT_FOUND') && alive.current) await load();
      } finally {
        acting.current = false;
        if (alive.current) setBusy(null);
      }
    },
    [load],
  );

  const away = useCallback(
    async (alarm: { readonly id: string; readonly startedAt: string }, callId: string, studentId: string): Promise<void> => {
      if (acting.current) return;
      acting.current = true;
      setBusy({ kind: 'AWAY', alarmId: alarm.id, studentId });
      setFailure(null);
      try {
        const markId = ExpoCrypto.randomUUID();
        const result = await markAway(alarm, callId, studentId, markId);
        // Taken by the gateway, or refused as belonging to no alarm of the school's.
        if (result.unresolved.includes(markId) && alive.current) setFailure({ action: 'AWAY', code: 'FAILED' });
        if (alive.current) await load();
      } catch (error) {
        const code = adminFailureOf(error);
        if (alive.current) setFailure({ action: 'AWAY', code });
        // Over already, or gone: the list is not what it was.
        if ((code === 'ENDED' || code === 'NOT_FOUND') && alive.current) await load();
      } finally {
        acting.current = false;
        if (alive.current) setBusy(null);
      }
    },
    [load],
  );

  const dismissFailure = useCallback((): void => setFailure(null), []);

  return { isLoading, isRefreshing, details, problem, hasLoaded, updatedAt, busy, failure, refresh, start, end, away, dismissFailure };
}
