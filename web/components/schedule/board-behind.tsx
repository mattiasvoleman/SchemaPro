"use client";

import { Fragment, type ReactNode } from "react";
import { swapBehind } from "./swap-behind";

/*
 * THE BOARD'S ONE `behind` SLOT, FOR MORE THAN ONE LAYER. The grid takes a single function (`behind(day, scale)`), and every proposal the board
 * can draw (Byt and Gör plats now, Lägg det som går next, each with a store of its own) is a layer: a function of the same shape that draws nothing
 * until its store holds something. This puts them in the one the page hands the grid, each in its own keyed fragment, in the order given (the last
 * is drawn over the others). A new layer is one more argument below, and the page does not change: the page's line is the register's, and
 * /admin/timetable is at its budget.
 */
export type BehindScale = { startMinutes: number; pxPerMinute: number };
export type BehindLayer = (day: number, scale: BehindScale) => ReactNode;

export const behindOf =
  (...layers: BehindLayer[]): BehindLayer =>
  (day, scale) =>
    layers.map((layer, index) => <Fragment key={index}>{layer(day, scale)}</Fragment>);

/** The layers of the grundschema's board. Lägg det som går (E7a) adds its own here: `behindOf(swapBehind, fillBehind)`. */
export const boardBehind = behindOf(swapBehind);
