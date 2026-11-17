import type { TimetableBand, TimetableLesson } from "@/components/schedule/timetable-grid";
import type { MessageLookup } from "@/lib/engine-message";
import type { BoardFilters, BoardHold } from "@/lib/placement-board";
import type { PlacementWarning } from "@/lib/requirement-placements";

/*
 * VARNINGAR MEDAN MAN LÄGGER (D1), the web's side: what the week the school has fixed says about a förläggning without refusing it
 * (the gateway's placement-warnings.ts), and the other schools' hold on a teacher or a room that is picked, as bands.
 *
 * PURE, and with no value import: the timplan's dialog fetches this module on its first press, and the week's page holds it in its first
 * paint (a card's mark, a post's lines), so neither may pull another module in. The page's own file for the rest is
 * use-placement-warnings.ts.
 *
 * A WARNING BELONGS TO A ROW OF THE ANSWER IT CAME IN. Every save gives the rows new ids, so nothing here keeps a row id across a
 * write: the page joins a warning to a card (through the row's key) in the answer's own rows, and patchBoard replaces a post's warnings
 * with the PUT's. A warning that names no row of the board is not drawn, and says nothing.
 *
 * ONE SENTENCE, ONCE. The teacher's day and the class's lunch are said on every row of a breach; a post says each of them once, however
 * many of its rows they are on (warningKeyOf: what it says, not where). A warning that refuses on one row and not on another says the
 * stronger.
 */

/** A warning as a reader gets it: what it says, and whether Generera will refuse the week because of it. */
export interface WarningItem {
  key: string;
  text: string;
  refuses: boolean;
}

/** What a warning says, with nothing of where it stands: the key two warnings are one by. */
export const warningKeyOf = (warning: Pick<PlacementWarning, "code" | "params">): string =>
  `${warning.code}|${Object.entries(warning.params ?? {})
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join("|")}`;

/**
 * The sentence for a warning, in the reader's language. `t` is the placementWeek.warnings translator. A code this build has no sentence
 * for (the gateway is deployed apart from the web), or a value the sentence needs that the gateway left out (next-intl throws on a hole),
 * reads as the general sentence rather than as nothing. The weekday comes in as a number (ISO 1..5) and is said by the catalogue.
 */
export function sentenceOfWarning(t: MessageLookup, warning: Pick<PlacementWarning, "code" | "params">): string {
  const params = { ...warning.params };
  if (params["day"] !== undefined) params["day"] = t("day", { day: params["day"] });
  if (t.has(warning.code)) {
    try {
      return t(warning.code, params);
    } catch {
      // Falls through to the general sentence.
    }
  }
  return t("UNKNOWN");
}

/** The warnings of some rows as lines: one per sentence, in the order the rows have them, and the stronger level where two meet. */
export function itemsOfWarnings(warnings: readonly PlacementWarning[] | undefined, sentence: (warning: PlacementWarning) => string): WarningItem[] {
  const items = new Map<string, WarningItem>();
  for (const warning of warnings ?? []) {
    const key = warningKeyOf(warning);
    const held = items.get(key);
    if (held) held.refuses = held.refuses || warning.refuses;
    else items.set(key, { key, text: sentence(warning), refuses: warning.refuses });
  }
  return [...items.values()];
}

/** Row id → its warnings. */
export function warningsByRow(warnings: readonly PlacementWarning[] | undefined): Map<string, PlacementWarning[]> {
  const byRow = new Map<string, PlacementWarning[]>();
  for (const warning of warnings ?? []) {
    const list = byRow.get(warning.rowId);
    if (list) list.push(warning);
    else byRow.set(warning.rowId, [warning]);
  }
  return byRow;
}

/** The warnings on any of these rows (a post's, or a block's, as the list draws them). */
export const warningsOfRows = (byRow: ReadonlyMap<string, readonly PlacementWarning[]>, rowIds: readonly string[]): PlacementWarning[] =>
  rowIds.flatMap((id) => byRow.get(id) ?? []);

/** The warnings as one text: each sentence, and after one that refuses what that means. `refuses` is the sentence for it. */
export const sentencesOf = (items: readonly WarningItem[], refuses: string): string =>
  items.map((item) => (item.refuses ? `${item.text} ${refuses}` : item.text)).join(" ");

/** What a card says of its warnings: the mark on it, and the words a screen reader and the hover hear. */
export interface CardMarkText {
  badge: string;
  badgeRefuses: string;
  label: (items: readonly WarningItem[]) => string;
}

/**
 * The cards with a mark on those that have a warning: the grid's own badge (`share`, spelled out by `shareLabel` for the reader who
 * cannot see it), which sits in the card's header where a narrow card still draws it, and is part of the card's accessible name. The grid is
 * not touched. A card that refuses has the stronger word.
 */
export function markCards(cards: TimetableLesson[], byCard: ReadonlyMap<string, readonly WarningItem[]>, text: CardMarkText): TimetableLesson[] {
  if (byCard.size === 0) return cards;
  return cards.map((card) => {
    const items = byCard.get(card.id);
    if (items === undefined || items.length === 0) return card;
    return { ...card, share: items.some((item) => item.refuses) ? text.badgeRefuses : text.badge, shareLabel: text.label(items) };
  });
}

/** A förläggning's day is 08:00 to 18:00 (placement-fit.ts): a band outside it says nothing about where a lesson can be laid, and would stretch the grid. */
const FROM = 8 * 60;
const TO = 18 * 60;
const minutesOf = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/**
 * The other schools' hold on a teacher or a room that is PICKED, as bands behind the cards (as the meals are). Nothing is drawn for a
 * resource no filter points at: a school's week is full of them. Two holds at one time are one band that names every school. The page
 * only shows them: the gateway already refuses a row on top of one (OTHER_SCHOOL), and the mirror is not told.
 *
 * THE BAND SAYS WHAT KIND OF HOLD IT IS (review of #339, LÅG-3), for a room that is lent or borrowed is not "booked": ROOM_BORROWED is a
 * room of another school that this school may use only in the times of an approved loan, so the band covers every hour OUTSIDE them
 * and "booked at the owner" is wrong over most of the week. `label` is asked with the kind the band's holds have in common, and with none
 * when two kinds are at one time (the generic sentence).
 */
export function heldBands(
  holds: readonly BoardHold[] | undefined,
  filters: Pick<BoardFilters, "teachers" | "rooms">,
  label: (schools: readonly string[], kind: BoardHold["kind"] | undefined) => string,
): TimetableBand[] {
  const bands = new Map<string, { dayOfWeek: number; start: number; end: number; schools: Set<string>; kind: BoardHold["kind"] | undefined }>();
  for (const hold of holds ?? []) {
    if (!(hold.resourceKind === "TEACHER" ? filters.teachers : filters.rooms).includes(hold.resourceId)) continue;
    const start = Math.max(minutesOf(hold.startTime), FROM);
    const end = Math.min(minutesOf(hold.endTime), TO);
    if (end <= start) continue;
    const key = `${hold.dayOfWeek}|${start}|${end}`;
    const band = bands.get(key) ?? { dayOfWeek: hold.dayOfWeek, start, end, schools: new Set<string>(), kind: hold.kind };
    if (band.kind !== hold.kind) band.kind = undefined;
    for (const school of hold.schools) band.schools.add(school);
    bands.set(key, band);
  }
  return [...bands].map(([key, band]) => ({
    id: `hold:${key}`,
    dayOfWeek: band.dayOfWeek,
    startMinutes: band.start,
    endMinutes: band.end,
    label: label([...band.schools].sort((a, b) => a.localeCompare(b, "sv")), band.kind),
  }));
}
