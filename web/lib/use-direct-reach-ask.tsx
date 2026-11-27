"use client";

import { useCallback, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  DIRECT_REACH_KEY,
  DirectReachDeclined,
  fetchDirectReach,
  isDirectReachRefusal,
  type DirectReach,
} from "@/lib/direct-reach";
import type { DirectReachDialogProps } from "@/components/publication/direct-reach-dialog";

/*
 * THE QUESTION BEFORE A CHANGE IN DIREKT THAT REACHES FAMILIES, as a page uses it (P5, beslut 8). E4's board takes this one: it is
 * the one place the question lives, and a page that writes published lessons calls `ask` around its write and renders `question`.
 *
 *   const reach = useDirectReachAsk();
 *   …
 *   await reach.ask(() => updateLesson.mutateAsync(patch));   // asks first when the school has not answered
 *   …
 *   return <>{reach.question}…</>;
 *
 * `ask(run)` reads the school's state (cached; a failed read asks nothing, the gateway still holds the line), asks the question when the state says
 * to, and then runs the write. A school that said no (Avbryt) gets a DirectReachDeclined, which is not a failure: showError-style handlers
 * skip it (isDirectReachRefusal / DirectReachDeclined). When the write itself comes back 409 DIRECT_REACH_UNANSWERED (the page's state was
 * stale, or another tab or a script went first) the state is read again and the same question is asked, once, and the write is run again.
 * The gateway rolls such a write back whole, so running it again does nothing twice.
 *
 * The dialog is fetched the first time it is needed (import()), and drawn here as a loaded component: no Suspense, no boundary, nothing
 * of it in a page's first load.
 */

/** An answered school is not asked again for this long without a look at the gateway: the gateway's own guard covers what changes in between. */
const FRESH_MS = 5 * 60_000;

interface Asking {
  reach: DirectReach;
  Dialog: ComponentType<DirectReachDialogProps>;
  onAnswered: DirectReachDialogProps["onAnswered"];
  onDeclined: () => void;
}

export function useDirectReachAsk(): {
  ask: <T>(run: () => Promise<T>) => Promise<T>;
  /** The dialog, or nothing. Render it once, anywhere in the page. */
  question: ReactNode;
} {
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState<Asking | null>(null);
  // A second drag while the question is open waits for the same answer instead of opening a second dialog.
  const open = useRef<Promise<void> | null>(null);

  const read = useCallback(
    (staleTime: number) => queryClient.fetchQuery({ queryKey: DIRECT_REACH_KEY, queryFn: fetchDirectReach, staleTime }),
    [queryClient],
  );

  const question = useCallback(
    (reach: DirectReach): Promise<void> => {
      if (open.current) return open.current;
      const pending = import("@/components/publication/direct-reach-dialog").then(
        ({ DirectReachDialog }) =>
          new Promise<void>((resolve, reject) => {
            const close = () => {
              setAsking(null);
              open.current = null;
            };
            setAsking({
              reach,
              Dialog: DirectReachDialog,
              onAnswered: (answer) => {
                close();
                // Answered in Direkt: nothing more is asked. In utkast: the school's mode is another now, and nothing reaches anybody.
                queryClient.setQueryData<DirectReach>(DIRECT_REACH_KEY, {
                  ...reach,
                  mode: answer,
                  ask: false,
                  audience: null,
                  acknowledgedAt: new Date().toISOString(),
                });
                resolve();
              },
              onDeclined: () => {
                close();
                reject(new DirectReachDeclined());
              },
            });
          }),
      );
      open.current = pending;
      // A dialog that could not be fetched leaves the latch open for the next try.
      pending.catch(() => {
        open.current = null;
      });
      return pending;
    },
    [queryClient],
  );

  const ask = useCallback(
    async <T,>(run: () => Promise<T>): Promise<T> => {
      let reach: DirectReach | null = null;
      try {
        reach = await read(FRESH_MS);
      } catch {
        reach = null;
      }
      if (reach?.ask) await question(reach);
      try {
        return await run();
      } catch (error) {
        if (!isDirectReachRefusal(error)) throw error;
        let fresh: DirectReach | null = null;
        try {
          fresh = await read(0);
        } catch {
          fresh = null;
        }
        if (!fresh?.ask) throw error;
        await question(fresh);
        return run();
      }
    },
    [read, question],
  );

  const question_ = asking ? (
    <asking.Dialog reach={asking.reach} onAnswered={asking.onAnswered} onDeclined={asking.onDeclined} />
  ) : null;

  return { ask, question: question_ };
}
