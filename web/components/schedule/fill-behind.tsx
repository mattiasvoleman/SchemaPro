"use client";

import { lazy, Suspense, useSyncExternalStore } from "react";
import { fillPreview } from "@/lib/fill-store";
import type { FillOnly } from "./fill-layer";

/*
 * The board's layer for a proposal of Lägg det som går (E7a), as the grid takes a layer: `behind` is called for each day's column with the scale. All
 * that is in the route's first load is this: the store's value and a lazy wrapper. The layer itself is fetched the first time a proposal is looked
 * at, and not before (React's lazy() fetches at first render, and nothing is rendered while the store is empty).
 */
const Layer = lazy(() => import("./fill-layer"));

function FillDay({ day, scale, only }: { day: number; scale: { startMinutes: number; pxPerMinute: number }; only?: FillOnly }) {
  const shown = useSyncExternalStore(fillPreview.subscribe, fillPreview.get, () => null);
  return shown ? (
    <Suspense fallback={null}>
      <Layer day={day} scale={scale} shown={shown} only={only} />
    </Suspense>
  ) : null;
}

/**
 * `view` and `id` are the page's view ("none" is the combined board) and the key of one board of it (a teacher's or a room's id, a class's id, or
 * "__none__" for the board of the lessons that have no teacher or no room): the board draws what is that one's, as the views draw their lessons.
 */
export const fillBehind = (day: number, scale: { startMinutes: number; pxPerMinute: number }, view?: "none" | "teacher" | "room" | "group", id?: string) => (
  <FillDay day={day} scale={scale} only={view && view !== "none" ? { by: view, id: id === undefined || id === "__none__" ? null : id } : undefined} />
);
