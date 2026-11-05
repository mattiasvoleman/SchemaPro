import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  answerCoverRequest,
  confirmCoverPass,
  fetchMyCover,
  keepsButtons,
  loadProblem,
  type AnswerOutcome,
  type ConfirmOutcome,
  type MyCover,
} from '../services/coverRequests';

/**
 * The colleague's cover requests and passes for the Vikarie tab
 * (services/coverRequests.ts is the gateway client and the wording of an
 * answer; this holds the screen's state around it).
 *
 * READ AGAIN WHEN THE TAB IS SEEN. A tab stays mounted once opened, and a
 * question is time-boxed and first-come: the list is read whenever the tab
 * gains focus (a push that opens it too) and whenever the app returns to the
 * front while it is focused, and by a pull. The gateway arbitrates in the
 * end, so a stale card that is answered gets the right refusal; this only
 * keeps the common case from being stale.
 *
 * ONE ANSWER AT A TIME. A yes, a no and a confirmation are single-flight:
 * while one is in the air every button is disabled, and a second tap that
 * gets in before the render is dropped by the ref. Nothing is queued (a yes
 * must be live, services/coverRequests.ts).
 */

export type Pending =
  | { readonly kind: 'ANSWER'; readonly id: string; readonly answer: 'YES' | 'NO' }
  | { readonly kind: 'CONFIRM'; readonly id: string };

export interface CoverRequestsState {
  /** The first read is under way. */
  readonly isLoading: boolean;
  /** A pull to refresh is under way. */
  readonly isRefreshing: boolean;
  readonly cover: MyCover;
  /** Whether any read has answered: a failed first read has no list to show. */
  readonly hasLoaded: boolean;
  /** Why the last read failed; the list shown, if any, is then the last one read. */
  readonly problem: 'OFFLINE' | 'FAILED' | null;
  readonly pending: Pending | null;
  /** The last result of an answer, by request id, until the next pull or visit. */
  readonly answers: Readonly<Record<string, AnswerOutcome>>;
  /** The last result of a confirmation, by lesson id. */
  readonly confirmations: Readonly<Record<string, ConfirmOutcome>>;
  readonly refresh: () => void;
  readonly answer: (requestId: string, answer: 'YES' | 'NO') => Promise<void>;
  readonly confirm: (lessonId: string) => Promise<void>;
}

const EMPTY: MyCover = { requests: [], passes: [] };

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const { [key]: _dropped, ...rest } = record;
  void _dropped;
  return rest;
}

export function useCoverRequests(enabled: boolean): CoverRequestsState {
  const [cover, setCover] = useState<MyCover>(EMPTY);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(enabled);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [problem, setProblem] = useState<'OFFLINE' | 'FAILED' | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [answers, setAnswers] = useState<Record<string, AnswerOutcome>>({});
  const [confirmations, setConfirmations] = useState<Record<string, ConfirmOutcome>>({});
  /** The newest read: an older answer arriving late never replaces it. */
  const newest = useRef(0);
  const alive = useRef(true);
  const busy = useRef(false);
  const focused = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** `keepResults`: the read after an answer keeps the answer's own confirmation on its card. */
  const load = useCallback(async (keepResults: boolean): Promise<void> => {
    const mine = ++newest.current;
    const current = (): boolean => alive.current && mine === newest.current;
    try {
      const next = await fetchMyCover();
      if (!current()) return;
      setCover(next);
      setHasLoaded(true);
      setProblem(null);
      if (!keepResults) {
        setAnswers({});
        setConfirmations({});
      }
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
      if (enabled) void load(false);
      return () => {
        focused.current = false;
      };
    }, [enabled, load]),
  );

  useEffect(() => {
    if (!enabled) return;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active' && focused.current) void load(false);
    });
    return () => subscription.remove();
  }, [enabled, load]);

  const refresh = useCallback((): void => {
    setIsRefreshing(true);
    void load(false);
  }, [load]);

  const answer = useCallback(
    async (requestId: string, choice: 'YES' | 'NO'): Promise<void> => {
      if (busy.current) return;
      busy.current = true;
      setPending({ kind: 'ANSWER', id: requestId, answer: choice });
      setAnswers((all) => without(all, requestId));
      let outcome: AnswerOutcome;
      try {
        outcome = await answerCoverRequest(requestId, choice);
      } finally {
        busy.current = false;
      }
      if (!alive.current) return;
      setPending(null);
      setAnswers((all) => ({ ...all, [requestId]: outcome }));
      // The question has changed whatever the answer was, unless nothing
      // happened (no connection, a failure) or a rule refused the yes and
      // left the question open for the others: then there is nothing new.
      if (!keepsButtons(outcome)) await load(true);
    },
    [load],
  );

  const confirm = useCallback(
    async (lessonId: string): Promise<void> => {
      if (busy.current) return;
      busy.current = true;
      setPending({ kind: 'CONFIRM', id: lessonId });
      setConfirmations((all) => without(all, lessonId));
      let outcome: ConfirmOutcome;
      try {
        outcome = await confirmCoverPass(lessonId);
      } finally {
        busy.current = false;
      }
      if (!alive.current) return;
      setPending(null);
      setConfirmations((all) => ({ ...all, [lessonId]: outcome }));
      if (outcome.kind === 'CONFIRMED' || outcome.kind === 'STALE') await load(true);
    },
    [load],
  );

  return { isLoading, isRefreshing, cover, hasLoaded, problem, pending, answers, confirmations, refresh, answer, confirm };
}
