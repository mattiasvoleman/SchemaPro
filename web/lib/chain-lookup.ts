import type { MessageLookup } from "@/lib/engine-message";

/**
 * A lookup that reads the cover's own sentences first and the engine
 * catalogue second — the old picker's warnings mix STAFF_* (engine) with
 * COVER_* (gateway), and engineMessages may only hold what the engine sends.
 *
 * A module of its own for Dagsplanering, which needs this and nothing else of
 * lib/cover-view: importing it from there put the whole board's helpers on
 * that route (1.0KB gzipped, 2026-10-18). cover-view re-exports it for the
 * board and Lärarfrånvaro.
 */
export function chainLookup(first: MessageLookup, second: MessageLookup): MessageLookup {
  const lookup = ((key: string, values?: Record<string, string | number>) =>
    first.has(key) ? first(key, values) : second(key, values)) as MessageLookup;
  lookup.has = (key: string) => first.has(key) || second.has(key);
  return lookup;
}
