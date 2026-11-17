"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { TimetableLesson } from "@/components/schedule/timetable-grid";
import { blockCardId } from "@/lib/placement-block-rows";
import { placementCardId, type BoardFilters, type PlacementBoard } from "@/lib/placement-board";
import {
  heldBands,
  itemsOfWarnings,
  markCards,
  sentenceOfWarning,
  sentencesOf,
  warningsByRow,
  warningsOfRows,
  type WarningItem,
} from "@/lib/placement-warnings";
import type { PlacementWarning } from "@/lib/requirement-placements";

/*
 * Förlägg i veckan, the warnings (D1): what the page needs to draw them and to say them, from the week it already reads. The rules are
 * lib/placement-warnings.ts's; this reads the translator and the board and hands the page a few functions, so that the page itself holds
 * a hunk or two and no logic (D2 and the teaches work change the same file).
 *
 * A WARNING IS JOINED TO A CARD THROUGH THE ROW'S KEY. The gateway names a warning's row by its id in the same answer; every save gives
 * the rows new ids, so the id is looked up in the week as it is NOW (`keys`, `blockKeys`: row id → the key the card is named by) and no id
 * is kept: the card is `placement:<key>` or `blockplacement:<key>` as it always was.
 */

export interface PlacementWarningsOptions {
  board: PlacementBoard | undefined;
  filters: BoardFilters;
  /** A post's row id → its card's key, and a block's lesson's: placement-rows.ts keyByRowId, placement-block-rows.ts blockKeyByRowId. */
  keys: ReadonlyMap<string, string>;
  blockKeys: ReadonlyMap<string, string>;
  /** A write is on its way: what was said of the last one is no longer true, and goes. */
  saving: boolean;
}

export function usePlacementWarnings({ board, filters, keys, blockKeys, saving }: PlacementWarningsOptions) {
  const t = useTranslations("placementWeek.warnings");
  const locale = useLocale();
  const sentence = useCallback((warning: PlacementWarning) => sentenceOfWarning(t, warning), [t]);

  const byRow = useMemo(() => warningsByRow(board?.warnings), [board?.warnings]);
  const byCard = useMemo(() => {
    const ofCard = new Map<string, PlacementWarning[]>();
    for (const warning of board?.warnings ?? []) {
      const block = warning.blockId !== undefined;
      const key = (block ? blockKeys : keys).get(warning.rowId);
      if (key === undefined) continue;
      const card = (block ? blockCardId : placementCardId)(key);
      ofCard.set(card, [...(ofCard.get(card) ?? []), warning]);
    }
    return new Map([...ofCard].map(([card, warnings]) => [card, itemsOfWarnings(warnings, sentence)]));
  }, [board?.warnings, keys, blockKeys, sentence]);

  const mark = useCallback(
    (cards: TimetableLesson[]): TimetableLesson[] =>
      markCards(cards, byCard, {
        badge: t("badge"),
        badgeRefuses: t("badgeRefuses"),
        label: (items) => t("said", { count: items.length, sentences: sentencesOf(items, t("refuses")) }),
      }),
    [byCard, t],
  );

  const held = useMemo(
    () =>
      heldBands(board?.holds, filters, (schools) =>
        t("hold", { schools: new Intl.ListFormat(locale === "en" ? "en-GB" : "sv-SE", { type: "conjunction" }).format(schools) }),
      ),
    [board?.holds, filters, locale, t],
  );

  /** What was said after the last save, for the polite region that says everything else the page says after one. */
  const [said, setSaid] = useState("");
  const latest = useRef(0);
  useEffect(() => {
    if (!saving) return;
    latest.current += 1;
    setSaid("");
  }, [saving]);
  const say = useCallback(
    (warnings: readonly PlacementWarning[] | undefined) => {
      latest.current += 1;
      const items = itemsOfWarnings(warnings, sentence);
      setSaid(items.length === 0 ? "" : t("said", { count: items.length, sentences: sentencesOf(items, t("refuses")) }));
    },
    [sentence, t],
  );
  /** A block's write answers no warnings: they are the week's, read again once the write's own read is in. */
  const sayBlock = useCallback(
    async (blockId: string, read: () => Promise<{ data?: PlacementBoard }>) => {
      const mine = (latest.current += 1);
      const { data } = await read();
      if (mine === latest.current) say((data?.warnings ?? []).filter((warning) => warning.blockId === blockId));
    },
    [say],
  );

  return {
    mark,
    heldBands: held,
    /** The one line the legend adds, or null when the week has no warning. */
    legend: byCard.size > 0 ? t("legend") : null,
    said,
    say,
    sayBlock,
    /** The warnings on these rows of the week (a post's, or a block's), each sentence once. */
    ofRows: (rowIds: readonly string[]): WarningItem[] => itemsOfWarnings(warningsOfRows(byRow, rowIds), sentence),
    /** The warnings on one card. */
    ofCard: (card: string): WarningItem[] => byCard.get(card) ?? [],
  };
}
