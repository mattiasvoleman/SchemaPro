import type { PossibleTimes } from "@/lib/possible-times";

/*
 * THE POSSIBLE TIMES OF THE LESSON IN HAND, kept where the board's two lazy pieces can both read them: the layer that paints them
 * (components/schedule/possible-layer.tsx, which asks) and the keyboard layer that says them (components/schedule/board-keys.tsx).
 * One lesson is in hand at a time, so one value: the lesson, and the answer when it has come. A store outside React because the
 * keyboard layer reads it in an event, and the painting layer follows it with useSyncExternalStore.
 */

export type PossibleState =
  | { lessonId: string; status: "loading" }
  | { lessonId: string; status: "done"; times: PossibleTimes }
  | { lessonId: string; status: "failed" };

let state: PossibleState | null = null;
const listeners = new Set<() => void>();

export const possibleStore = {
  get(): PossibleState | null {
    return state;
  },
  set(next: PossibleState | null): void {
    state = next;
    for (const listener of [...listeners]) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** What is known of this lesson's possible times: the answer when it has come, else nothing. */
export function possibleOf(lessonId: string): PossibleTimes | null {
  return state?.lessonId === lessonId && state.status === "done" ? state.times : null;
}
