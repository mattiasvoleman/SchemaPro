import { useEffect, useRef, useState } from "react";
import { placementCardId } from "@/lib/placement-board";
import { linkTargetOf, markedRowOf, type PlacementLinkTarget } from "@/lib/placement-link";

/*
 * THE CARD AN ADDRESS NAMES (A3): /admin/placements?year=...&post=...&day=...&start=... marks the lesson Generera pointed at.
 *
 * Read once from the address (window.location.search after mount, never useSearchParams: it would opt the route out of static
 * rendering, as the week's other address readers say) and looked up ONCE, the first time the week is there: a card that moves
 * afterwards is the school's own doing, and "it is no longer there" would then be said about a lesson the school just moved.
 * The card is found by comparing with the week's rows (post, day, start), never by a selector built from the address; two alike
 * are one lesson twice and the first is marked.
 *
 * It marks and moves the keyboard to the card and opens nothing. The mark ends when the school opens a card. An address with a
 * `block` names a block's lesson, whose card is the block's (the week's block card marks it); there is nothing here to mark and
 * nothing to say is missing.
 *
 * THE LÄSÅR IT NAMES (review of #333, LÅG-6). An address names a läsår, or none (the active one), and the week it is read against
 * is the one on screen. When they are not the same (an address for a läsår that is neither the active nor the next, which the week
 * falls back from to the active), the posts of the address are not on this week and "it is no longer there" would be said about a
 * lesson that was never looked for: nothing is marked and nothing is said. The sentence "no longer there" belongs to the läsår
 * it was found for, and ends when the school picks another, and ends too when a row is laid on the very place (it is there again).
 */

/** How long the hook waits for the card to be drawn before it lets the keyboard be (the week's pendingFocus gives up after the same). */
const GIVE_UP_MS = 3000;

export function usePlacementLinkTarget(
  rows: readonly { id: string; requirementId: string; dayOfWeek: number; startTime: string; verdict?: { ok: boolean } }[] | undefined,
  keys: ReadonlyMap<string, string>,
  openCard: string | null,
  /** The läsår on screen and the active one (the address leaves the active one out), as the planning year says them. */
  years: { shownId: string | undefined; activeId: string | undefined },
): { markedCard: string | null; missing: boolean } {
  const [target, setTarget] = useState<PlacementLinkTarget | null>(null);
  const [found, setFound] = useState<{ card: string | null; yearId: string } | null>(null);
  const [ended, setEnded] = useState(false);
  useEffect(() => setTarget(linkTargetOf(window.location.search)), []);

  const { shownId, activeId } = years;
  // The week on screen is the address's own, once both the läsår on screen and the active one are known.
  const onTargetYear = target !== null && shownId !== undefined && activeId !== undefined && (target.yearId ?? activeId) === shownId;
  const seen = useRef(false);
  useEffect(() => {
    if (seen.current || !rows || !target || target.blockId !== null || !onTargetYear) return;
    seen.current = true;
    const row = markedRowOf(rows, target);
    setFound({ card: row ? placementCardId(keys.get(row.id) ?? row.id) : null, yearId: shownId });
  }, [rows, target, keys, onTargetYear, shownId]);

  useEffect(() => {
    if (openCard !== null) setEnded(true);
  }, [openCard]);

  // What was found belongs to the läsår it was found in: the school picking another läsår leaves it behind.
  const current = found !== null && found.yearId === shownId ? found : null;
  const card = current?.card ?? null;
  useEffect(() => {
    if (card === null || ended) return;
    const focus = (): boolean => {
      const element = document.querySelector<HTMLElement>(`[data-lesson-id="${CSS.escape(card)}"]`);
      if (!element) return false;
      element.scrollIntoView?.({ block: "center" });
      element.focus({ preventScroll: true });
      return true;
    };
    if (focus()) return;
    const poll = setInterval(() => {
      if (focus()) clearInterval(poll);
    }, 100);
    const giveUp = setTimeout(() => clearInterval(poll), GIVE_UP_MS);
    return () => {
      clearInterval(poll);
      clearTimeout(giveUp);
    };
  }, [card, ended]);

  const gone = current !== null && current.card === null && target !== null && rows !== undefined && markedRowOf(rows, target) === undefined;
  return { markedCard: ended ? null : card, missing: gone };
}
