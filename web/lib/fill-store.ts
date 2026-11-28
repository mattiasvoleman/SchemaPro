import type { FillProposal } from "@/lib/board-fill";

/*
 * THE PROPOSAL THE BOARD SHOWS (E7a): the one Lägg det som går has just answered, which the board draws as dashed outlines where each brick would stand
 * (components/schedule/fill-layer.tsx). Kept outside React because the dialog that sets it and the board that draws it are in different parts of the tree,
 * and kept as small as it is because the timetable's first load carries it (components/schedule/fill-behind.tsx): everything that draws or asks is
 * fetched when a proposal is first looked at. A store of its own, and not E5a's (swap-store.ts): the two proposals are not one thing.
 */
/** The proposal and what each brick is called on the board ("Matematik 7A"), which the dialog has from the lists the page reads. */
export interface FillShown {
  proposal: FillProposal;
  labels: ReadonlyMap<string, string>;
}

let shown: FillShown | null = null;
const listeners = new Set<() => void>();

export const fillPreview = {
  get: (): FillShown | null => shown,
  set(next: FillShown | null): void {
    shown = next;
    for (const listener of [...listeners]) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
