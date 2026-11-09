import type { MessageLookup } from "@/lib/engine-message";
import { placementsRefusal } from "@/lib/requirement-placements";

/*
 * The sentences of Förlägg, apart from requirement-placements.ts: the timplan
 * page imports that module for its mark and its read, and these are only
 * needed once the dialog is open (components/timplan/placement-dialog.tsx,
 * fetched on the first press). Kept out of the page's chunk for the 190 KB
 * budget the route has.
 *
 * Every sentence is written from codes and values the gateway sends, never from
 * its own Swedish, and none of them names a person: the other lesson that
 * stands in the way is a class and a subject, and the teacher is "läraren".
 */

/** 600 for "10:00"; NaN for anything that is not a clock time. */
export function minutesOfClock(clock: string): number {
  const match = /^(\d{1,2}):(\d{2})/.exec(clock);
  if (!match) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** "10:00" for 600. */
export function clockOfMinutes(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** The engine's school day, which a row must stand inside (placement-fit.ts insideSchoolDay). */
export const PLACEMENT_DAY_START = 8 * 60;
export const PLACEMENT_DAY_END = 18 * 60;
export const PLACEMENT_GRID_MINUTES = 5;

/**
 * Why the judge refuses a row, in the reader's language. `t` is the
 * requirements.placements translator. A reason this build has no sentence for
 * (the gateway is deployed apart from the web) reads as the general one rather
 * than as nothing, and a value the sentence needs but the gateway left out
 * does the same, because next-intl throws on a hole.
 */
export function verdictSentence(
  t: MessageLookup,
  reason: string | undefined,
  params?: Record<string, string | number>,
): string {
  const key = `verdict.${reason ?? ""}`;
  if (reason && t.has(key)) {
    try {
      return t(key, params ?? {});
    } catch {
      // Falls through to the general sentence.
    }
  }
  return t("verdict.UNKNOWN");
}

/**
 * Why a set of rows does not fit the post (LENGTH, COUNT, WEEKS, PAIRS, BLOCK,
 * and Delade lektioner's per-teacher rules: NO_TEACHER, TEACHER,
 * TEACHER_LENGTH, TEACHER_PAIRS, TEACHER_COUNT), or why a change of the post
 * was refused because its rows no longer do (and POST, a change of group or
 * subject).
 */
export function fitSentence(t: MessageLookup, reason: string): string {
  const key = `problem.${reason}`;
  return t.has(key) ? t(key) : t("problem.UNKNOWN");
}

/**
 * What a refused CHANGE OF A POST'S TEACHER says, when the change was refused
 * because lessons are placed on the post (Förlagda poster): which placement
 * has to be changed or removed first, by its weekday and time, and why. The
 * gateway names the placement and never a person (day, start, end and weeks
 * come with the refusal). Null for any other error, which the caller shows as
 * it shows every other failure. `t` is the requirements.placements translator.
 *
 * The change is the post's teacher or shares written from the timplan page
 * (which words it inline: its bundle has no room for this module), the
 * Tjänstefördelning's panel, suggestions and drawer, and a staffing proposal.
 * A refusal without a placement named (an older gateway) says only that the
 * placed lessons do not fit, with the reason.
 */
export function placementChangeSentence(t: MessageLookup, error: unknown): string | null {
  const refusal = placementsRefusal(error);
  if (refusal?.kind !== "FIT") return null;
  const reason = fitSentence(t, refusal.reason);
  return refusal.params.end ? t("changeFirst", { ...refusal.params, reason }) : t("editRefused", { reason });
}
