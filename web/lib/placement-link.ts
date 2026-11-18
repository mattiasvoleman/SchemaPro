/*
 * THE ADDRESS BACK TO THE WEEK OF FÖRLÄGGNINGAR (grafisk förläggning, A3).
 *
 *   /admin/placements?year=<läsårets id>&post=<postens id>&day=<1..5>&start=<HH:MM>
 *   ... and, for a lesson of a parallel block, &block=<blockets id> (`post` is then the member).
 *
 * Built by Generera (a refusal that names a förläggning, and the row that says how many lie fixed) and by the grundschema's
 * empty state; read by the week (use-placement-link-target.ts) and, for `block`, by the block's own card.
 * `year` is written the way the grundschema's own link writes it: only when the läsår is not the active one.
 *
 * A card is named by the lesson and not by a row (placement-rows.ts: every save gives the rows new ids), and an address cannot
 * carry the teacher, the length or the weeks, so the card is found among the week's rows by post, day and start. A value that is
 * not a whole weekday of the school week or a clock time is no mark at all, and nothing here builds a selector from the address.
 *
 * Small on purpose: it is in the chunk of every page that links to the week.
 */

const PATH = "/admin/placements";
const WEEKDAY = /^[1-5]$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface PlacementLinkTarget {
  /** The läsår the address names, or null when it names none (the grundschema's link leaves out the active one). */
  yearId: string | null;
  postId: string;
  blockId: string | null;
  /** ISO weekday, Monday to Friday. */
  day: number;
  /** HH:MM. */
  start: string;
}

export interface PlacementLinkInput {
  /** The läsår, when it is not the active one; null leaves `year` out. */
  yearId?: string | null;
  postId?: string | null;
  blockId?: string | null;
  day?: number | string | null;
  start?: string | null;
}

const weekday = (value: number | string | null | undefined): string | null => {
  const text = value === null || value === undefined ? "" : String(value);
  return WEEKDAY.test(text) ? text : null;
};

/** The address, relative to the locale. Without a post it is the week of the year; without a valid day and start it names the post only. */
export function placementLinkOf({ yearId, postId, blockId, day, start }: PlacementLinkInput): string {
  const query = new URLSearchParams();
  if (yearId) query.set("year", yearId);
  if (postId) {
    query.set("post", postId);
    const dayText = weekday(day);
    if (dayText !== null && start && CLOCK.test(start)) {
      query.set("day", dayText);
      query.set("start", start);
      if (blockId) query.set("block", blockId);
    }
  }
  const text = query.toString();
  return text === "" ? PATH : `${PATH}?${text}`;
}

/** What the address names, or null when it names no card (no post, or a day or a start that is not a place on the week). */
export function linkTargetOf(search: string): PlacementLinkTarget | null {
  const query = new URLSearchParams(search);
  const postId = query.get("post");
  const day = query.get("day");
  const start = query.get("start");
  if (!postId || day === null || start === null || !WEEKDAY.test(day) || !CLOCK.test(start)) return null;
  return { yearId: query.get("year") || null, postId, blockId: query.get("block") || null, day: Number(day), start };
}

/**
 * The row an address names: on the post, the day and the start. Two alike are one lesson twice, or the two halves of a pair (odd and
 * even weeks at one time), which the address cannot tell apart: the one the judge says no to is the one a refusal is about, else the first.
 */
export function markedRowOf<R extends { requirementId: string; dayOfWeek: number; startTime: string; verdict?: { ok: boolean } }>(
  rows: readonly R[],
  target: PlacementLinkTarget,
): R | undefined {
  const named = rows.filter((row) => row.requirementId === target.postId && row.dayOfWeek === target.day && row.startTime.slice(0, 5) === target.start);
  return named.find((row) => row.verdict?.ok === false) ?? named[0];
}

/**
 * The address a refusal on Generera gives for the förläggning it names, from the ids the gateway puts in its params (postId, and
 * blockId for a block's lesson) beside the day and the clock it always had. Null when the refusal carries no post: a line stored
 * before the ids, or a line the engine made for the week and not for a förläggning, has no card to point at. The caller says which
 * refusals are about a förläggning (a conflict of the category PLACEMENT, or a job that failed with one of the engine's five
 * refusals of a pinned lesson); nothing else is given the ids by the gateway.
 */
export function placementLinkOfRefusal(params: Record<string, string | number> | null | undefined, yearId: string | null): string | null {
  if (!params || typeof params.postId !== "string" || params.postId === "") return null;
  return placementLinkOf({
    yearId,
    postId: params.postId,
    blockId: typeof params.blockId === "string" ? params.blockId : null,
    day: params.day,
    start: typeof params.start === "string" ? params.start : null,
  });
}
