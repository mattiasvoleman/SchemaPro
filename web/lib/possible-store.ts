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

/*
 * What the lesson that was let go had been told, for a moment longer. The board forgets a lesson's answer when the lesson is let go (the layer
 * empties the store as it goes), but the dialog of other times that a refused drop opens reads the answer a microtask after the drop, when React has
 * unmounted the layer: without this it found none and asked the gateway again, on every refused drop, and waited for it.
 */
let released: { lessonId: string; times: PossibleTimes; at: number } | null = null;

/** How long an answer of a lesson let go is still read by the dialog of other times. */
export const RELEASED_FOR_MS = 5000;

export const possibleStore = {
  get(): PossibleState | null {
    return state;
  },
  set(next: PossibleState | null): void {
    state = next;
    for (const listener of [...listeners]) listener();
  },
  /** The lesson is let go: the store is emptied, and its answer is kept a moment for the dialog of other times (releasedOf). */
  release(): void {
    released = state?.status === "done" ? { lessonId: state.lessonId, times: state.times, at: Date.now() } : null;
    possibleStore.set(null);
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/**
 * What the list of possible times (possible-layer.tsx) asks the keyboard layer (board-keys.tsx) to do with the lesson in hand: a pointer, a
 * touch or a screen reader that cannot move a marker lays a numbered time, moves the marker to a typed clock, or lays where it stands. The
 * layer sets them while it is up and takes them away when it goes; the list reads them when a button is pressed.
 */
export interface BoardCommands {
  /** Lays the lesson at the numbered time (1 to 9), in the room the gateway named for it. */
  lay(rank: number): void;
  /** Moves the marker to a clock of the marker's own day, and says what the gateway says of it. */
  goTo(minutes: number): void;
  /** Lays the lesson where the marker stands. */
  layAtMarker(): void;
}

export const boardCommands: { current: BoardCommands | null } = { current: null };

/** What is known of this lesson's possible times: the answer when it has come, else nothing. */
export function possibleOf(lessonId: string): PossibleTimes | null {
  return state?.lessonId === lessonId && state.status === "done" ? state.times : null;
}

/** The answer of the lesson that was let go a moment ago (RELEASED_FOR_MS), for the dialog a refused drop opens; null for any other lesson, and later. */
export function releasedOf(lessonId: string): PossibleTimes | null {
  return released !== null && released.lessonId === lessonId && Date.now() - released.at <= RELEASED_FOR_MS ? released.times : null;
}
