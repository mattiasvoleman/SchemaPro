"use client";

import { useSyncExternalStore } from "react";
import { fillPreview } from "@/lib/fill-store";
import { useLazyModule } from "@/lib/use-lazy-module";
import type { FillOnly } from "./fill-layer";

/*
 * The board's layer for a proposal of Lägg det som går (E7a), as the grid takes a layer: `behind` is called for each day's column with the scale. All
 * that is in the route's first load is this: the store's value and a hook that fetches the layer the first time a proposal is looked at, and not before
 * (nothing is fetched while the store is empty).
 *
 * Fetched with useLazyModule and not with lazy(): the grid has no boundary over it, and a lazy() at module level whose chunk did not arrive (a tab left
 * open over a deploy) holds the failed import for the tab's whole life and throws it into the render of every column, which the app answers with Next's
 * client-exception screen over the whole page (g516 M-3, the same in Gör plats' layer). Here a chunk that does not arrive draws nothing, and the dialog the
 * proposal came from says the same in words. (The grid's own layers, board-keys and possible-layer, are fetched the same way.)
 */
function FillDay({ day, scale, only }: { day: number; scale: { startMinutes: number; pxPerMinute: number }; only?: FillOnly }) {
  const shown = useSyncExternalStore(fillPreview.subscribe, fillPreview.get, () => null);
  const layer = useLazyModule(() => import("./fill-layer"), () => undefined, shown !== null);
  return shown && layer ? <layer.default day={day} scale={scale} shown={shown} only={only} /> : null;
}

/**
 * `view` and `id` are the page's view ("none" is the combined board) and the key of one board of it (a teacher's or a room's id, a class's id, or
 * "__none__" for the board of the lessons that have no teacher or no room): the board draws what is that one's, as the views draw their lessons.
 */
export const fillBehind = (day: number, scale: { startMinutes: number; pxPerMinute: number }, view?: "none" | "teacher" | "room" | "group", id?: string) => (
  <FillDay day={day} scale={scale} only={view && view !== "none" ? { by: view, id: id === undefined || id === "__none__" ? null : id } : undefined} />
);
