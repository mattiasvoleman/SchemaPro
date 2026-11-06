"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { CRISIS_KEYS } from "@/lib/crisis-keys";
import {
  applyQueue,
  flushMarks,
  forgetLegacy,
  loadQueue,
  loadSnapshot,
  saveQueue,
  saveSnapshot,
  skewOf,
  type Dropped,
  type Snapshot,
} from "@/lib/crisis-queue";
import type { MarkResult, MyAlarm, MyCrisisResponse, OtherPupilView, QueuedMark } from "@/lib/crisis-types";
import { isOpen, markTime, newFreeMark, newMark, targetOf } from "@/lib/crisis-view";

/*
 * The teacher's reads and writes (src/crisis/crisis.controller.ts,
 * CrisisTeacherController) with the memory lib/crisis-queue.ts describes: the
 * last list, and the marks the gateway has not yet acknowledged.
 *
 * The list is read every five seconds while an alarm is open (the
 * `crisis_updated` event, lib/use-crisis-realtime.ts, is the quick way and
 * this the reserve), and every half minute otherwise. A read that fails does
 * not empty the page: react-query keeps the last answer, and the page says how
 * old it is. `networkMode: "always"` because navigator.onLine is true on a
 * phone with a bar that carries nothing: the request is tried and it fails.
 * Neither a read nor a send may hang the page: both give up after a deadline
 * and are tried again by the timer.
 *
 * WHOSE. The hook is given the id of the signed-in profile and keeps, reads
 * and sends only that login's queue and list (lib/crisis-queue.ts). The
 * react-query key carries the id as well, so a cache that outlived a
 * sign-out cannot show the next login the last one's pupils.
 */

const PATH = "/api/v1/crisis/mine";
export const OPEN_POLL_MS = 5_000;
const IDLE_POLL_MS = 30_000;
/** How soon a queue that could not be sent is tried again. */
export const RETRY_MS = 4_000;
const READ_DEADLINE_MS = 12_000;
const SEND_DEADLINE_MS = 15_000;

interface Stamped {
  data: MyCrisisResponse;
  receivedAt: number;
}

function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function send(marks: QueuedMark[]): Promise<MarkResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_DEADLINE_MS);
  // What the page keeps beside a mark (the found pupil's name, to draw the row offline) is not the gateway's to be sent.
  const wire = marks.map(({ pupil: _name, ...mark }) => mark);
  return api.post<MarkResult>(`${PATH}/marks`, { marks: wire }, controller.signal).finally(() => clearTimeout(timer));
}

/** Where a find is attached: to one of the teacher's groups (which says whose it is), or, with none, to the alarm. */
export type FindTarget = { callId: string } | { alarmId: string };

export interface MyCrisis {
  /** The list with the queue laid over it; null before there is anything to show. */
  data: MyCrisisResponse | null;
  /** The keys (lib/crisis-queue.ts pendingKey) of the pupils whose mark has not arrived. */
  pending: ReadonlySet<string>;
  loading: boolean;
  /** The gateway has not answered this time: what is shown was fetched at `asOf`. */
  offline: boolean;
  /** Not one answer in this visit: the list is the one the device kept. */
  fromCache: boolean;
  /** When the gateway made the list shown, or null if none is shown. */
  asOf: string | null;
  queued: number;
  sending: boolean;
  dropped: readonly Dropped[];
  clearDropped: () => void;
  /** FOUND or MISSING for pupils on a group's list. */
  mark: (callId: string, studentIds: readonly string[], state: "FOUND" | "MISSING") => void;
  /** A pupil who is on none of the teacher's lists, found: "found with me" on a group, or on the alarm when there is none. */
  find: (target: FindTarget, who: OtherPupilView) => void;
  /** Takes a find back. A find not yet sent is simply not sent. */
  retract: (target: FindTarget, studentId: string) => void;
  refetch: () => void;
}

export function useMyCrisis(userId: string): MyCrisis {
  const queryClient = useQueryClient();
  // Under CRISIS_KEYS.mine, so that the `crisis_updated` event (which invalidates the prefix) still reaches it.
  const queryKey = useMemo(() => [...CRISIS_KEYS.mine, userId], [userId]);
  // What the device kept is read after the first render, not during it: the
  // page is rendered on the server first, where there is no storage, and a
  // first client render that differed from it would not hydrate.
  const [kept, setKept] = useState<Snapshot | null>(null);
  const [queue, setQueue] = useState<QueuedMark[]>([]);
  const [restored, setRestored] = useState(false);
  const [dropped, setDropped] = useState<Dropped[]>([]);
  const [sending, setSending] = useState(false);
  const queueRef = useRef<QueuedMark[]>([]);
  const busy = useRef(false);
  // The ids of the marks of the batch being sent: they are out of this device's hands, and a retraction cannot unsend them.
  const inFlight = useRef<ReadonlySet<string>>(new Set());
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    // The first version kept one queue for the browser, whoever was signed in: nobody's to send.
    forgetLegacy();
    // A mark made before this ran (a tap in the first moment) goes after the old ones; but never another login's.
    const carried = loadedFor.current === null ? queueRef.current : [];
    loadedFor.current = userId;
    const next = [...loadQueue(userId), ...carried];
    queueRef.current = next;
    setQueue(next);
    setKept(loadSnapshot(userId, Date.now()));
    setRestored(true);
  }, [userId]);

  const query = useQuery<Stamped>({
    queryKey,
    networkMode: "always",
    retry: false,
    refetchInterval: (query) => (query.state.data?.data.alarms.some(isOpen) ? OPEN_POLL_MS : IDLE_POLL_MS),
    queryFn: async () => {
      const data = await deadline(api.get<MyCrisisResponse>(PATH), READ_DEADLINE_MS);
      const stamped: Stamped = { data, receivedAt: Date.now() };
      saveSnapshot(userId, stamped);
      return stamped;
    },
  });

  const source: Snapshot | null = query.data ?? kept;
  const sourceRef = useRef(source);
  sourceRef.current = source;

  const view = useMemo(() => (source ? applyQueue(source.data, queue) : null), [source, queue]);

  const setQueued = useCallback((next: QueuedMark[]) => {
    queueRef.current = next;
    setQueue(next);
    saveQueue(userId, next);
  }, [userId]);

  /** Sends what is queued, in as few calls as it takes; one at a time. */
  const flush = useCallback(async () => {
    if (busy.current || queueRef.current.length === 0) return;
    busy.current = true;
    setSending(true);
    try {
      for (;;) {
        const batch = queueRef.current;
        if (batch.length === 0) break;
        inFlight.current = new Set(batch.map((mark) => mark.id));
        const result = await flushMarks(batch, send);
        inFlight.current = new Set();
        const done = new Set([...result.sent, ...result.dropped.map((one) => one.mark)].map((mark) => mark.id));
        setQueued(queueRef.current.filter((mark) => !done.has(mark.id)));
        if (result.dropped.length > 0) setDropped((before) => [...before, ...result.dropped]);
        if (result.sent.length > 0) {
          // What the gateway took is true of the list now; the read that follows confirms it.
          const patch = (snapshot: Snapshot): Snapshot => ({ ...snapshot, data: applyQueue(snapshot.data, result.sent).data });
          const current = queryClient.getQueryData<Stamped>(queryKey);
          if (current) {
            const patched = patch(current);
            queryClient.setQueryData<Stamped>(queryKey, patched);
            saveSnapshot(userId, patched);
          }
          setKept((before) => (before ? patch(before) : before));
          void queryClient.invalidateQueries({ queryKey });
        }
        if (result.unsent.length > 0) break;
      }
    } finally {
      busy.current = false;
      setSending(false);
    }
  }, [queryClient, queryKey, setQueued, userId]);

  // The queue of an earlier visit is sent at once; then whenever the network
  // is back, the page is looked at again, and on the timer.
  useEffect(() => {
    if (!restored) return undefined;
    const go = () => void flush();
    go();
    const onVisible = () => {
      if (document.visibilityState === "visible") go();
    };
    window.addEventListener("online", go);
    window.addEventListener("focus", go);
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(go, RETRY_MS);
    return () => {
      window.removeEventListener("online", go);
      window.removeEventListener("focus", go);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, [flush, restored]);

  /** The alarm a group or an alarm id belongs to, in the list as it stands. */
  const alarmOf = (target: string): MyAlarm | undefined =>
    sourceRef.current?.data.alarms.find((one) => one.id === target || one.calls.some((call) => call.id === target));

  const mark = useCallback(
    (callId: string, studentIds: readonly string[], state: "FOUND" | "MISSING") => {
      const now = sourceRef.current;
      const alarm = alarmOf(callId);
      if (!now || !alarm || studentIds.length === 0) return;
      const at = markTime(Date.now(), skewOf(now), alarm.startedAt);
      setQueued([...queueRef.current, ...studentIds.map((studentId) => newMark(callId, studentId, state, at))]);
      void flush();
    },
    [flush, setQueued],
  );

  const find = useCallback(
    (target: FindTarget, who: OtherPupilView) => {
      const now = sourceRef.current;
      const alarm = alarmOf("callId" in target ? target.callId : target.alarmId);
      if (!now || !alarm) return;
      const at = markTime(Date.now(), skewOf(now), alarm.startedAt);
      const made = "callId" in target ? newMark(target.callId, who.studentId, "FOUND", at) : newFreeMark(target.alarmId, who.studentId, "FOUND", at);
      // The name and class go with the mark, so that the row is drawn at once and offline without a roster of the school.
      setQueued([...queueRef.current, { ...made, pupil: { firstName: who.firstName, lastName: who.lastName, className: who.className } }]);
      void flush();
    },
    [flush, setQueued],
  );

  const retract = useCallback(
    (target: FindTarget, studentId: string) => {
      const now = sourceRef.current;
      const id = "callId" in target ? target.callId : target.alarmId;
      const alarm = alarmOf(id);
      if (!now || !alarm) return;
      const mine = queueRef.current.filter((one) => targetOf(one) === id && one.studentId === studentId);
      const held = [...(alarm.calls.find((call) => call.id === id)?.foundHere ?? []), ...(alarm.id === id ? alarm.foundFree ?? [] : [])];
      // A find that only this device knows, and has not started to send: nothing was ever said, so nothing is taken back.
      if (!held.some((one) => one.studentId === studentId) && !mine.some((one) => inFlight.current.has(one.id))) {
        setQueued(queueRef.current.filter((one) => !mine.includes(one)));
        return;
      }
      const at = markTime(Date.now(), skewOf(now), alarm.startedAt);
      const made = "callId" in target ? newMark(target.callId, studentId, "RETRACTED", at) : newFreeMark(target.alarmId, studentId, "RETRACTED", at);
      setQueued([...queueRef.current, made]);
      void flush();
    },
    [flush, setQueued],
  );

  return {
    data: view?.data ?? null,
    pending: view?.pending ?? new Set<string>(),
    loading: source === null && (query.isPending || !restored),
    offline: query.isError,
    fromCache: query.data === undefined && kept !== null,
    asOf: source?.data.asOf ?? null,
    queued: queue.length,
    sending,
    dropped,
    clearDropped: () => setDropped([]),
    mark,
    find,
    retract,
    refetch: () => void query.refetch(),
  };
}
