"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/*
 * Massval: which rows of an administrator's list are ticked (klasser och
 * undervisningsgrupper, elever).
 *
 * "ALL" IS WHAT IS SHOWN. These lists have no pages: every row is read and
 * the search and the tabs filter in the browser, so the rows a search and a
 * tab match are exactly the rows on screen. "Markera alla" ticks those, and
 * says how many.
 *
 * THE SELECTION FOLLOWS THE VIEW. A changed search or tab lets go of the rows
 * it no longer shows, and a row that is gone (deleted, by this page or by
 * somebody else) is let go of too: what Redigera and Ta bort act on is always
 * on screen and counted in the bar. A selection that could hold hidden rows
 * would ask the reader to remember them; the confirmation would be the first
 * place they reappeared.
 */

/** The header box: nothing, some or every shown row ticked. */
export type HeaderState = "none" | "some" | "all";

/** The ids of `shown` that are ticked, in list order. */
export function tickedOf(selected: ReadonlySet<string>, shown: readonly string[]): string[] {
  return shown.filter((id) => selected.has(id));
}

export function headerStateOf(selected: ReadonlySet<string>, shown: readonly string[]): HeaderState {
  const ticked = tickedOf(selected, shown).length;
  if (ticked === 0) return "none";
  return ticked === shown.length ? "all" : "some";
}

/**
 * The selection kept to the rows still shown; null when it already is, so a
 * caller can keep the same set (and skip a render).
 */
export function keepShown(selected: ReadonlySet<string>, shown: readonly string[]): Set<string> | null {
  const kept = new Set(tickedOf(selected, shown));
  return kept.size === selected.size ? null : kept;
}

/** The rows from `from` to `to` in list order, both included; just `to` when `from` is not shown. */
export function rangeOf(shown: readonly string[], from: string | null, to: string): string[] {
  const end = shown.indexOf(to);
  const start = from === null ? -1 : shown.indexOf(from);
  if (start === -1 || end === -1) return [to];
  return shown.slice(Math.min(start, end), Math.max(start, end) + 1);
}

export interface BulkSelection {
  /** The ticked rows, in list order: what the bar counts and the actions take. */
  ticked: string[];
  header: HeaderState;
  isTicked: (id: string) => boolean;
  /**
   * Ticks or unticks a row; `extend` (shift-click) does the same to every row
   * between it and the row clicked before.
   */
  toggle: (id: string, extend?: boolean) => void;
  /** Ticks every shown row, or unticks them all when every one is ticked. */
  toggleAll: () => void;
  clear: () => void;
}

/** The selection over `shown`, the rows on screen in their order. */
export function useBulkSelection(shown: readonly string[]): BulkSelection {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const shownKey = shown.join(",");

  // Let go of what is no longer shown, so clearing a search does not bring
  // back rows ticked before it and hidden since.
  useEffect(() => {
    setSelected((current) => keepShown(current, shown) ?? current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey]);

  const ticked = useMemo(() => tickedOf(selected, shown), [selected, shown]);

  const toggle = useCallback(
    (id: string, extend = false) => {
      // Read now: React runs the updater later, after the anchor has moved to `id`.
      const from = anchor.current;
      setSelected((current) => {
        const tick = !current.has(id);
        const next = new Set(current);
        for (const row of extend ? rangeOf(shown, from, id) : [id]) {
          if (tick) next.add(row);
          else next.delete(row);
        }
        return next;
      });
      anchor.current = id;
    },
    [shown],
  );

  const toggleAll = useCallback(() => {
    setSelected((current) => (headerStateOf(current, shown) === "all" ? new Set() : new Set(shown)));
    anchor.current = null;
  }, [shown]);

  const clear = useCallback(() => {
    setSelected(new Set());
    anchor.current = null;
  }, []);

  return {
    ticked,
    header: headerStateOf(selected, shown),
    isTicked: (id: string) => selected.has(id),
    toggle,
    toggleAll,
    clear,
  };
}
