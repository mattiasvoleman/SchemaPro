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
 */

/** How long the hook waits for the card to be drawn before it lets the keyboard be (the week's pendingFocus gives up after the same). */
const GIVE_UP_MS = 3000;

export function usePlacementLinkTarget(
  rows: readonly { id: string; requirementId: string; dayOfWeek: number; startTime: string; verdict?: { ok: boolean } }[] | undefined,
  keys: ReadonlyMap<string, string>,
  openCard: string | null,
): { markedCard: string | null; missing: boolean } {
  const [target, setTarget] = useState<PlacementLinkTarget | null>(null);
  const [found, setFound] = useState<{ card: string | null } | null>(null);
  const [ended, setEnded] = useState(false);
  useEffect(() => setTarget(linkTargetOf(window.location.search)), []);

  const seen = useRef(false);
  useEffect(() => {
    if (seen.current || !rows || !target || target.blockId !== null) return;
    seen.current = true;
    const row = markedRowOf(rows, target);
    setFound({ card: row ? placementCardId(keys.get(row.id) ?? row.id) : null });
  }, [rows, target, keys]);

  useEffect(() => {
    if (openCard !== null) setEnded(true);
  }, [openCard]);

  const card = found?.card ?? null;
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

  return { markedCard: ended ? null : card, missing: found !== null && found.card === null };
}
