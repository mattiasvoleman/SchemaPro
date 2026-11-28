"use client";

import { useSyncExternalStore } from "react";
import { useLazyModule } from "@/lib/use-lazy-module";
import { swapPreview } from "@/lib/swap-store";

/*
 * The board's layer for a proposal of Gör plats or Byt plats (E5a), as the grid takes a layer: `behind` is called for each day's column with the
 * scale (the grid draws the layer of Förlägg i veckan the same way). All that is in the route's first load is this: the store's value and a hook that
 * fetches the layer the first time a proposal is looked at, and not before (nothing is fetched while the store is empty).
 *
 * Fetched with useLazyModule and not with lazy(): the grid has no boundary over it, and a lazy() whose chunk did not arrive (a tab left open over a
 * deploy) throws it into the render, which the app answers with Next's client-exception screen over the whole page. Here a chunk that does not
 * arrive draws nothing, and the list the proposal came from says the same in words. (The grid's own layers, board-keys and possible-layer, are fetched
 * the same way.)
 */
function SwapDay({ day, scale }: { day: number; scale: { startMinutes: number; pxPerMinute: number } }) {
  const proposal = useSyncExternalStore(swapPreview.subscribe, swapPreview.get, () => null);
  const layer = useLazyModule(() => import("./swap-layer"), () => undefined, proposal !== null);
  return proposal && layer ? <layer.default day={day} scale={scale} proposal={proposal} /> : null;
}

export const swapBehind = (day: number, scale: { startMinutes: number; pxPerMinute: number }) => <SwapDay day={day} scale={scale} />;
