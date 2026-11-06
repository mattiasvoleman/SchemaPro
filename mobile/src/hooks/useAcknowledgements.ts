import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { loadProblem } from '../services/coverRequests';
import { confirmAck, fetchMyAcks, isStale, type AckMine, type ConfirmOutcome } from '../services/acknowledgements';

/**
 * The guardian's messages to confirm, for the Meddelanden tab
 * (services/acknowledgements.ts is the gateway client and the wording of an
 * outcome; this holds the screen's state around it).
 *
 * READ AGAIN WHEN THE TAB IS SEEN. A tab stays mounted once opened, and a
 * push about a message opens it: the list is read whenever the tab gains
 * focus and whenever the app returns to the front while it is focused, and
 * by a pull. A message the school has just asked about is therefore there
 * when the person arrives.
 *
 * ONE REQUEST PER MESSAGE. A confirmation is single-flight per message: while
 * one is in the air its button is closed, and a second tap that gets in
 * before the render is dropped by the ref. Another message stays pressable,
 * so a request that hangs on a poor network does not lock the rest. Nothing
 * is queued (a confirmation must be made now, services/acknowledgements.ts).
 *
 * A CONFIRMATION IS REMEMBERED OVER THE LIST. The time the gateway answered is
 * laid over the row it belongs to, so a read that was already in the air when
 * the person tapped cannot bring the button back. Nothing is read again after
 * a confirmation: the gateway has just said all there is to say.
 */

export interface AcknowledgementsState {
  /** The first read is under way. */
  readonly isLoading: boolean;
  /** A pull to refresh is under way. */
  readonly isRefreshing: boolean;
  /** Newest first, each with the person's confirmation laid over it. */
  readonly items: readonly AckMine[];
  /** Whether any read has answered: a failed first read has no list to show. */
  readonly hasLoaded: boolean;
  /** Why the last read failed; the list shown, if any, is then the last one read. */
  readonly problem: 'OFFLINE' | 'FAILED' | null;
  /** The messages whose confirmation is in the air. */
  readonly pending: ReadonlySet<string>;
  /** What became of the last tap on a message that was not confirmed (no network, a failure), until the next tap or read. */
  readonly failures: Readonly<Record<string, ConfirmOutcome>>;
  /** A message that has moved on without the person (their guardianship ended, or it is gone), until the next tap or read. */
  readonly stale: ConfirmOutcome | null;
  readonly refresh: () => void;
  /** Null when the tap was dropped because the message already had one in the air. */
  readonly confirm: (id: string) => Promise<ConfirmOutcome | null>;
}

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const { [key]: _dropped, ...rest } = record;
  void _dropped;
  return rest;
}

export function useAcknowledgements(): AcknowledgementsState {
  const [rows, setRows] = useState<AckMine[]>([]);
  const [confirmedAt, setConfirmedAt] = useState<Record<string, string>>({});
  const [hasLoaded, setHasLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [problem, setProblem] = useState<'OFFLINE' | 'FAILED' | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [failures, setFailures] = useState<Record<string, ConfirmOutcome>>({});
  const [stale, setStale] = useState<ConfirmOutcome | null>(null);
  /** The newest read: an older answer arriving late never replaces it. */
  const newest = useRef(0);
  const alive = useRef(true);
  const inFlight = useRef(new Set<string>());
  const focused = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** `keepStale`: the read after a refusal keeps the sentence that explains why the list changed. */
  const load = useCallback(async (keepStale: boolean): Promise<void> => {
    const mine = ++newest.current;
    const current = (): boolean => alive.current && mine === newest.current;
    try {
      const next = await fetchMyAcks();
      if (!current()) return;
      setRows(next);
      setHasLoaded(true);
      setProblem(null);
      setFailures({});
      if (!keepStale) setStale(null);
    } catch (error) {
      const why = await loadProblem(error);
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
      focused.current = true;
      void load(false);
      return () => {
        focused.current = false;
      };
    }, [load]),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active' && focused.current) void load(false);
    });
    return () => subscription.remove();
  }, [load]);

  const refresh = useCallback((): void => {
    setIsRefreshing(true);
    void load(false);
  }, [load]);

  const confirm = useCallback(
    async (id: string): Promise<ConfirmOutcome | null> => {
      if (inFlight.current.has(id)) return null;
      inFlight.current.add(id);
      setPending(new Set(inFlight.current));
      setFailures((all) => without(all, id));
      setStale(null);
      let outcome: ConfirmOutcome;
      try {
        outcome = await confirmAck(id);
      } finally {
        inFlight.current.delete(id);
      }
      if (!alive.current) return outcome;
      setPending(new Set(inFlight.current));
      if (outcome.kind === 'CONFIRMED') {
        const at = outcome.ackedAt;
        setConfirmedAt((all) => ({ ...all, [id]: at }));
      } else if (isStale(outcome)) {
        // The message has moved on without the person: the list is read
        // again, and the sentence stays above it, because the card it was
        // about may be gone by then.
        setStale(outcome);
        void load(true);
      } else {
        setFailures((all) => ({ ...all, [id]: outcome }));
      }
      return outcome;
    },
    [load],
  );

  const items = useMemo(
    () => rows.map((row) => (row.ackedAt === null && confirmedAt[row.id] !== undefined ? { ...row, ackedAt: confirmedAt[row.id]! } : row)),
    [rows, confirmedAt],
  );

  return { isLoading, isRefreshing, items, hasLoaded, problem, pending, failures, stale, refresh, confirm };
}
