import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import { useNetwork } from '../context/NetworkContext';
import { useSync } from '../context/SyncContext';
import {
  fetchMyCrisis,
  isLocalCall,
  isTransportFailure,
  teacherBlocks,
  unmarkedPupils,
  withSentMarks,
  type AlarmBlock,
  type AlarmHint,
  type MyCall,
  type MyCrisisResponse,
  type OtherPupil,
} from '../services/crisis';
import { readCachedCrisis, saveCachedCrisis } from '../services/crisisCache';
import {
  loadLocalCalls,
  needsLocalList,
  readAlarmHint,
  rememberPresentedCrisisPushes,
  subscribeAlarmHint,
} from '../services/crisisOffline';
import {
  cancelQueuedFound,
  flushCrisisQueue,
  newCrisisMark,
  queueCrisisMarks,
  subscribeCrisisQueue,
  takeUnseenDrops,
  type Dropped,
} from '../services/crisisQueue';
import { getPendingCrisisMarks, whenDatabaseReady } from '../services/database/localDatabase';
import { noNetwork } from '../services/network/deviceOffline';
import type { CrisisMarkState, PendingCrisisMark } from '../types';

/**
 * The teacher's roll call of an alarm (Krisläge, F2). services/crisis.ts is
 * the gateway client and the view of a list; services/crisisQueue.ts is the
 * outbox; this holds the screen's state around them.
 *
 * THE SAME LIST OFFLINE. On opening, the list the phone kept for this teacher
 * (crisis_lists) is shown at once, before the gateway has been asked, and
 * replaced when it answers; a gateway that cannot be reached leaves the kept
 * one, marked with the time it was read. When the push told of an alarm and no
 * list for it ever came, the phone builds one from its own cache
 * (services/crisisOffline.ts) and replaces it with the gateway's the moment
 * that arrives.
 *
 * A TAP IS WRITTEN FIRST. mark() writes the tap to the queue and only then
 * says it is saved; what the pupil shows as is the teacher's latest tap, sent
 * or not, with a clock on it until the gateway has it. Sending is left to the
 * queue: after the tap, and on the timer below while this screen is open.
 *
 * A PUPIL WHO IS ON NO LIST. markFoundHere() says "found with me" for a pupil
 * the teacher picked in the search (services/crisis.ts searchOtherPupils, which the
 * picker asks the gateway for as the teacher types; nothing of it is kept here):
 * the same queue, the same route, a FOUND mark naming the teacher's call, or,
 * for a teacher with no group right now, the alarm. Only FOUND: a pupil who is
 * not on the list cannot be missing from it, the gateway refuses MISSING for one,
 * and mark() therefore never writes it. The pupil shows under the call ("Hittade
 * hos dig"), or under the alarm ("Hittade av dig"), with a clock until the gateway
 * has the mark (crisis.ts overlayMarks). retractFoundHere() takes the pupil back
 * while the alarm is going: a RETRACTED mark, and the row is gone at once; a found
 * that has not left the phone is simply deleted, and nothing is sent about it.
 *
 * READ AGAIN. When the tab is shown, when the app returns to the front, when the
 * network returns, when the gateway says an alarm began or ended
 * (crisis_updated), after marks were taken, and on a timer: every RETRY_MS the
 * queue is sent again, and the list is read again when the last read failed or
 * every third tick (a colleague's marks on a shared group, an end the push did
 * not carry).
 */

/** How often the screen sends what is queued, and tries again after a read that failed. */
export const RETRY_MS = 5_000;
/** The list is read again this many ticks apart when nothing is wrong. */
const READ_EVERY_TICKS = 3;

export interface CrisisState {
  /** Nothing is known yet: no kept list and no answer. */
  readonly isLoading: boolean;
  readonly isRefreshing: boolean;
  readonly blocks: readonly AlarmBlock[];
  /** `${callId}:${studentId}` of every pupil whose latest tap the gateway has not yet taken. */
  readonly waiting: ReadonlySet<string>;
  /** Taps waiting for the network. */
  readonly waitingCount: number;
  /** When the list shown was read, when it is not this moment's (kept, or the last read failed). */
  readonly listAsOf: string | null;
  /** The screen's clock, moved on every tick: what a list's age is counted from. */
  readonly now: number;
  /** Why the last read failed; the list shown, if any, is then the one read before. */
  readonly problem: 'OFFLINE' | 'FAILED' | null;
  readonly hasLoaded: boolean;
  /** Taps the gateway refused for good and the phone forgot, until the teacher closes the notice. */
  readonly dropped: readonly Dropped[];
  /** The last tap could not be written to the phone. */
  readonly saveFailed: boolean;
  readonly refresh: () => void;
  readonly mark: (call: MyCall, studentId: string, state: CrisisMarkState) => Promise<void>;
  /** "Found with me": a pupil who is on none of the teacher's lists, found by this teacher on this call (or, with no group, in this alarm). */
  readonly markFoundHere: (target: FoundTarget, pupil: OtherPupil) => Promise<void>;
  /** Takes a pupil found with the teacher back, while the alarm is going. */
  readonly retractFoundHere: (target: FoundTarget, studentId: string) => Promise<void>;
  readonly markAllFound: (call: MyCall) => Promise<void>;
  readonly dismissDropped: () => void;
}

const NO_CALLS: readonly MyCall[] = [];

/** Where a pupil is found: with one of the teacher's groups, or, with no group right now, in the alarm. */
export type FoundTarget = { readonly call: MyCall } | { readonly alarmId: string };

export function useCrisis(enabled: boolean): CrisisState {
  const { authState } = useAuth();
  const teacherId = authState.isAuthenticated ? authState.teacherId : null;
  const { networkState } = useNetwork();
  const { crisisUpdate } = useSync();
  const online = networkState.isConnected && networkState.isInternetReachable;

  const [response, setResponse] = useState<MyCrisisResponse | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [pending, setPending] = useState<readonly PendingCrisisMark[]>([]);
  const [local, setLocal] = useState<readonly MyCall[]>(NO_CALLS);
  const [hint, setHint] = useState<AlarmHint | null>(null);
  const [problem, setProblem] = useState<'OFFLINE' | 'FAILED' | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(enabled);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [dropped, setDropped] = useState<readonly Dropped[]>([]);
  const [saveFailed, setSaveFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  /** The newest read: an older answer arriving late never replaces it. */
  const newest = useRef(0);
  const newestLocal = useRef(0);
  const alive = useRef(true);
  const readFresh = useRef(false);
  const problemRef = useRef<'OFFLINE' | 'FAILED' | null>(null);
  const responseRef = useRef<MyCrisisResponse | null>(null);
  const blocksRef = useRef<readonly AlarmBlock[]>([]);
  const hintRef = useRef<AlarmHint | null>(null);
  problemRef.current = problem;
  responseRef.current = response;
  hintRef.current = hint;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reloadPending = useCallback(async (): Promise<void> => {
    if (!teacherId) return;
    await whenDatabaseReady();
    const rows = await getPendingCrisisMarks(teacherId).catch(() => null);
    if (rows && alive.current) setPending(rows);
    // A tap written between the read and this line is in the next read.
  }, [teacherId]);

  /** The list the phone builds itself, when the push told of an alarm and no list for it has been read. */
  const refreshLocal = useCallback(async (): Promise<void> => {
    if (!teacherId) return;
    const mine = ++newestLocal.current;
    const known = await readAlarmHint();
    let calls: readonly MyCall[] = NO_CALLS;
    if (known && known.alarmAt !== null && needsLocalList(known, responseRef.current)) {
      calls = await loadLocalCalls(known.alarmAt, teacherId).catch(() => NO_CALLS);
    }
    if (!alive.current || mine !== newestLocal.current) return;
    setHint(known);
    setLocal(calls);
  }, [teacherId]);

  const load = useCallback(async (): Promise<void> => {
    if (!teacherId) return;
    const mine = ++newest.current;
    const current = (): boolean => alive.current && mine === newest.current;
    try {
      const next = await fetchMyCrisis();
      if (!current()) return;
      readFresh.current = true;
      responseRef.current = next;
      setResponse(next);
      setFromCache(false);
      setProblem(null);
      setHasLoaded(true);
      void saveCachedCrisis(teacherId, next).catch(() => undefined);
    } catch (error) {
      const why = isTransportFailure(error) || (await noNetwork()) ? 'OFFLINE' : 'FAILED';
      if (current()) setProblem(why);
    } finally {
      if (current()) {
        setIsLoading(false);
        setIsRefreshing(false);
        setNow(Date.now());
        void refreshLocal();
      }
    }
  }, [teacherId, refreshLocal]);

  // What the phone holds, before the gateway is asked: the kept list, the
  // taps not yet sent, the notices of taps dropped while the screen was away,
  // and what the queue tells while the screen is mounted.
  useEffect(() => {
    if (!enabled || !teacherId) return;
    readFresh.current = false;
    void readCachedCrisis(teacherId)
      .catch(() => null)
      .then((cached) => {
        if (!alive.current || readFresh.current || !cached) return;
        responseRef.current = cached.response;
        setResponse(cached.response);
        setFromCache(true);
        setIsLoading(false);
        void refreshLocal();
      });
    void reloadPending();
    const unseen = takeUnseenDrops();
    if (unseen.length > 0) setDropped((all) => merged(all, unseen));
    return subscribeCrisisQueue((event) => {
      if (event.type === 'ENQUEUED') {
        void reloadPending();
        return;
      }
      const { sent, dropped: lost } = event.result;
      if (sent.length > 0 && responseRef.current) {
        // What the gateway has taken is written into the list shown, so the list does not
        // fall back to what it was before the tap while the next read is on its way.
        const next = withSentMarks(responseRef.current, sent);
        responseRef.current = next;
        setResponse(next);
        void load();
      }
      if (lost.length > 0) {
        const more = takeUnseenDrops();
        setDropped((all) => merged(all, more));
      }
      void reloadPending();
    });
  }, [enabled, teacherId, reloadPending, refreshLocal, load]);

  // The hint changed (a push was put to the gateway and remembered, or forgotten): read again, which
  // also builds or drops the phone's own list from the hint as it now stands.
  useEffect(() => {
    if (!enabled || !teacherId) return;
    return subscribeAlarmHint(() => {
      void load();
    });
  }, [enabled, teacherId, load]);

  // The tab is shown: read, send, and keep sending while it is.
  useFocusEffect(
    useCallback(() => {
      if (!enabled || !teacherId) return;
      void rememberPresentedCrisisPushes().then(refreshLocal);
      void load();
      void flushCrisisQueue();
      let ticks = 0;
      const timer = setInterval(() => {
        ticks++;
        void flushCrisisQueue();
        if (problemRef.current !== null || ticks % READ_EVERY_TICKS === 0) void load();
        setNow(Date.now());
      }, RETRY_MS);
      const subscription = AppState.addEventListener('change', (next) => {
        if (next !== 'active') return;
        void rememberPresentedCrisisPushes().then(refreshLocal);
        void load();
        void flushCrisisQueue();
      });
      return () => {
        clearInterval(timer);
        subscription.remove();
      };
    }, [enabled, teacherId, load, refreshLocal]),
  );

  // The network is back: send first (a tap is worth more than a list), then read.
  const wasOnline = useRef(online);
  useEffect(() => {
    const returned = online && !wasOnline.current;
    wasOnline.current = online;
    if (!enabled || !teacherId || !returned) return;
    void flushCrisisQueue();
    void load();
  }, [enabled, teacherId, online, load]);

  // The gateway says an alarm began or ended.
  const lastUpdate = useRef(crisisUpdate);
  useEffect(() => {
    if (crisisUpdate === lastUpdate.current) return;
    lastUpdate.current = crisisUpdate;
    if (!enabled || !teacherId || !crisisUpdate) return;
    void load();
    void flushCrisisQueue();
  }, [enabled, teacherId, crisisUpdate, load]);

  const view = useMemo(() => teacherBlocks({ response, local, pending, hint, now }), [response, local, pending, hint, now]);
  blocksRef.current = view.blocks;

  const refresh = useCallback((): void => {
    setIsRefreshing(true);
    void load();
    void flushCrisisQueue();
  }, [load]);

  const write = useCallback(
    async (rows: ReturnType<typeof newCrisisMark>[]): Promise<void> => {
      if (rows.length === 0) return;
      try {
        await queueCrisisMarks(rows);
        if (!alive.current) return;
        setSaveFailed(false);
        // At once, without waiting for the read of the queue the write also causes: by id, so that the two meet.
        setPending((all) => {
          const ids = new Set(all.map((row) => row.id));
          return [...all, ...rows.filter((row) => !ids.has(row.id)).map((row) => ({ ...row, retryCount: 0 }))];
        });
      } catch {
        // The phone could not keep the tap: it must not look kept.
        if (alive.current) setSaveFailed(true);
      }
    },
    [],
  );

  const mark = useCallback(
    async (call: MyCall, studentId: string, state: CrisisMarkState): Promise<void> => {
      if (!teacherId) return;
      // A tap on what the pupil already shows as is no news: it would only send a mark nobody needs.
      const shown = blocksRef.current.flatMap((block) => block.calls).find((candidate) => candidate.id === call.id);
      const onList = shown?.pupils.find((pupil) => pupil.studentId === studentId);
      if (onList?.status === state) return;
      // A pupil who is not on the list cannot be missing from it: the gateway would refuse the mark.
      if (shown && !onList && state === 'MISSING') return;
      await write([newCrisisMark({ call, studentId, state, teacherId, notBefore: hintRef.current?.alarmAt ?? null })]);
    },
    [teacherId, write],
  );

  /** The block of the screen a target is in (the alarm of its call, or the alarm itself). */
  const blockOf = useCallback(
    (target: FoundTarget): AlarmBlock | undefined =>
      blocksRef.current.find((block) => ('alarmId' in target ? block.key === target.alarmId : block.calls.some((candidate) => candidate.id === target.call.id))),
    [],
  );

  const markFoundHere = useCallback(
    async (target: FoundTarget, pupil: OtherPupil): Promise<void> => {
      if (!teacherId) return;
      const block = blockOf(target);
      // A list the phone built has no search to pick from, and its marks name a lesson, not a call.
      if (block?.local || ('call' in target && isLocalCall(target.call))) return;
      const who = { firstName: pupil.firstName, lastName: pupil.lastName, className: pupil.className };
      const notBefore = hintRef.current?.alarmAt ?? null;
      if ('alarmId' in target) {
        if (block?.foundFree.some((held) => held.studentId === pupil.studentId)) return;
        await write([newCrisisMark({ alarmId: target.alarmId, studentId: pupil.studentId, state: 'FOUND', teacherId, pupil: who, notBefore })]);
        return;
      }
      const shown = block?.calls.find((candidate) => candidate.id === target.call.id) ?? target.call;
      // Already found with this teacher, or a pupil of this very list: no news to send.
      if (shown.foundHere.some((held) => held.studentId === pupil.studentId)) return;
      if (shown.pupils.some((held) => held.studentId === pupil.studentId)) return mark(target.call, pupil.studentId, 'FOUND');
      await write([newCrisisMark({ call: target.call, studentId: pupil.studentId, state: 'FOUND', teacherId, pupil: who, notBefore })]);
    },
    [teacherId, write, mark, blockOf],
  );

  const retractFoundHere = useCallback(
    async (target: FoundTarget, studentId: string): Promise<void> => {
      if (!teacherId) return;
      const block = blockOf(target);
      // Only while the alarm is going, and not on a list the phone built.
      if (!block || block.local || block.endedAt !== null) return;
      const group = 'alarmId' in target ? { alarmId: target.alarmId } : { callId: target.call.id };
      // What the gateway holds (the list as read, with the marks it has taken written in), not what is shown with the queue on it.
      const read = responseRef.current?.alarms.find((alarm) => alarm.id === block.key);
      const held = 'alarmId' in target ? read?.foundFree : read?.calls.find((candidate) => candidate.id === target.call.id)?.foundHere;
      const onGateway = held?.some((entry) => entry.studentId === studentId) ?? false;
      // A found that never left the phone is deleted, and nothing is sent; otherwise it is taken back with a mark.
      if (!onGateway && (await cancelQueuedFound(teacherId, group, studentId))) {
        await reloadPending();
        return;
      }
      await write([newCrisisMark({ ...('alarmId' in target ? { alarmId: target.alarmId } : { call: target.call }), studentId, state: 'RETRACTED', teacherId })]);
    },
    [teacherId, write, blockOf, reloadPending],
  );

  const markAllFound = useCallback(
    async (call: MyCall): Promise<void> => {
      if (!teacherId) return;
      const shown = blocksRef.current.flatMap((block) => block.calls).find((candidate) => candidate.id === call.id) ?? call;
      const notBefore = hintRef.current?.alarmAt ?? null;
      await write(unmarkedPupils(shown).map((pupil) => newCrisisMark({ call, studentId: pupil.studentId, state: 'FOUND', teacherId, notBefore })));
    },
    [teacherId, write],
  );

  const dismissDropped = useCallback((): void => setDropped([]), []);

  const waitingCount = pending.length;
  const listAsOf = response && (fromCache || problem !== null) ? response.asOf : null;
  return {
    isLoading,
    isRefreshing,
    blocks: view.blocks,
    waiting: view.waiting,
    waitingCount,
    listAsOf,
    now,
    problem,
    hasLoaded,
    dropped,
    saveFailed,
    refresh,
    mark,
    markFoundHere,
    retractFoundHere,
    markAllFound,
    dismissDropped,
  };
}

function merged(all: readonly Dropped[], more: readonly Dropped[]): readonly Dropped[] {
  if (more.length === 0) return all;
  const byReason = new Map(all.map((d) => [d.reason, d.count]));
  for (const d of more) byReason.set(d.reason, (byReason.get(d.reason) ?? 0) + d.count);
  return [...byReason].map(([reason, count]) => ({ reason, count }));
}
