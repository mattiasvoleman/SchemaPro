"use client";

import { lazy, Suspense, useSyncExternalStore } from "react";
import { swapPreview } from "@/lib/swap-store";

/*
 * The board's layer for a proposal of Gör plats or Byt plats (E5a), as the grid takes a layer: `behind` is called for each day's column with the
 * scale (the grid draws the layer of Förlägg i veckan the same way). All that is in the route's first load is this: the store's value and a lazy
 * wrapper. The layer itself is fetched the first time a proposal is looked at, and not before (React's lazy() fetches at first render, and
 * nothing is rendered while the store is empty).
 */
const Layer = lazy(() => import("./swap-layer"));

function SwapDay({ day, scale }: { day: number; scale: { startMinutes: number; pxPerMinute: number } }) {
  const proposal = useSyncExternalStore(swapPreview.subscribe, swapPreview.get, () => null);
  return proposal ? (
    <Suspense fallback={null}>
      <Layer day={day} scale={scale} proposal={proposal} />
    </Suspense>
  ) : null;
}

export const swapBehind = (day: number, scale: { startMinutes: number; pxPerMinute: number }) => <SwapDay day={day} scale={scale} />;
