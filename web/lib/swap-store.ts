import type { SwapProposal } from "@/lib/swaps";

/*
 * THE PROPOSAL THE BOARD SHOWS (E5a): the one the schemaläggare is looking at in the list of Gör plats or Byt plats, which the board draws as
 * outlines over the lessons it moves and the places they go to (components/schedule/swap-layer.tsx). Kept outside React because the list that
 * sets it and the board that draws it are in different parts of the tree, and kept as small as it is because the timetable's first load carries
 * it (components/schedule/swap-behind.tsx): everything that draws or asks is fetched when a proposal is first looked at.
 */
let shown: SwapProposal | null = null;
const listeners = new Set<() => void>();

export const swapPreview = {
  get: (): SwapProposal | null => shown,
  set(next: SwapProposal | null): void {
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
