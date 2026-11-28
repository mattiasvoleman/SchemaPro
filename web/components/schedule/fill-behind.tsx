"use client";

import { lazy, Suspense, useSyncExternalStore } from "react";
import { fillPreview } from "@/lib/fill-store";

/*
 * The board's layer for a proposal of Lägg det som går (E7a), as the grid takes a layer: `behind` is called for each day's column with the scale. All
 * that is in the route's first load is this: the store's value and a lazy wrapper. The layer itself is fetched the first time a proposal is looked
 * at, and not before (React's lazy() fetches at first render, and nothing is rendered while the store is empty).
 */
const Layer = lazy(() => import("./fill-layer"));

function FillDay({ day, scale }: { day: number; scale: { startMinutes: number; pxPerMinute: number } }) {
  const shown = useSyncExternalStore(fillPreview.subscribe, fillPreview.get, () => null);
  return shown ? (
    <Suspense fallback={null}>
      <Layer day={day} scale={scale} shown={shown} />
    </Suspense>
  ) : null;
}

export const fillBehind = (day: number, scale: { startMinutes: number; pxPerMinute: number }) => <FillDay day={day} scale={scale} />;
